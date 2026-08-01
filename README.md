# Context Relay

Context Relay preserves the state of AI-assisted work so another conversation, model, or developer can continue without guessing.

It records the difference between something the assistant **proposed**, something it **applied**, and something direct evidence **verified**. Every meaningful update refreshes a compact Markdown resume packet and a machine-readable JSON checkpoint.

## Why it exists

A Git commit preserves code, but not necessarily:

- what the user actually wanted;
- which constraints must not be violated;
- what the assistant suggested but never implemented;
- which approaches failed and were reverted;
- what tests passed or failed;
- the exact next action when a chat limit or restart interrupted the work.

Context Relay stores those facts locally and exports them in a model-neutral format.

## Requirements

- Node.js 20 or newer
- Git is optional, but enables branch, commit, dirty-path, and drift checks

There are no runtime dependencies and no network calls.

## Quick start

From this repository:

```powershell
npm run build
node .\bin\context-relay.mjs init --objective "Fix the OAuth callback" --gitignore
```

Install the command globally during development if preferred:

```powershell
npm install --global .
relay status
```

Start recording durable context:

```powershell
relay turn --user "Fix the OAuth callback without introducing Redis"
relay constraint "Do not introduce Redis"
relay decision "Keep the existing signed-cookie session format"
relay attempt "Changing SameSite did not fix the callback" --details "The change was reverted"
relay run -- npm test
relay done "OAuth unit tests pass" --evidence "npm test exited 0"
relay next "Repair the integration-test state fixture"
```

Every command refreshes:

```text
.context-relay/
├── config.json
├── events.jsonl
├── checkpoint.json
├── RESUME.md
├── exports/
└── sessions/
```

The next AI can begin with:

```powershell
relay resume --json
```

The command compares the saved Git snapshot with the current workspace before recommending continuation.

## Evidence model

Context Relay intentionally separates three states:

| Status | Meaning |
|---|---|
| `proposed` | Discussed or planned, but not known to be applied |
| `applied` | A change or decision was made, but not independently verified |
| `verified` | A test, command, rendered artifact, or other evidence supports the claim |

Failed attempts, user constraints, unresolved blockers, and next steps have distinct event types. The append-only JSONL log is hash-chained, allowing `relay doctor` to detect accidental or deliberate edits.

## Command reference

```text
relay init --objective <goal> [--gitignore]
relay new <goal>
relay turn --user <summary> [--assistant <summary>]
relay add <type> <summary> [--status <status>] [--source <source>]
relay decision <summary>
relay constraint <summary>
relay done <verified result>
relay attempt <failed approach>
relay next <concrete next action>
relay blocker <description>
relay resolve <blocker-event-id> [summary]
relay note <summary>
relay run -- <command> [arguments...]
relay checkpoint
relay status [--json]
relay export [--output <directory>] [--include-patch]
relay resume [bundle-or-checkpoint] [--json]
relay doctor [bundle-or-checkpoint] [--json]
relay objective <new goal>
relay complete [summary]
```

Long text can be read from files with options such as `--user-file`, `--assistant-file`, `--summary-file`, and `--details-file`.

## Portable handoff bundles

Create a bundle for another AI or machine:

```powershell
relay export --output .\oauth-fix.handoff
relay doctor .\oauth-fix.handoff
```

By default, the bundle contains the event log, checkpoint, configuration, and resume document. It references the Git commit but does not copy source code.

To include tracked, uncommitted changes:

```powershell
relay export --output .\oauth-fix.handoff --include-patch
```

Review `workspace.patch` before sharing. It can contain proprietary code or secrets. Untracked files are listed in the checkpoint but are never silently copied.

## Codex skill

A standalone Codex skill is available at:

```text
adapters/codex/context-relay/
```

The adapter contains its own built CLI, so it does not require a global package install. Copy that directory into the Codex skills directory, then invoke `$context-relay`. The skill instructs Codex to record context throughout the task, checkpoint before handoff, and verify workspace drift on resume.

Run `npm run build` after editing `src/context-relay.mjs`; the build copies the canonical CLI into both `bin/` and the skill's `scripts/` directory.

## Security and privacy

Context Relay is local-first. It does not upload data. Before writing events or command output, it redacts common bearer tokens, API keys, GitHub tokens, AWS access keys, JWTs, credential-bearing URLs, passwords, and secrets.

Redaction is defense in depth, not a guarantee. Do not intentionally put secrets in summaries. Environment-variable values are never collected. Command output is truncated, and source patches require an explicit flag.

## Development

```powershell
npm run check
npm run demo
```

The test suite covers event integrity, redaction, command evidence, blocker resolution, session archives, bundle validation, Git drift detection, and the standalone Codex skill.

## Protocol

JSON Schemas for the event and checkpoint formats live in [`schema/`](schema/). The current schema version is `1`; consumers should reject unsupported major versions instead of guessing.
