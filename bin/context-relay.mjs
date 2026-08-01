#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const STATE_DIRECTORY = ".context-relay";
const CONFIG_FILE = "config.json";
const EVENTS_FILE = "events.jsonl";
const CHECKPOINT_FILE = "checkpoint.json";
const RESUME_FILE = "RESUME.md";
const DEFAULT_MAX_OUTPUT = 16_000;

const EVENT_TYPES = new Set([
  "session-started",
  "session-completed",
  "objective-updated",
  "user-message",
  "assistant-message",
  "decision",
  "constraint",
  "action",
  "finding",
  "failed-attempt",
  "next-step",
  "blocker",
  "blocker-resolved",
  "note",
  "command-started",
  "command-result",
]);

const STATUSES = new Set([
  "info",
  "proposed",
  "applied",
  "verified",
  "failed",
  "blocked",
]);

const SOURCES = new Set(["user", "assistant", "tool", "system"]);

const DEFAULT_STATUS_BY_TYPE = {
  "session-started": "applied",
  "session-completed": "verified",
  "objective-updated": "applied",
  "user-message": "info",
  "assistant-message": "proposed",
  decision: "applied",
  constraint: "applied",
  action: "applied",
  finding: "info",
  "failed-attempt": "failed",
  "next-step": "proposed",
  blocker: "blocked",
  "blocker-resolved": "verified",
  note: "info",
  "command-started": "info",
  "command-result": "verified",
};

const DEFAULT_SOURCE_BY_TYPE = {
  "session-started": "system",
  "session-completed": "system",
  "objective-updated": "user",
  "user-message": "user",
  "assistant-message": "assistant",
  decision: "assistant",
  constraint: "user",
  action: "assistant",
  finding: "assistant",
  "failed-attempt": "assistant",
  "next-step": "assistant",
  blocker: "assistant",
  "blocker-resolved": "assistant",
  note: "assistant",
  "command-started": "tool",
  "command-result": "tool",
};

const SECRET_RULES = [
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
    replacement: "Bearer [REDACTED]",
  },
  {
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g,
    replacement: "[REDACTED_OPENAI_KEY]",
  },
  {
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    pattern:
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|authorization)\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/)([^\s:/]+):([^\s@/]+)@/gi,
    replacement: "$1[REDACTED]:[REDACTED]@",
  },
];

class RelayError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "RelayError";
    this.exitCode = exitCode;
  }
}

function now() {
  return new Date().toISOString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (existsSync(path)) {
    const backup = `${path}.${process.pid}.old`;
    renameSync(path, backup);
    renameSync(temporary, path);
    try {
      rmSync(backup, { force: true });
    } catch {
      // The old file is harmless if a restrictive filesystem prevents cleanup.
    }
  } else {
    renameSync(temporary, path);
  }
}

function truncate(value, maximum = DEFAULT_MAX_OUTPUT) {
  if (typeof value !== "string" || value.length <= maximum) return value;
  const headLength = Math.floor(maximum * 0.65);
  const tailLength = Math.floor(maximum * 0.3);
  const omitted = value.length - headLength - tailLength;
  return `${value.slice(0, headLength)}\n\n[... ${omitted} characters omitted ...]\n\n${value.slice(-tailLength)}`;
}

function redactString(value, customPatterns = []) {
  let redacted = value;
  for (const rule of SECRET_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }
  for (const source of customPatterns) {
    try {
      redacted = redacted.replace(new RegExp(source, "gi"), "[REDACTED_CUSTOM]");
    } catch {
      // Invalid custom patterns are reported by doctor; capture should still work.
    }
  }
  return redacted;
}

function redactValue(value, config = {}) {
  const customPatterns = config.redaction?.customPatterns ?? [];
  const maximum = config.redaction?.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT;
  if (typeof value === "string") {
    return truncate(redactString(value, customPatterns), maximum);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, config));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, config)]),
    );
  }
  return value;
}

function statePath(root, file) {
  return join(root, STATE_DIRECTORY, file);
}

function findStateRoot(start = process.cwd()) {
  let current = resolve(start);
  while (true) {
    if (existsSync(statePath(current, CONFIG_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function requireStateRoot(start = process.cwd()) {
  const root = findStateRoot(start);
  if (!root) {
    throw new RelayError(
      `No Context Relay session found from ${resolve(start)}. Run \"relay init --objective <goal>\" first.`,
      2,
    );
  }
  return root;
}

function loadConfig(root) {
  const path = statePath(root, CONFIG_FILE);
  if (!existsSync(path)) throw new RelayError(`Missing ${path}.`, 2);
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (config.schemaVersion !== SCHEMA_VERSION) {
    throw new RelayError(
      `Unsupported config schema ${config.schemaVersion}; expected ${SCHEMA_VERSION}.`,
      2,
    );
  }
  return config;
}

function saveConfig(root, config) {
  config.updatedAt = now();
  writeJson(statePath(root, CONFIG_FILE), config);
}

function readEvents(root) {
  const path = statePath(root, EVENTS_FILE);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8").trim();
  if (!content) return [];
  return content.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new RelayError(`Invalid JSON in ${EVENTS_FILE} at line ${index + 1}: ${error.message}`);
    }
  });
}

function appendEvent(root, input) {
  const config = loadConfig(root);
  const events = readEvents(root);
  const previous = events.at(-1);
  const type = input.type;
  if (!EVENT_TYPES.has(type)) {
    throw new RelayError(
      `Unknown event type \"${type}\". Valid types: ${[...EVENT_TYPES].join(", ")}`,
      2,
    );
  }
  const status = input.status ?? DEFAULT_STATUS_BY_TYPE[type] ?? "info";
  const source = input.source ?? DEFAULT_SOURCE_BY_TYPE[type] ?? "assistant";
  if (!STATUSES.has(status)) throw new RelayError(`Invalid status \"${status}\".`, 2);
  if (!SOURCES.has(source)) throw new RelayError(`Invalid source \"${source}\".`, 2);

  const eventBody = redactValue(
    {
      schemaVersion: SCHEMA_VERSION,
      id: randomUUID(),
      sessionId: config.sessionId,
      sequence: (previous?.sequence ?? 0) + 1,
      timestamp: now(),
      type,
      source,
      status,
      summary: input.summary,
      ...(input.details ? { details: input.details } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
      previousHash: previous?.hash ?? null,
    },
    config,
  );
  const event = { ...eventBody, hash: sha256(stableStringify(eventBody)) };
  appendFileSync(statePath(root, EVENTS_FILE), `${JSON.stringify(event)}\n`, "utf8");
  config.lastEventAt = event.timestamp;
  config.lastEventHash = event.hash;
  saveConfig(root, config);
  return event;
}

function runGit(root, args, fallback = null) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch {
    return fallback;
  }
}

function parseGitStatus(statusText) {
  return statusText
    ? statusText
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
        .filter((entry) => {
          const normalized = entry.path.replaceAll("\\", "/");
          return normalized !== STATE_DIRECTORY && !normalized.startsWith(`${STATE_DIRECTORY}/`);
        })
    : [];
}

function gitSnapshot(root) {
  if (runGit(root, ["rev-parse", "--is-inside-work-tree"], "false") !== "true") {
    return { available: false, root: resolve(root) };
  }
  const repositoryRoot = runGit(root, ["rev-parse", "--show-toplevel"], resolve(root));
  const head = runGit(root, ["rev-parse", "HEAD"], null);
  const branch = runGit(root, ["branch", "--show-current"], "") || "(detached)";
  const remote = runGit(root, ["remote", "get-url", "origin"], null);
  const statusText = runGit(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "",
  );
  const entries = parseGitStatus(statusText);
  return {
    available: true,
    root: repositoryRoot,
    branch,
    head,
    remote,
    dirty: entries.length > 0,
    changes: entries,
    diffStat: runGit(root, ["diff", "--stat", "HEAD"], ""),
    recentCommits: (runGit(root, ["log", "-5", "--pretty=format:%h %s"], "") || "")
      .split(/\r?\n/)
      .filter(Boolean),
  };
}

function uniqueBySummary(events) {
  const seen = new Set();
  const result = [];
  for (const event of events) {
    const key = `${event.type}\0${event.summary}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(event);
    }
  }
  return result;
}

function buildDerivedState(events) {
  const resolvedBlockers = new Set(
    events
      .filter((event) => event.type === "blocker-resolved")
      .flatMap((event) => event.references ?? []),
  );
  const commands = events.filter((event) => event.type === "command-result");
  return {
    userMessages: events.filter((event) => event.type === "user-message").slice(-20),
    assistantMessages: events
      .filter((event) => event.type === "assistant-message")
      .slice(-20),
    decisions: uniqueBySummary(events.filter((event) => event.type === "decision")),
    constraints: uniqueBySummary(events.filter((event) => event.type === "constraint")),
    verified: uniqueBySummary(
      events.filter(
        (event) =>
          event.status === "verified" &&
          !["command-result", "session-completed", "blocker-resolved"].includes(event.type),
      ),
    ),
    applied: uniqueBySummary(
      events.filter(
        (event) =>
          event.status === "applied" &&
          !["decision", "constraint", "session-started", "objective-updated"].includes(
            event.type,
          ),
      ),
    ),
    findings: uniqueBySummary(events.filter((event) => event.type === "finding")),
    failedAttempts: uniqueBySummary(
      events.filter(
        (event) => event.type === "failed-attempt" || (event.status === "failed" && event.type !== "command-result"),
      ),
    ),
    blockers: events.filter(
      (event) => event.type === "blocker" && !resolvedBlockers.has(event.id),
    ),
    nextSteps: uniqueBySummary(events.filter((event) => event.type === "next-step")).slice(-10),
    notes: events.filter((event) => event.type === "note").slice(-20),
    commands: commands.slice(-20),
  };
}

function createCheckpoint(root) {
  const config = loadConfig(root);
  const events = readEvents(root);
  const workspace = redactValue(gitSnapshot(root), config);
  const checkpoint = {
    schemaVersion: SCHEMA_VERSION,
    kind: "context-relay-checkpoint",
    sessionId: config.sessionId,
    objective: config.objective,
    status: config.status,
    createdAt: config.createdAt,
    checkpointedAt: now(),
    eventLog: {
      count: events.length,
      lastSequence: events.at(-1)?.sequence ?? 0,
      lastHash: events.at(-1)?.hash ?? null,
      fileHash: hashFile(statePath(root, EVENTS_FILE)),
    },
    state: buildDerivedState(events),
    workspace,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      workingDirectory: resolve(root),
    },
  };
  writeJson(statePath(root, CHECKPOINT_FILE), checkpoint);
  writeFileSync(statePath(root, RESUME_FILE), renderResume(checkpoint), "utf8");
  config.lastCheckpointAt = checkpoint.checkpointedAt;
  saveConfig(root, config);
  return checkpoint;
}

function eventLine(event) {
  const suffix = event.details ? ` â€” ${event.details}` : "";
  return `- **${event.status}**: ${event.summary}${suffix}`;
}

function section(title, events, empty = "No entries recorded.") {
  const lines = events?.length ? events.map(eventLine).join("\n") : `- ${empty}`;
  return `## ${title}\n\n${lines}\n`;
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderResume(checkpoint) {
  const state = checkpoint.state;
  const workspace = checkpoint.workspace;
  const workspaceLines = workspace.available
    ? [
        `- Repository: ${workspace.remote ?? workspace.root}`,
        `- Branch: \`${workspace.branch}\``,
        `- HEAD: \`${workspace.head ?? "unborn"}\``,
        `- Dirty: ${workspace.dirty ? "yes" : "no"}`,
        ...(workspace.changes?.length
          ? ["- Changed paths:", ...workspace.changes.map((item) => `  - \`${item.code} ${item.path}\``)]
          : []),
      ]
    : ["- No Git repository detected.", `- Working directory: \`${workspace.root}\``];

  const commandRows = state.commands.length
    ? state.commands
        .map((event) => {
          const result = event.evidence ?? {};
          return `| ${result.exitCode === 0 ? "pass" : "fail"} | \`${escapeCell(result.command)}\` | ${escapeCell(result.exitCode)} | ${escapeCell(result.durationMs)} ms |`;
        })
        .join("\n")
    : "| none | â€” | â€” | â€” |";

  const conversation = [];
  const combined = [...state.userMessages, ...state.assistantMessages]
    .sort((a, b) => a.seã;¶‰žËkºwµçhÍÑ…Ñ•A…Ñ ¡É½½Ð°!-A=%9Q}%1¤°(€€€€€É•ÍÕµ•A…Ñ èÍÑ…Ñ•A…Ñ ¡É½½Ð°IMU5}%1¤°(€€€€€•Ù•¹ÑÍA…Ñ èÍÑ…Ñ•A…Ñ ¡É½½Ð°Y9QM}%1¤°(€€€ôì(€ô(€½¹ÍÐÑ…É•Ð€ôÉ•Í½±Ù”¡Ý°¥¹ÁÕÐ¤ì(€¥˜€ …•á¥ÍÑÍMå¹Œ¡Ñ…É•Ð¤¤Ñ¡É½Ü¹•ÜI•±…åÉÉ½È¡¡•­Á½¥¹ÐÁ…Ñ ‘½•Ì¹½Ð•á¥ÍÐè€‘íÑ…É•Ñõ€°€È¤ì(€¥˜€¡ÍÑ…ÑMå¹Œ¡Ñ…É•Ð¤¹¥Í¥É•Ñ½Éä ¤¤ì(€€€½¹ÍÐ¹•ÍÑ•‘MÑ…Ñ”€ô©½¥¸¡Ñ…É•Ð°MQQ}%IQ=Id¤ì(€€€½¹ÍÐ‰…Í”€ô•á¥ÍÑÍMå¹Œ¡©½¥¸¡Ñ…É•Ð°!-A=%9Q}%1¤¤€üÑ…É•Ð€è¹•ÍÑ•‘MÑ…Ñ”ì(€€€É•ÑÕÉ¸ì(€€€€€¡•­Á½¥¹ÑA…Ñ è©½¥¸¡‰…Í”°!-A=%9Q}%1¤°(€€€€€É•ÍÕµ•A…Ñ è©½¥¸¡‰…Í”°IMU5}%1¤°(€€€€€•Ù•¹ÑÍA…Ñ è©½¥¸¡‰…Í”°Y9QM}%1¤°(€€€ôì(€ô(€¥˜€¡‰…Í•¹…µ”¡Ñ…É•Ð¤€ôôô!-A=%9Q}%1¤ì(€€€É•ÑÕÉ¸ì(€€€€€¡•­Á½¥¹ÑA…Ñ èÑ…É•Ð°(€€€€€É•ÍÕµ•A…Ñ è©½¥¸¡‘¥É¹…µ”¡Ñ…É•Ð¤°IMU5}%1¤°(€€€€€•Ù•¹ÑÍA…Ñ è©½¥¸¡‘¥É¹…µ”¡Ñ…É•Ð¤°Y9QM}%1¤°(€€€ôì(€ô(€¥˜€¡‰…Í•¹…µ”¡Ñ…É•Ð¤€ôôôIMU5}%1¤ì(€€€É•ÑÕÉ¸ì(€€€€€¡•­Á½¥¹ÑA…Ñ è©½¥¸¡‘¥É¹…µ”¡Ñ…É•Ð¤°!-A=%9Q}%1¤°(€€€€€É•ÍÕµ•A…Ñ èÑ…É•Ð°(€€€€€•Ù•¹ÑÍA…Ñ è©½¥¸¡‘¥É¹…µ”¡Ñ…É•Ð¤°Y9QM}%1¤°(€€€ôì(€ô(€Ñ¡É½Ü¹•ÜI•±…åÉÉ½È¡áÁ•Ñ•„‰Õ¹‘±”‘¥É•Ñ½Éä°€‘í!-A=%9Q}%1ô°½È€‘íIMU5}%1ô¹€°€È¤ì)ô()™Õ¹Ñ¥½¸½µÁ…É•]½É­ÍÁ…•M¹…ÁÍ¡½ÑÌ¡Í…Ù•°ÕÉÉ•¹Ð¤ì(€½¹ÍÐÝ…É¹¥¹Ì€ômtì(€½¹ÍÐµ…Ñ¡•Ì€ômtì(€¥˜€ …Í…Ù•¹…Ù…¥±…‰±”€˜˜€…ÕÉÉ•¹Ð¹…Ù…¥±…‰±”¤ì(€€€¥˜€¡É•Í½±Ù”¡Í…Ù•¹É½½Ð¤€ôôôÉ•Í½±Ù”¡ÕÉÉ•¹Ð¹É½½Ð¤¤ì(€€€€€µ…Ñ¡•Ì¹ÁÕÍ  ‰9½¸µ¥ÐÝ½É­¥¹œ‘¥É•Ñ½Éäµ…Ñ¡•Ì•á…Ñ±ä¸ˆ¤ì(€€€ô•±Í”ì(€€€€€Ý…É¹¥¹Ì¹ÁÕÍ  (€€€€€€€9•¥Ñ¡•ÈÝ½É­ÍÁ…”¡…Ì¥Ð•Ù¥‘•¹”…¹Ñ¡•¥ÈÁ…Ñ¡Ì‘¥™™•ÈèÍ…Ù•€‘íÍ…Ù•¹É½½Ñô°ÕÉÉ•¹Ð€‘íÕÉÉ•¹Ð¹É½½Ñô¹€°(€€€€€€¤ì(€€€ô(€ô•±Í”¥˜€ …Í…Ù•¹…Ù…¥±…‰±”¤ì(€€€Ý…É¹¥¹Ì¹ÁÕÍ  ‰Q¡”¡•­Á½¥¹ÐÝ…ÌÉ•…Ñ•½ÕÑÍ¥‘”„¥ÐÉ•Á½Í¥Ñ½Éä¸ˆ¤ì(€ô•±Í”¥˜€ …ÕÉÉ•¹Ð¹…Ù…¥±…‰±”¤ì(€€€Ý…É¹¥¹Ì¹ÁÕÍ  ‰Q¡”ÕÉÉ•¹Ð‘¥É•Ñ½Éä¥Ì¹½Ð„¥ÐÉ•Á½Í¥Ñ½Éä¸ˆ¤ì(€ô•±Í”ì(€€€¥˜€¡Í…Ù•¹¡•…€ôôôÕÉÉ•¹Ð¹¡•…¤µ…Ñ¡•Ì¹ÁÕÍ ¡!µ…Ñ¡•Ì€ ‘íÍ…Ù•¹¡•…€üü€‰Õ¹‰½É¸‰ô¤¹€¤ì(€€€•±Í”Ý…É¹¥¹Ì¹ÁÕÍ ¡!‘É¥™ÐèÍ…Ù•€‘íÍ…Ù•¹¡•…€üü€‰Õ¹‰½É¸‰ô°ÕÉÉ•¹Ð€‘íÕÉÉ•¹Ð¹¡•…€üü€‰Õ¹‰½É¸‰ô¹€¤ì(€€€¥˜€¡Í…Ù•¹‰É…¹ €ôôôÕÉÉ•¹Ð¹‰É…¹ ¤µ…Ñ¡•Ì¹ÁÕÍ ¡	É…¹ µ…Ñ¡•Ì€ ‘íÍ…Ù•¹‰É…¹¡ô¤¹€¤ì(€€€•±Í”Ý…É¹¥¹Ì¹ÁÕÍ ¡	É…¹ ‘É¥™ÐèÍ…Ù•€‘íÍ…Ù•¹‰É…¹¡ô°ÕÉÉ•¹Ð€‘íÕÉÉ•¹Ð¹‰É…¹¡ô¹€¤ì(€€€½¹ÍÐÍ…Ù•‘A…Ñ¡Ì€ô¹•ÜM•Ð ¡Í…Ù•¹¡…¹•Ì€üümt¤¹µ…À ¡¥Ñ•´¤€ôø¥Ñ•´¹Á…Ñ ¤¤ì(€€€½¹ÍÐÕÉÉ•¹ÑA…Ñ¡Ì€ô¹•ÜM•Ð ¡ÕÉÉ•¹Ð¹¡…¹•Ì€üümt¤¹µ…À ¡¥Ñ•´¤€ôø¥Ñ•´¹Á…Ñ ¤¤ì(€€€½¹ÍÐ½¹±åM…Ù•€ôl¸¸¹Í…Ù•‘A…Ñ¡Ít¹™¥±Ñ•È ¡¥Ñ•´¤€ôø€…ÕÉÉ•¹ÑA…Ñ¡Ì¹¡…Ì¡¥Ñ•´¤¤ì(€€€½¹ÍÐ½¹±åÕÉÉ•¹Ð€ôl¸¸¹ÕÉÉ•¹ÑA…Ñ¡Ít¹™¥±Ñ•È ¡¥Ñ•´¤€ôø€…Í…Ù•‘A…Ñ¡Ì¹¡…Ì¡¥Ñ•´¤¤ì(€€€¥˜€ …½¹±åM…Ù•¹±•¹Ñ €˜˜€…½¹±åÕÉÉ•¹Ð¹±•¹Ñ ¤µ…Ñ¡•Ì¹ÁÕÍ  ‰¥ÉÑäÁ…Ñ Í•Ðµ…Ñ¡•Ì¸ˆ¤ì(€€€¥˜€¡½¹±åM…Ù•¹±•¹Ñ ¤Ý…É¹¥¹Ì¹ÁÕÍ ¡M…Ù•‘¥ÉÑäÁ…Ñ¡Ì¹½Üµ¥ÍÍ¥¹œè€‘í½¹±åM…Ù•¹©½¥¸ ˆ°€ˆ¥ô¹€¤ì(€€€¥˜€¡½¹±åÕÉÉ•¹Ð¹±•¹Ñ ¤Ý…É¹¥¹Ì¹ÁÕÍ ¡9•Ü‘¥ÉÑäÁ…Ñ¡Ìè€‘í½¹±åÕÉÉ•¹Ð¹©½¥¸ ˆ°€ˆ¥ô¹€¤ì(€ô(€É•ÑÕÉ¸ì½µÁ…Ñ¥‰±”èÝ…É¹¥¹Ì¹±•¹Ñ €ôôô€À°Ý…É¹¥¹Ì°µ…Ñ¡•Ì°ÕÉÉ•¹Ðôì)ô()™Õ¹Ñ¥½¸½µÁ…É•]½É­ÍÁ…”¡¡•­Á½¥¹Ð°ÕÉÉ•¹ÑI½½Ð¤ì(€É•ÑÕÉ¸½µÁ…É•]½É­ÍÁ…•M¹…ÁÍ¡½ÑÌ¡¡•­Á½¥¹Ð¹Ý½É­ÍÁ…”°¥ÑM¹…ÁÍ¡½Ð¡ÕÉÉ•¹ÑI½½Ð¤¤ì)ô()™Õ¹Ñ¥½¸¥¹ÍÁ•ÑI•ÍÕµ”¡¥¹ÁÕÐ°Ý¤ì(€½¹ÍÐÁ…Ñ¡Ì€ôÉ•Í½±Ù•¡•­Á½¥¹Ñ%¹ÁÕÐ¡¥¹ÁÕÐ°Ý¤ì(€™½È€¡½¹ÍÐÉ•ÅÕ¥É•½˜mÁ…Ñ¡Ì¹¡•­Á½¥¹ÑA…Ñ °Á…Ñ¡Ì¹É•ÍÕµ•A…Ñ¡t¤ì(€€€¥˜€ …•á¥ÍÑÍMå¹Œ¡É•ÅÕ¥É•¤¤Ñ¡É½Ü¹•ÜI•±…åÉÉ½È¡5¥ÍÍ¥¹œ¡…¹‘½™˜™¥±”è€‘íÉ•ÅÕ¥É•‘õ€°€È¤ì(€ô(€½¹ÍÐ¡•­Á½¥¹Ð€ô)M=8¹Á…ÉÍ”¡É•…‘¥±•Må¹Œ¡Á…Ñ¡Ì¹¡•­Á½¥¹ÑA…Ñ °€‰ÕÑ˜àˆ¤¤ì(€½¹ÍÐÉ•ÍÕµ”€ôÉ•…‘¥±•Må¹Œ¡Á…Ñ¡Ì¹É•ÍÕµ•A…Ñ °€‰ÕÑ˜àˆ¤ì(€½¹ÍÐ‘É¥™Ð€ô½µÁ…É•]½É­ÍÁ…”¡¡•­Á½¥¹Ð°Ý¤ì(€É•ÑÕÉ¸ì¡•­Á½¥¹Ð°É•ÍÕµ”°‘É¥™Ð°Á…Ñ¡Ìôì)ô()™Õ¹Ñ¥½¸ÉÕ¹½Ñ½È¡¥¹ÁÕÐ°Ý¤ì(€½¹ÍÐÁ…Ñ¡Ì€ôÉ•Í½±Ù•¡•­Á½¥¹Ñ%¹ÁÕÐ¡¥¹ÁÕÐ°Ý¤ì(€½¹ÍÐ•ÉÉ½ÉÌ€ômtì(€½¹ÍÐÝ…É¹¥¹Ì€ômtì(€¥˜€ …•á¥ÍÑÍMå¹Œ¡Á…Ñ¡Ì¹•Ù•¹ÑÍA…Ñ ¤¤•ÉÉ½ÉÌ¹ÁÕÍ ¡5¥ÍÍ¥¹œ€‘íÁ…Ñ¡Ì¹•Ù•¹ÑÍA…Ñ¡ô¹€¤ì(€¥˜€ …•á¥ÍÑÍMå¹Œ¡Á…Ñ¡Ì¹¡•­Á½¥¹ÑA…Ñ ¤¤•ÉÉ½ÉÌ¹ÁÕÍ ¡5¥ÍÍ¥¹œ€‘íÁ…Ñ¡Ì¹¡•­Á½¥¹ÑA…Ñ¡ô¹€¤ì(€¥˜€ …•á¥ÍÑÍMå¹Œ¡Á…Ñ¡Ì¹É•ÍÕµ•A…Ñ ¤¤•ÉÉ½ÉÌ¹ÁÕÍ ¡5¥ÍÍ¥¹œ€‘íÁ…Ñ¡Ì¹É•ÍÕµ•A…Ñ¡ô¹€¤ì(€±•Ð•Ù•¹ÑÌ€ômtì(€±•Ð¡•­Á½¥¹Ð€ô¹Õ±°ì(€¥˜€ …•ÉÉ½ÉÌ¹±•¹Ñ ¤ì(€€€½¹ÍÐ½¹Ñ•¹Ð€ôÉ•…‘¥±•Må¹Œ¡Á…Ñ¡Ì¹•Ù•¹ÑÍA…Ñ °€‰ÕÑ˜àˆ¤¹ÑÉ¥´ ¤ì(€€€ÑÉäì(€€€€€•Ù•¹ÑÌ€ô½¹Ñ•¹Ð€ü½¹Ñ•¹Ð¹ÍÁ±¥Ð ½qÈýq¸¼¤¹µ…À ¡±¥¹”¤€ôø)M=8¹Á…ÉÍ”¡±¥¹”¤¤€èmtì(€€€€€•ÉÉ½ÉÌ¹ÁÕÍ  ¸¸¹Ù…±¥‘…Ñ•Ù•¹Ñ¡…¥¸¡•Ù•¹ÑÌ¤¤ì(€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€•ÉÉ½ÉÌ¹ÁÕÍ ¡…¹¹½ÐÁ…ÉÍ”•Ù•¹ÑÌè€‘í•ÉÉ½È¹µ•ÍÍ…•õ€¤ì(€€€ô(€€€ÑÉäì(€€€€€¡•­Á½¥¹Ð€ô)M=8¹Á…ÉÍ”¡É•…‘¥±•Må¹Œ¡Á…Ñ¡Ì¹¡•­Á½¥¹ÑA…Ñ °€‰ÕÑ˜àˆ¤¤ì(€€€€€¥˜€¡¡•­Á½¥¹Ð¹•Ù•¹Ñ1½œü¹½Õ¹Ð€„ôô•Ù•¹ÑÌ¹±•¹Ñ ¤ì(€€€€€€€•ÉÉ½ÉÌ¹ÁÕÍ  (€€€€€€€€€¡•­Á½¥¹Ð•áÁ•ÑÌ€‘í¡•­Á½¥¹Ð¹•Ù•¹Ñ1½œü¹½Õ¹Ñô•Ù•¹ÑÌ‰ÕÐ€‘í•Ù•¹ÑÌ¹±•¹Ñ¡ôÝ•É”™½Õ¹¹€°(€€€€€€€€¤ì(€€€€€ô(€€€€€¥˜€¡¡•­Á½¥¹Ð¹•Ù•¹Ñ1½œü¹±…ÍÑ!…Í €„ôô•Ù•¹ÑÌ¹…Ð ´Ä¤ü¹¡…Í ¤ì(€€€€€€€•ÉÉ½ÉÌ¹ÁÕÍ  ‰¡•­Á½¥¹Ð±…ÍÐ•Ù•¹Ð¡…Í ‘½•Ì¹½Ðµ…Ñ Ñ¡”•Ù•¹Ð±½œ¸ˆ¤ì(€€€€€ô(€€€€€¥˜€¡¡•­Á½¥¹Ð¹•Ù•¹Ñ1½œü¹™¥±•!…Í €„ôô¡…Í¡¥±”¡Á…Ñ¡Ì¹•Ù•¹ÑÍA…Ñ ¤¤ì(€€€€€€€•ÉÉ½ÉÌ¹ÁÕÍ  ‰¡•­Á½¥¹Ð•Ù•¹Ð±½œ™¥±”¡…Í ‘½•Ì¹½Ðµ…Ñ ¸ˆ¤ì(€€€€€ô(€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€•ÉÉ½ÉÌ¹ÁÕÍ ¡…¹¹½ÐÁ…ÉÍ”¡•­Á½¥¹Ðè€‘í•ÉÉ½È¹µ•ÍÍ…•õ€¤ì(€€€ô(€ô(€½¹ÍÐ‰Õ¹‘±•5…¹¥™•ÍÐ€ô©½¥¸¡‘¥É¹…µ”¡Á…Ñ¡Ì¹¡•­Á½¥¹ÑA…Ñ ¤°€‰‰Õ¹‘±”¹©Í½¸ˆ¤ì(€¥˜€¡•á¥ÍÑÍMå¹Œ¡‰Õ¹‘±•5…¹¥™•ÍÐ¤¤ì(€€€ÑÉäì(€€€€€½¹ÍÐµ…¹¥™•ÍÐ€ô)M=8¹Á…ÉÍ”¡É•…‘¥±•Må¹Œ¡‰Õ¹‘±•5…¹¥™•ÍÐ°€‰ÕÑ˜àˆ¤¤ì(€€€€€™½È€¡½¹ÍÐm™¥±”°•áÁ•Ñ•‘!…Í¡t½˜=‰©•Ð¹•¹ÑÉ¥•Ì¡µ…¹¥™•ÍÐ¹™¥±•Ì€üüíô¤¤ì(€€€€€€€½¹ÍÐ™¥±•A…Ñ €ô©½¥¸¡‘¥É¹…µ”¡Á…Ñ¡Ì¹¡•­Á½¥¹ÑA…Ñ ¤°™¥±”¤ì(€€€€€€€¥˜€ …•á¥ÍÑÍMå¹Œ¡™¥±•A…Ñ ¤¤•ÉÉ½ÉÌ¹ÁÕÍ ¡	Õ¹‘±”™¥±”µ¥ÍÍ¥¹œè€‘í™¥±•ô¹€¤ì(€€€€€€€•±Í”¥˜€¡¡…Í¡¥±”¡™¥±•A…Ñ ¤€„ôô•áÁ•Ñ•‘!…Í ¤•ÉÉ½ÉÌ¹ÁÕÍ ¡	Õ¹‘±”™¥±”¡…Í µ¥Íµ…Ñ è€‘í™¥±•ô¹€¤ì(€€€€€ô(€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€•ÉÉ½ÉÌ¹ÁÕÍ ¡…¹¹½ÐÙ…±¥‘…Ñ”‰Õ¹‘±”¹©Í½¸è€‘í•ÉÉ½È¹µ•ÍÍ…•õ€¤ì(€€€ô(€ô(€¥˜€¡¡•­Á½¥¹Ðü¹Í¡•µ…Y•ÉÍ¥½¸€„ôôM!5}YIM%=8¤ì(€€€•ÉÉ½ÉÌ¹ÁÕÍ ¡U¹ÍÕÁÁ½ÉÑ•¡•­Á½¥¹ÐÍ¡•µ„€‘í¡•­Á½¥¹Ðü¹Í¡•µ…Y•ÉÍ¥½¹ô¹€¤ì(€ô(€É•ÑÕÉ¸ì½¬è•ÉÉ½ÉÌ¹±•¹Ñ €ôôô€À°•ÉÉ½ÉÌ°Ý…É¹¥¹Ì°•Ù•¹Ñ½Õ¹Ðè•Ù•¹ÑÌ¹±•¹Ñ ôì)ô()™Õ¹Ñ¥½¸ÁÉ¥¹ÑMÑ…ÑÕÌ¡¡•­Á½¥¹Ð¤ì(€½¹ÍÐÍÑ…Ñ”€ô¡•­Á½¥¹Ð¹ÍÑ…Ñ”ì(€½¹Í½±”¹±½œ¡M•ÍÍ¥½¸è€€€‘í¡•­Á½¥¹Ð¹Í•ÍÍ¥½¹%‘õ€¤ì(€½¹Í½±”¹±½œ¡MÑ…ÑÕÌè€€€€‘í¡•­Á½¥¹Ð¹ÍÑ…ÑÕÍõ€¤ì(€½¹Í½±”¹±½œ¡=‰©•Ñ¥Ù”è€‘í¡•­Á½¥¹Ð¹½‰©•Ñ¥Ù•õ€¤ì(€½¹Í½±”¹±½œ¡Ù•¹ÑÌè€€€€‘í¡•­Á½¥¹Ð¹•Ù•¹Ñ1½œ¹½Õ¹Ñõ€¤ì(€½¹Í½±”¹±½œ¡Y•É¥™¥•è€€‘íÍÑ…Ñ”¹Ù•É¥™¥•¹±•¹Ñ¡õ€¤ì(€½¹Í½±”¹±½œ¡ÁÁ±¥•è€€€‘íÍÑ…Ñ”¹…ÁÁ±¥•¹±•¹Ñ¡õ€¤ì(€½¹Í½±”¹±½œ¡…¥±•è€€€€‘íÍÑ…Ñ”¹™…¥±•‘ÑÑ•µÁÑÌ¹±•¹Ñ¡õ€¤ì(€½¹Í½±”¹±½œ¡	±½­•ÉÌè€€‘íÍÑ…Ñ”¹‰±½­•ÉÌ¹±•¹Ñ¡õ€¤ì(€¥˜€¡ÍÑ…Ñ”¹¹•áÑMÑ•ÁÌ¹±•¹Ñ ¤ì(€€€½¹Í½±”¹±½œ ‰9•áÐèˆ¤ì(€€€ÍÑ…Ñ”¹¹•áÑMÑ•ÁÌ¹™½É…  ¡•Ù•¹Ð¤€ôø½¹Í½±”¹±½œ¡€€€´€‘í•Ù•¹Ð¹ÍÕµµ…Éåõ€¤¤ì(€ô)ô()™Õ¹Ñ¥½¸¡•±À ¤ì(€É•ÑÕÉ¸½¹Ñ•áÐI•±…ä€À¸Ä¸ÀƒŠPÁ½ÉÑ…‰±”¡•­Á½¥¹ÑÌ™½È$µ…ÍÍ¥ÍÑ•Ý½É¬()UÍ…”è(€É•±…ä¥¹¥Ð€´µ½‰©•Ñ¥Ù”€ñ½…°øl´µ¥Ñ¥¹½É•t(€É•±…ä¹•Ü€ñ½…°ø(€É•±…äÑÕÉ¸€´µÕÍ•È€ñÍÕµµ…Éäøl´µ…ÍÍ¥ÍÑ…¹Ð€ñÍÕµµ…Éäùt(€É•±…ä…‘€ñÑåÁ”ø€ñÍÕµµ…Éäøl´µÍÑ…ÑÕÌ€ñÍÑ…ÑÕÌùtl´µÍ½ÕÉ”€ñÍ½ÕÉ”ùt(€É•±…ä‘•¥Í¥½¸€ñÍÕµµ…Éäø€€€€€€É•±…ä½¹ÍÑÉ…¥¹Ð€ñÍÕµµ…Éäø(€É•±…ä‘½¹”€ñÍÕµµ…Éäø€€€€€€€€€€É•±…ä…ÑÑ•µÁÐ€ñÍÕµµ…Éäø(€É•±…ä¹•áÐ€ñÍÕµµ…Éäø€€€€€€€€€€É•±…ä‰±½­•È€ñÍÕµµ…Éäø(€É•±…äÉ•Í½±Ù”€ñ‰±½­•Èµ¥ømÍÕµµ…Éåt(€É•±…ä¹½Ñ”€ñÍÕµµ…Éäø(€É•±…äÉÕ¸€´´€ñ½µµ…¹øm…ÉÕµ•¹ÑÌ¸¸¹t(€É•±…ä¡•­Á½¥¹Ð(€É•±…äÍÑ…ÑÕÌl´µ©Í½¹t(€É•±…ä•áÁ½ÉÐl´µ½ÕÑÁÕÐ€ñ‘¥Èùtl´µ¥¹±Õ‘”µÁ…Ñ¡t(€É•±…äÉ•ÍÕµ”m‰Õ¹‘±”µ½Èµ¡•­Á½¥¹Ñtl´µ©Í½¹t(€É•±…ä‘½Ñ½Èm‰Õ¹‘±”µ½Èµ¡•­Á½¥¹Ñtl´µ©Í½¹t(€É•±…ä½‰©•Ñ¥Ù”€ñ¹•Ü½…°ø(€É•±…ä½µÁ±•Ñ”mÍÕµµ…Éåt()Ù•¹ÐÑåÁ•Ìè(€€‘íl¸¸¹Y9Q}QeAMt¹©½¥¸ ˆ°€ˆ¥ô()MÑ…ÑÕÍ•Ìè€‘íl¸¸¹MQQUMMt¹©½¥¸ ˆ°€ˆ¥ô)M½ÕÉ•Ìè€€‘íl¸¸¹M=UIMt¹©½¥¸ ˆ°€ˆ¥ô()±°ÍÑ…Ñ”¥ÌÍÑ½É•¥¸€‘íMQQ}%IQ=Ieô¼¸Y…±Õ•ÌÉ•Í•µ‰±¥¹œÍ•É•ÑÌ…É”É•‘…Ñ•‰•™½É”ÝÉ¥Ñ”¸)€ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸µ…¥¸¡…ÉØ€ôÁÉ½•ÍÌ¹…ÉØ¹Í±¥” È¤¤ì(€½¹ÍÐ½µµ…¹€ô…ÉÙlÁtì(€½¹ÍÐÁ…ÉÍ•€ôÁ…ÉÍ•ÉÕµ•¹ÑÌ¡…ÉØ¹Í±¥” Ä¤¤ì(€¥˜€ …½µµ…¹ñð½µµ…¹€ôôô€‰¡•±Àˆñð½µµ…¹€ôôô€ˆ´µ¡•±ÀˆñðÁ…ÉÍ•¹½ÁÑ¥½¹Ì¹¡•±À¤ì(€€€½¹Í½±”¹±½œ¡¡•±À ¤¤ì(€€€É•ÑÕÉ¸€Àì(€ô((€½¹ÍÐÉ•ÅÕ•ÍÑ•‘Ý€ôÉ•Í½±Ù”¡MÑÉ¥¹œ¡Á…ÉÍ•¹½ÁÑ¥½¹Ì¹Ý€üüÁÉ½•ÍÌ¹Ý ¤¤¤ì(€¥˜€¡½µµ…¹€ôôô€‰¥¹¥Ðˆ¤ì(€€€½¹ÍÐ½‰©•Ñ¥Ù”€ô(€€€€€½ÁÑ¥½¹Q•áÐ¡Á…ÉÍ•°€‰½‰©•Ñ¥Ù”ˆ°€‰½‰©•Ñ¥Ù”µ™¥±”ˆ¤€üüÁ…ÉÍ•¹Á½Í¥Ñ¥½¹…±Ì¹©½¥¸ ˆ€ˆ¤ì(€€€¥˜€ …½‰©•Ñ¥Ù”¤Ñ¡É½Ü¹•ÜI•±…åÉÉ½È ‰UÍ…”èÉ•±…ä¥¹¥Ð€´µ½‰©•Ñ¥Ù”€ñ½…°øˆ°€È¤ì(€€€½¹ÍÐ¡•­Á½¥¹Ð€ô¥¹¥Ñ¥…±¥é”¡É•ÅÕ•ÍÑ•‘Ý°½‰©•Ñ¥Ù”°ì(€€€€€…‘‘¥Ñ%¹½É”è	½½±•…¸¡Á…ÉÍ•¹½ÁÑ¥½¹Ì¹¥Ñ¥¹½É”¤°(€€€ô¤ì(€€€½¹Í½±”¹±½œ¡%¹¥Ñ¥…±¥é•½¹Ñ•áÐI•±…äÍ•ÍÍ¥½¸€‘í¡•­Á½¥¹Ð¹Í•ÍÍ¥½¹%‘ô¹€¤ì(€€€½¹Í½±”¹±½œ¡ÍÑ…Ñ•A…Ñ ¡É•ÅÕ•ÍÑ•‘Ý°IMU5}%1¤¤ì(€€€É•ÑÕÉ¸€Àì(€ô((€½¹ÍÐÉ½½Ð€ôl‰É•ÍÕµ”ˆ°€‰‘½Ñ½È‰t¹¥¹±Õ‘•Ì¡½µµ…¹¤(€€€€ü™¥¹‘MÑ…Ñ•I½½Ð¡É•ÅÕ•ÍÑ•‘Ý¤€üüÉ•ÅÕ•ÍÑ•‘Ý(€€€€èÉ•ÅÕ¥É•MÑ…Ñ•I½½Ð¡É•ÅÕ•ÍÑ•‘Ý¤ì(€ÍÝ¥Ñ €¡½µµ…¹¤ì(€€€…Í”€‰¹•Üˆèì(€€€€€½¹ÍÐ½‰©•Ñ¥Ù”€ô(€€€€€€€½ÁÑ¥½¹Q•áÐ¡Á…ÉÍ•°€‰½‰©•Ñ¥Ù”ˆ°€‰½‰©•Ñ¥Ù”µ™¥±”ˆ¤€üüÁ…ÉÍ•¹Á½Í¥Ñ¥½¹…±Ì¹©½¥¸ ˆ€ˆ¤ì(€€€€€¥˜€ …½‰©•Ñ¥Ù”¤Ñ¡É½Ü¹•ÜI•±…åÉÉ½È ‰UÍ…”èÉ•±…ä¹•Ü€ñ½‰©•Ñ¥Ù”øˆ°€È¤ì(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ôÍÑ…ÉÑ9•ÝM•ÍÍ¥½¸¡É½½Ð°½‰©•Ñ¥Ù”¤ì(€€€€€½¹Í½±”¹±½œ¡É¡¥Ù•ÁÉ•Ù¥½ÕÌÍ•ÍÍ¥½¸…Ð€‘íÉ•ÍÕ±Ð¹…É¡¥Ù•ô¹€¤ì(€€€€€½¹Í½±”¹±½œ¡MÑ…ÉÑ•Í•ÍÍ¥½¸€‘íÉ•ÍÕ±Ð¹¡•­Á½¥¹Ð¹Í•ÍÍ¥½¹%‘ô¹€¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€ô(€€€…Í”€‰ÑÕÉ¸ˆèì(€€€€€½¹ÍÐ•Ù•¹ÑÌ€ô…ÁÑÕÉ•QÕÉ¸¡É½½Ð°Á…ÉÍ•¤ì(€€€€€½¹Í½±”¹±½œ¡I•½É‘•€‘í•Ù•¹ÑÌ¹±•¹Ñ¡ô½¹Ù•ÉÍ…Ñ¥½¸•Ù•¹Ð¡Ì¤¹€¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€ô(€€€…Í”€‰…‘ˆèì(€€€€€½¹ÍÐ•Ù•¹Ð€ôÉ•½É‘Ù•¹Ñ½µµ…¹¡É½½Ð°Á…ÉÍ•¤ì(€€€€€½¹Í½±”¹±½œ¡I•½É‘•€‘í•Ù•¹Ð¹ÑåÁ•ô€‘í•Ù•¹Ð¹¥‘ô¹€¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€ô(€€€…Í”€‰‘•¥Í¥½¸ˆè(€€€€€½¹Í½±”¹±½œ (€€€€€€€I•½É‘•‘•¥Í¥½¸€‘íÉ•½É‘M¡½ÉÑÕÐ¡É½½Ð°€‰‘•¥Í¥½¸ˆ°€‰…ÁÁ±¥•ˆ°€‰…ÍÍ¥ÍÑ…¹Ðˆ°Á…ÉÍ•¤¹¥‘ô¹€°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€…Í”€‰½¹ÍÑÉ…¥¹Ðˆè(€€€€€½¹Í½±”¹±½œ (€€€€€€€I•½É‘•½¹ÍÑÉ…¥¹Ð€‘íÉ•½É‘M¡½ÉÑÕÐ¡É½½Ð°€‰½¹ÍÑÉ…¥¹Ðˆ°€‰…ÁÁ±¥•ˆ°€‰ÕÍ•Èˆ°Á…ÉÍ•¤¹¥‘ô¹€°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€…Í”€‰‘½¹”ˆè(€€€€€½¹Í½±”¹±½œ (€€€€€€€I•½É‘•Ù•É¥™¥•Ý½É¬€‘íÉ•½É‘M¡½ÉÑÕÐ¡É½½Ð°€‰…Ñ¥½¸ˆ°€‰Ù•É¥™¥•ˆ°€‰…ÍÍ¥ÍÑ…¹Ðˆ°Á…ÉÍ•¤¹¥‘ô¹€°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€…Í”€‰…ÑÑ•µÁÐˆè(€€€€€½¹Í½±”¹±½œ (€€€€€€€I•½É‘•™…¥±•…ÑÑ•µÁÐ€‘íÉ•½É‘M¡½ÉÑÕÐ¡É½½Ð°€‰™…¥±•µ…ÑÑ•µÁÐˆ°€‰™…¥±•ˆ°€‰…ÍÍ¥ÍÑ…¹Ðˆ°Á…ÉÍ•¤¹¥‘ô¹€°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€…Í”€‰¹•áÐˆè(€€€€€½¹Í½±”¹±½œ (€€€€€€€I•½É‘•¹•áÐÍÑ•À€‘íÉ•½É‘M¡½ÉÑÕÐ¡É½½Ð°€‰¹•áÐµÍÑ•Àˆ°€‰ÁÉ½Á½Í•ˆ°€‰…ÍÍ¥ÍÑ…¹Ðˆ°Á…ÉÍ•¤¹¥‘ô¹€°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€…Í”€‰‰±½­•Èˆè(€€€€€½¹Í½±”¹±½œ (€€€€€€€I•½É‘•‰±½­•È€‘íÉ•½É‘M¡½ÉÑÕÐ¡É½½Ð°€‰‰±½­•Èˆ°€‰‰±½­•ˆ°€‰…ÍÍ¥ÍÑ…¹Ðˆ°Á…ÉÍ•¤¹¥‘ô¹€°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€…Í”€‰É•Í½±Ù”ˆèì(€€€€€½¹ÍÐmÉ•™•É•¹”°€¸¸¹ÍÕµµ…Éåt€ôÁ…ÉÍ•¹Á½Í¥Ñ¥½¹…±Ìì(€€€€€¥˜€ …É•™•É•¹”¤Ñ¡É½Ü¹•ÜI•±…åÉÉ½È ‰UÍ…”èÉ•±…äÉ•Í½±Ù”€ñ‰±½­•Èµ¥ømÍÕµµ…Éåtˆ°€È¤ì(€€€€€½¹ÍÐ•Ù•¹Ð€ô…ÁÁ•¹‘Ù•¹Ð¡É½½Ð°ì(€€€€€€€ÑåÁ”è€‰‰±½­•ÈµÉ•Í½±Ù•ˆ°(€€€€€€€ÍÕµµ…ÉäèÍÕµµ…Éä¹©½¥¸ ˆ€ˆ¤ñðI•Í½±Ù•‰±½­•È€‘íÉ•™•É•¹•õ€°(€€€€€€€Í½ÕÉ”èÁ…ÉÍ•¹½ÁÑ¥½¹Ì¹Í½ÕÉ”€üü€‰…ÍÍ¥ÍÑ…¹Ðˆ°(€€€€€€€ÍÑ…ÑÕÌè€‰Ù•É¥™¥•ˆ°(€€€€€€€É•™•É•¹•ÌèmÉ•™•É•¹•t°(€€€€€ô¤ì(€€€€€É•…Ñ•¡•­Á½¥¹Ð¡É½½Ð¤ì(€€€€€½¹Í½±”¹±½œ¡I•½É‘•‰±½­•ÈÉ•Í½±ÕÑ¥½¸€‘í•Ù•¹Ð¹¥‘ô¹€¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€ô(€€€…Í”€‰¹½Ñ”ˆè(€€€€€½¹Í½±”¹±½œ (€€€€€€€I•½É‘•¹½Ñ”€‘íÉ•½É‘M¡½ÉÑÕÐ¡É½½Ð°€‰¹½Ñ”ˆ°€‰¥¹™¼ˆ°€‰…ÍÍ¥ÍÑ…¹Ðˆ°Á…ÉÍ•¤¹¥‘ô¹€°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€…Í”€‰ÉÕ¸ˆè(€€€€€É•ÑÕÉ¸ÉÕ¹I•½É‘•‘½µµ…¹¡É½½Ð°Á…ÉÍ•¤ì(€€€…Í”€‰¡•­Á½¥¹Ðˆèì(€€€€€½¹ÍÐ¡•­Á½¥¹Ð€ôÉ•…Ñ•¡•­Á½¥¹Ð¡É½½Ð¤ì(€€€€€½¹Í½±”¹±½œ¡¡•­Á½¥¹Ñ•€‘í¡•­Á½¥¹Ð¹•Ù•¹Ñ1½œ¹½Õ¹Ñô•Ù•¹ÑÌ¹€¤ì(€€€€€½¹Í½±”¹±½œ¡ÍÑ…Ñ•A…Ñ ¡É½½Ð°IMU5}%1¤¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€ô(€€€…Í”€‰ÍÑ…ÑÕÌˆèì(€€€€€½¹ÍÐ¡•­Á½¥¹Ð€ôÉ•…Ñ•¡•­Á½¥¹Ð¡É½½Ð¤ì(€€€€€¥˜€¡Á…ÉÍ•¹½ÁÑ¥½¹Ì¹©Í½¸¤½¹Í½±”¹±½œ¡)M=8¹ÍÑÉ¥¹¥™ä¡¡•­Á½¥¹Ð°¹Õ±°°€È¤¤ì(€€€€€•±Í”ÁÉ¥¹ÑMÑ…ÑÕÌ¡¡•­Á½¥¹Ð¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€ô(€€€…Í”€‰•áÁ½ÉÐˆèì(€€€€€½¹ÍÐ½ÕÑÁÕÐ€ôÉ•…Ñ•	Õ¹‘±”¡É½½Ð°Á…ÉÍ•¤ì(€€€€€½¹Í½±”¹±½œ¡É•…Ñ•¡…¹‘½™˜‰Õ¹‘±”è€‘í½ÕÑÁÕÑõ€¤ì(€€€€€¥˜€¡Á…ÉÍ•¹½ÁÑ¥½¹Íl‰¥¹±Õ‘”µÁ…Ñ ‰t¤ì(€€€€€€€½¹Í½±”¹±½œ ‰I•Ù¥•ÜÝ½É­ÍÁ…”¹Á…Ñ ™½ÈÍ•¹Í¥Ñ¥Ù”Í½ÕÉ”‰•™½É”Í¡…É¥¹œ¸ˆ¤ì(€€€€€ô(€€€€€É•ÑÕÉ¸€Àì(€€€ô(€€€…Í”€‰É•ÍÕµ”ˆèì(€€€€€½¹ÍÐ¥¹ÁÕÐ€ôÁ…ÉÍ•¹Á½Í¥Ñ¥½¹…±ÍlÁt€üü¹Õ±°ì(€€€€€½¹ÍÐ¥¹ÍÁ•Ñ¥½¸€ô¥¹ÍÁ•ÑI•ÍÕµ”¡¥¹ÁÕÐ°É•ÅÕ•ÍÑ•‘Ý¤ì(€€€€€¥˜€¡Á…ÉÍ•¹½ÁÑ¥½¹Ì¹©Í½¸¤ì(€€€€€€€½¹Í½±”¹±½œ (€€€€€€€€€)M=8¹ÍÑÉ¥¹¥™ä (€€€€€€€€€€€ì¡•­Á½¥¹Ðè¥¹ÍÁ•Ñ¥½¸¹¡•­Á½¥¹Ð°‘É¥™Ðè¥¹ÍÁ•Ñ¥½¸¹‘É¥™Ðô°(€€€€€€€€€€€¹Õ±°°(€€€€€€€€€€€€È°(€€€€€€€€€€¤°(€€€€€€€€¤ì(€€€€€ô•±Í”ì(€€€€€€€½¹Í½±”¹±½œ¡¥¹ÍÁ•Ñ¥½¸¹É•ÍÕµ”¹ÑÉ¥µ¹ ¤¤ì(€€€€€€€½¹Í½±”¹±½œ ‰q¸´´´]½É­ÍÁ…”½µÁ…Ñ¥‰¥±¥Ñä€´´µq¸ˆ¤ì(€€€€€€€¥¹ÍÁ•Ñ¥½¸¹‘É¥™Ð¹µ…Ñ¡•Ì¹™½É…  ¡µ•ÍÍ…”¤€ôø½¹Í½±”¹±½œ¡AMLè€‘íµ•ÍÍ…•õ€¤¤ì(€€€€€€€¥¹ÍÁ•Ñ¥½¸¹‘É¥™Ð¹Ý…É¹¥¹Ì¹™½É…  ¡µ•ÍÍ…”¤€ôø½¹Í½±”¹±½œ¡]I8è€‘íµ•ÍÍ…•õ€¤¤ì(€€€€€ô(€€€€€É•ÑÕÉ¸¥¹ÍÁ•Ñ¥½¸¹‘É¥™Ð¹½µÁ…Ñ¥‰±”€ü€À€è€Ìì(€€€ô(€€€…Í”€‰‘½Ñ½Èˆèì(€€€€€½¹ÍÐ¥¹ÁÕÐ€ôÁ…ÉÍ•¹Á½Í¥Ñ¥½¹…±ÍlÁt€üü¹Õ±°ì(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ôÉÕ¹½Ñ½È¡¥¹ÁÕÐ°É•ÅÕ•ÍÑ•‘Ý¤ì(€€€€€¥˜€¡Á…ÉÍ•¹½ÁÑ¥½¹Ì¹©Í½¸¤½¹Í½±”¹±½œ¡)M=8¹ÍÑÉ¥¹¥™ä¡É•ÍÕ±Ð°¹Õ±°°€È¤¤ì(€€€€€•±Í”ì(€€€€€€€½¹Í½±”¹±½œ¡É•ÍÕ±Ð¹½¬€ü€‰½¹Ñ•áÐI•±…äÍÑ…Ñ”¥ÌÙ…±¥¸ˆ€è€‰½¹Ñ•áÐI•±…äÍÑ…Ñ”¥Ì¥¹Ù…±¥¸ˆ¤ì(€€€€€€€½¹Í½±”¹±½œ¡Ù•¹ÑÌ¡•­•è€‘íÉ•ÍÕ±Ð¹•Ù•¹Ñ½Õ¹Ñõ€¤ì(€€€€€€€É•ÍÕ±Ð¹Ý…É¹¥¹Ì¹™½É…  ¡µ•ÍÍ…”¤€ôø½¹Í½±”¹±½œ¡]I8è€‘íµ•ÍÍ…•õ€¤¤ì(€€€€€€€É•ÍÕ±Ð¹•ÉÉ½ÉÌ¹™½É…  ¡µ•ÍÍ…”¤€ôø½¹Í½±”¹•ÉÉ½È¡II=Hè€‘íµ•ÍÍ…•õ€¤¤ì(€€€€€ô(€€€€€É•ÑÕÉ¸É•ÍÕ±Ð¹½¬€ü€À€è€Ðì(€€€ô(€€€…Í”€‰½‰©•Ñ¥Ù”ˆèì(€€€€€½¹ÍÐ½‰©•Ñ¥Ù”€ô(€€€€€€€½ÁÑ¥½¹Q•áÐ¡Á…ÉÍ•°€‰½‰©•Ñ¥Ù”ˆ°€‰½‰©•Ñ¥Ù”µ™¥±”ˆ¤€üüÁ…ÉÍ•¹Á½Í¥Ñ¥½¹…±Ì¹©½¥¸ ˆ€ˆ¤ì(€€€€€¥˜€ …½‰©•Ñ¥Ù”¤Ñ¡É½Ü¹•ÜI•±…åÉÉ½È ‰UÍ…”èÉ•±…ä½‰©•Ñ¥Ù”€ñ¹•Ü½…°øˆ°€È¤ì(€€€€€½¹ÍÐ½¹™¥œ€ô±½…‘½¹™¥œ¡É½½Ð¤ì(€€€€€½¹™¥œ¹½‰©•Ñ¥Ù”€ôÉ•‘…ÑY…±Õ”¡½‰©•Ñ¥Ù”°½¹™¥œ¤ì(€€€€€Í…Ù•½¹™¥œ¡É½½Ð°½¹™¥œ¤ì(€€€€€…ÁÁ•¹‘Ù•¹Ð¡É½½Ð°ì(€€€€€€€ÑåÁ”è€‰½‰©•Ñ¥Ù”µÕÁ‘…Ñ•ˆ°(€€€€€€€ÍÕµµ…Éäè½‰©•Ñ¥Ù”°(€€€€€€€Í½ÕÉ”è€‰ÕÍ•Èˆ°(€€€€€€€ÍÑ…ÑÕÌè€‰…ÁÁ±¥•ˆ°(€€€€€ô¤ì(€€€€€É•…Ñ•¡•­Á½¥¹Ð¡É½½Ð¤ì(€€€€€½¹Í½±”¹±½œ ‰=‰©•Ñ¥Ù”ÕÁ‘…Ñ•¸ˆ¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€ô(€€€…Í”€‰½µÁ±•Ñ”ˆèì(€€€€€½¹ÍÐÍÕµµ…Éä€ôÁ…ÉÍ•¹Á½Í¥Ñ¥½¹…±Ì¹©½¥¸ ˆ€ˆ¤ñð€‰M•ÍÍ¥½¸½‰©•Ñ¥Ù”½µÁ±•Ñ•¸ˆì(€€€€€…ÁÁ•¹‘Ù•¹Ð¡É½½Ð°ì(€€€€€€€ÑåÁ”è€‰Í•ÍÍ¥½¸µ½µÁ±•Ñ•ˆ°(€€€€€€€ÍÕµµ…Éä°(€€€€€€€Í½ÕÉ”è€‰ÍåÍÑ•´ˆ°(€€€€€€€ÍÑ…ÑÕÌè€‰Ù•É¥™¥•ˆ°(€€€€€ô¤ì(€€€€€½¹ÍÐ½¹™¥œ€ô±½…‘½¹™¥œ¡É½½Ð¤ì(€€€€€½¹™¥œ¹ÍÑ…ÑÕÌ€ô€‰½µÁ±•Ñ•ˆì(€€€€€Í…Ù•½¹™¥œ¡É½½Ð°½¹™¥œ¤ì(€€€€€É•…Ñ•¡•­Á½¥¹Ð¡É½½Ð¤ì(€€€€€½¹Í½±”¹±½œ ‰M•ÍÍ¥½¸µ…É­•½µÁ±•Ñ•¸ˆ¤ì(€€€€€É•ÑÕÉ¸€Àì(€€€ô(€€€‘•™…Õ±Ðè(€€€€€Ñ¡É½Ü¹•ÜI•±…åÉÉ½È¡U¹­¹½Ý¸½µµ…¹pˆ‘í½µµ…¹‘õpˆ¸IÕ¸p‰É•±…ä¡•±Ápˆ¹€°€È¤ì(€ô)ô()½¹ÍÐ‘¥É•Ð€ôÁÉ½•ÍÌ¹…ÉÙlÅt€˜˜É•Í½±Ù”¡ÁÉ½•ÍÌ¹…ÉÙlÅt¤€ôôôÉ•Í½±Ù”¡™¥±•UI1Q½A…Ñ ¡¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤¤ì)¥˜€¡‘¥É•Ð¤ì(€µ…¥¸ ¤(€€€€¹Ñ¡•¸ ¡½‘”¤€ôøì(€€€€€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô½‘”ì(€€€ô¤(€€€€¹…Ñ  ¡•ÉÉ½È¤€ôøì(€€€€€¥˜€¡•ÉÉ½È¥¹ÍÑ…¹•½˜I•±…åÉÉ½È¤ì(€€€€€€€½¹Í½±”¹•ÉÉ½È¡½¹Ñ•áÐI•±…äè€‘í•ÉÉ½È¹µ•ÍÍ…•õ€¤ì(€€€€€€€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô•ÉÉ½È¹•á¥Ñ½‘”ì(€€€€€ô•±Í”ì(€€€€€€€½¹Í½±”¹•ÉÉ½È¡•ÉÉ½Èü¹ÍÑ…¬€üü•ÉÉ½È¤ì(€€€€€€€ÁÉ½•ÍÌ¹•á¥Ñ½‘”€ô€Äì(€€€€€ô(€€€ô¤ì)ô()•áÁ½ÉÐì(€!-A=%9Q}%1°(€=9%}%1°(€Y9QM}%1°(€IMU5}%1°(€I•±…åÉÉ½È°(€…ÁÁ•¹‘Ù•¹Ð°(€‰Õ¥±‘•É¥Ù•‘MÑ…Ñ”°(€½µÁ…É•]½É­ÍÁ…”°(€½µÁ…É•]½É­ÍÁ…•M¹…ÁÍ¡½ÑÌ°(€É•…Ñ•¡•­Á½¥¹Ð°(€™¥¹‘MÑ…Ñ•I½½Ð°(€¥ÑM¹…ÁÍ¡½Ð°(€¥¹¥Ñ¥…±¥é”°(€µ…¥¸°(€Á…ÉÍ•¥ÑMÑ…ÑÕÌ°(€É•‘…ÑMÑÉ¥¹œ°(€É•‘…ÑY…±Õ”°(€É•¹‘•ÉI•ÍÕµ”°(€ÉÕ¹½Ñ½È°(€ÍÑ…‰±•MÑÉ¥¹¥™ä°(€Ù…±¥‘…Ñ•Ù•¹Ñ¡…¥¸°)ôì