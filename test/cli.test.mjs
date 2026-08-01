import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  compareWorkspaceSnapshots,
  parseGitStatus,
} from "../src/context-relay.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(projectRoot, "src", "context-relay.mjs");

function temporaryProject() {
  return mkdtempSync(join(tmpdir(), "context-relay-test-"));
}

function run(cwd, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(
    result.status,
    expectedStatus,
    `Command failed: ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

test("captures conversation, decisions, evidence, failures, and next steps", () => {
  const root = temporaryProject();
  try {
    run(root, ["init", "--objective", "Fix OAuth callback"]);
    run(root, [
      "turn",
      "--user",
      "Fix the callback without Redis",
      "--assistant",
      "I will inspect signed-state validation",
    ]);
    run(root, ["constraint", "Do not introduce Redis"]);
    run(root, [
      "decision",
      "Keep signed-cookie sessions",
      "--details",
      "Avoid a migration",
    ]);
    run(root, [
      "attempt",
      "Changing SameSite did not help",
      "--details",
      "The change was reverted",
    ]);
    run(root, ["done", "Unit tests pass", "--evidence", "npm test exited 0"]);
    run(root, ["next", "Repair the integration-test state fixture"]);

    const status = run(root, ["status", "--json"]);
    const checkpoint = JSON.parse(status.stdout);
    assert.equal(checkpoint.objective, "Fix OAuth callback");
    assert.equal(checkpoint.state.userMessages.length, 1);
    assert.equal(checkpoint.state.assistantMessages.length, 1);
    assert.equal(checkpoint.state.constraints[0].summary, "Do not introduce Redis");
    assert.equal(checkpoint.state.decisions[0].summary, "Keep signed-cookie sessions");
    assert.equal(checkpoint.state.failedAttempts.length, 1);
    assert.equal(checkpoint.state.verified[0].summary, "Unit tests pass");
    assert.equal(
      checkpoint.state.nextSteps[0].summary,
      "Repair the integration-test state fixture",
    );

    const resume = readFileSync(join(root, ".context-relay", "RESUME.md"), "utf8");
    assert.match(resume, /Fix OAuth callback/);
    assert.match(resume, /Changing SameSite did not help/);
    assert.match(resume, /Repair the integration-test state fixture/);

    const doctor = run(root, ["doctor", "--json"]);
    assert.equal(JSON.parse(doctor.stdout).ok, true);
  } finally {
    cleanup(root);
  }
});

test("redacts common secrets before persisting conversation or command evidence", () => {
  const root = temporaryProject();
  try {
    const openAiKey = "sk-proj-abcdefghijklmnop123456";
    const githubToken = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    run(root, ["init", "--objective", "Protect secrets"]);
    run(root, [
      "turn",
      "--user",
      `The key is ${openAiKey}`,
      "--assistant",
      `Never print ${githubToken}`,
    ]);
    const events = readFileSync(join(root, ".context-relay", "events.jsonl"), "utf8");
    assert.doesNotMatch(events, new RegExp(openAiKey));
    assert.doesNotMatch(events, new RegExp(githubToken));
    assert.match(events, /REDACTED_OPENAI_KEY/);
    assert.match(events, /REDACTED_GITHUB_TOKEN/);
  } finally {
    cleanup(root);
  }
});

test("records command exit codes and redacted output even when the command fails", () => {
  const root = temporaryProject();
  try {
    writeFileSync(
      join(root, "fail.mjs"),
      'console.error("password=supersecretvalue"); process.exit(7);\n',
      "utf8",
    );
    run(root, ["init", "--objective", "Capture a failing verification"]);
    const failed = run(root, ["run", "--", process.execPath, "fail.mjs"], 7);
    assert.match(failed.stderr, /password=supersecretvalue/);
    const checkpoint = readJson(join(root, ".context-relay", "checkpoint.json"));
    assert.equal(checkpoint.state.commands.length, 1);
    assert.equal(checkpoint.state.commands[0].evidence.exitCode, 7);
    assert.doesNotMatch(
      checkpoint.state.commands[0].evidence.stderr,
      /supersecretvalue/,
    );
    assert.match(checkpoint.state.commands[0].evidence.stderr, /REDACTED/);
  } finally {
    cleanup(root);
  }
});

test("resolves blockers by event id", () => {
  const root = temporaryProject();
  try {
    run(root, ["init", "--objective", "Resolve a blocker"]);
    run(root, ["blocker", "Missing test fixture"]);
    let checkpoint = readJson(join(root, ".context-relay", "checkpoint.json"));
    assert.equal(checkpoint.state.blockers.length, 1);
    const blockerId = checkpoint.state.blockers[0].id;
    run(root, ["resolve", blockerId, "Fixture was added"]);
    checkpoint = readJson(join(root, ".context-relay", "checkpoint.json"));
    assert.equal(checkpoint.state.blockers.length, 0);
  } finally {
    cleanup(root);
  }
});

test("archives an old session before starting a new one", () => {
  const root = temporaryProject();
  try {
    run(root, ["init", "--objective", "First task"]);
    run(root, ["note", "Important historical note"]);
    const first = readJson(join(root, ".context-relay", "config.json"));
    run(root, ["new", "Second task"]);
    const second = readJson(join(root, ".context-relay", "config.json"));
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(second.objective, "Second task");
    const archive = join(root, ".context-relay", "sessions", first.sessionId);
    assert.equal(existsSync(join(archive, "events.jsonl")), true);
    assert.match(readFileSync(join(archive, "events.jsonl"), "utf8"), /Important historical note/);
  } finally {
    cleanup(root);
  }
});

test("updates objectives, supports generic events, adds gitignore, and completes a session", () => {
  const root = temporaryProject();
  try {
    run(root, ["init", "--objective", "Initial objective", "--gitignore"]);
    assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.context-relay\/$/m);
    run(root, ["objective", "Refined objective"]);
    run(root, [
      "add",
      "finding",
      "The root cause is verified",
      "--status",
      "verified",
      "--source",
      "tool",
    ]);
    run(root, ["complete", "All requested work is verified"]);
    const checkpoint = readJson(join(root, ".context-relay", "checkpoint.json"));
    assert.equal(checkpoint.objective, "Refined objective");
    assert.equal(checkpoint.status, "completed");
    assert.equal(checkpoint.state.verified[0].summary, "The root cause is verified");
    assert.equal(JSON.parse(run(root, ["doctor", "--json"]).stdout).ok, true);
  } finally {
    cleanup(root);
  }
});

test("exports a verifiable bundle that can be resumed outside an initialized workspace", () => {
  const root = temporaryProject();
  const recipient = temporaryProject();
  try {
    run(root, ["init", "--objective", "Portable handoff"]);
    run(root, ["next", "Continue in another directory"]);
    const bundle = join(root, "portable.handoff");
    run(root, ["export", "--output", bundle]);
    assert.equal(existsSync(join(bundle, "bundle.json")), true);
    assert.equal(JSON.parse(run(recipient, ["doctor", bundle, "--json"]).stdout).ok, true);

    const resumed = run(recipient, ["resume", bundle, "--json"], 3);
    const parsed = JSON.parse(resumed.stdout);
    assert.equal(parsed.checkpoint.objective, "Portable handoff");
    assert.equal(parsed.drift.compatible, false);
    assert.match(
      parsed.drift.warnings.join(" "),
      /Git evidence|not a Git repository|outside a Git repository/i,
    );
  } finally {
    cleanup(root);
    cleanup(recipient);
  }
});

test("doctor detects a tampered event log and bundle hash", () => {
  const root = temporaryProject();
  try {
    run(root, ["init", "--objective", "Detect tampering"]);
    run(root, ["note", "Original fact"]);
    const bundle = join(root, "tampered.handoff");
    run(root, ["export", "--output", bundle]);
    const eventPath = join(bundle, "events.jsonl");
    writeFileSync(
      eventPath,
      readFileSync(eventPath, "utf8").replace("Original fact", "Altered fact"),
      "utf8",
    );
    const doctor = run(root, ["doctor", bundle, "--json"], 4);
    const result = JSON.parse(doctor.stdout);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /hash/i);
  } finally {
    cleanup(root);
  }
});

test("captures Git state, exports a patch, and reports subsequent workspace drift", (t) => {
  const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (gitVersion.status !== 0) {
    t.skip("Git is not installed");
    return;
  }
  const root = temporaryProject();
  try {
    run(root, ["init", "--objective", "Track Git drift", "--gitignore"]);
    writeFileSync(join(root, "app.txt"), "version one\n", "utf8");
    spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
    spawnSync("git", ["config", "user.email", "relay@example.test"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Context Relay Test"], { cwd: root });
    spawnSync("git", ["add", "."], { cwd: root });
    const commit = spawnSync("git", ["commit", "-m", "initial"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(commit.status, 0, commit.stderr);

    writeFileSync(join(root, "app.txt"), "version two\n", "utf8");
    run(root, ["checkpoint"]);
    const checkpoint = readJson(join(root, ".context-relay", "checkpoint.json"));
    assert.equal(checkpoint.workspace.available, true);
    assert.equal(checkpoint.workspace.dirty, true);
    assert.match(checkpoint.workspace.changes[0].path, /app\.txt/);

    const bundle = join(root, "git.handoff");
    run(root, ["export", "--output", bundle, "--include-patch"]);
    assert.match(readFileSync(join(bundle, "workspace.patch"), "utf8"), /version two/);
    assert.equal(JSON.parse(run(root, ["resume", bundle, "--json"]).stdout).drift.compatible, true);

    writeFileSync(join(root, "new.txt"), "drift\n", "utf8");
    const drifted = run(root, ["resume", bundle, "--json"], 3);
    const drift = JSON.parse(drifted.stdout).drift;
    assert.equal(drift.compatible, false);
    assert.match(drift.warnings.join(" "), /new\.txt/);
  } finally {
    cleanup(root);
  }
});

test("parses Git status safely and detects synthetic branch, HEAD, and dirty-path drift", () => {
  assert.deepEqual(
    parseGitStatus(" M src/app.js\n?? .context-relay/checkpoint.json\nA  README.md"),
    [
      { code: " M", path: "src/app.js" },
      { code: "A ", path: "README.md" },
    ],
  );
  const saved = {
    available: true,
    root: "C:/project",
    branch: "feature/auth",
    head: "abc123",
    changes: [{ code: " M", path: "src/auth.js" }],
  };
  const exact = compareWorkspaceSnapshots(saved, structuredClone(saved));
  assert.equal(exact.compatible, true);
  assert.equal(exact.warnings.length, 0);

  const drifted = compareWorkspaceSnapshots(saved, {
    ...saved,
    branch: "main",
    head: "def456",
    changes: [
      { code: " M", path: "src/auth.js" },
      { code: "??", path: "src/new.js" },
    ],
  });
  assert.equal(drifted.compatible, false);
  assert.match(drifted.warnings.join(" "), /HEAD drift/);
  assert.match(drifted.warnings.join(" "), /Branch drift/);
  assert.match(drifted.warnings.join(" "), /src\/new\.js/);
});

test("Codex skill has valid triggering metadata and a standalone built CLI", () => {
  const skillRoot = join(projectRoot, "adapters", "codex", "context-relay");
  const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, "SKILL.md must have YAML frontmatter");
  const keys = frontmatter[1]
    .split(/\r?\n/)
    .filter((line) => /^[a-z]/.test(line))
    .map((line) => line.split(":", 1)[0]);
  assert.deepEqual(keys, ["name", "description"]);
  assert.match(frontmatter[1], /name: context-relay/);
  assert.match(frontmatter[1], /chat limits/);

  const openAi = readFileSync(join(skillRoot, "agents", "openai.yaml"), "utf8");
  assert.match(openAi, /default_prompt:.*\$context-relay/);
  const standalone = join(skillRoot, "scripts", "context-relay.mjs");
  assert.equal(readFileSync(standalone, "utf8"), readFileSync(cli, "utf8"));
  const help = spawnSync(process.execPath, [standalone, "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /portable checkpoints/i);

  const workspace = temporaryProject();
  try {
    const execute = (args) =>
      spawnSync(process.execPath, [standalone, ...args], {
        cwd: workspace,
        encoding: "utf8",
      });
    assert.equal(
      execute(["init", "--objective", "Resume this work with the standalone skill"]).status,
      0,
    );
    assert.equal(execute(["turn", "--user", "Preserve exact constraints"]).status, 0);
    assert.equal(execute(["next", "Run the remaining verification"]).status, 0);
    const resumed = execute(["resume", "--json"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    const packet = JSON.parse(resumed.stdout);
    assert.equal(packet.checkpoint.objective, "Resume this work with the standalone skill");
    assert.equal(packet.checkpoint.state.nextSteps.length, 1);
  } finally {
    cleanup(workspace);
  }
});
