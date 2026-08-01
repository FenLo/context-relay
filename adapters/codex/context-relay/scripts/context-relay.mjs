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
        `- Dirty>8óm¢G§²ÚîÆ­yÚ›Ûİ
NÂˆÛÛœÛÛK›ÙÊ”Ù\ÜÚ[ÛˆX\šÙYÛÛ\]YˆŠNÂˆ™]\›ˆÂˆBˆY˜][‚ˆ›İÈ™]È™[^Q\œ›ÜŠ[šÛ›İÛˆÛÛ[X[™‰ØÛÛ[X[™W‹ˆ[ˆœ™[^H[‹˜ŠNÂˆBŸB‚˜ÛÛœİ\™XİH›ØÙ\ÜË˜\™İ–ÌWH	‰ˆ™\ÛÛ™J›ØÙ\ÜË˜\™İ–ÌWJHOOH™\ÛÛ™Jš[UT“Ô]
[\Ü›Y]K\›
JNÂšYˆ
\™Xİ
HÂˆXZ[Š
Bˆ[Š
ÛÙJHOˆÂˆ›ØÙ\ÜË™^]ÛÙHHÛÙNÂˆJBˆ˜Ø]Ú

\œ›ÜŠHOˆÂˆYˆ
\œ›Üˆ[œİ[˜Ù[Ùˆ™[^Q\œ›ÜŠHÂˆÛÛœÛÛK™\œ›ÜŠÛÛ^™[^Nˆ	Ù\œ›Ü‹›Y\ÜØYÙ_X
NÂˆ›ØÙ\ÜË™^]ÛÙHH\œ›Ü‹™^]ÛÙNÂˆH[ÙHÂˆÛÛœÛÛK™\œ›ÜŠ\œ›ÜËœİXÚÈÏÈ\œ›ÜŠNÂˆ›ØÙ\ÜË™^]ÛÙHHNÂˆBˆJNÂŸB‚™^ÜÂˆÒPÒÔÒS•Ñ’SKˆÓÓ‘’Q×Ñ’SKˆU‘S•×Ñ’SKˆ‘TÕSQWÑ’SKˆ™[^Q\œ›Ü‹ˆ\[™]™[ˆZ[\š]™Yİ]KˆÛÛ\\™UÛÜšÜÜXÙKˆÛÛ\\™UÛÜšÜÜXÙTÛ˜\ÚİËˆÜ™X]PÚXÚÜÚ[ˆš[™İ]T›ÛİˆÚ]Û˜\Úİˆ[š]X[^™KˆXZ[‹ˆ\œÙQÚ]İ]\Ëˆ™YXİİš[™Ëˆ™YXİ˜[YKˆ™[™\”™\İ[YKˆ[‘ØİÜ‹ˆİX›Tİš[™ÚYKˆ˜[Y]Q]™[ÚZ[‹ŸNÂ