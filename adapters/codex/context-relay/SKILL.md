---
name: context-relay
description: Persist, verify, export, and resume AI-assisted work across chat limits, conversation changes, context compaction, model switches, restarts, and developer handoffs. Use when Codex needs to checkpoint what the user requested, what was discussed, which actions were proposed or applied, what commands and tests proved, which attempts failed, where work stopped, or when another AI must continue from an existing Context Relay checkpoint.
---

# Context Relay

Use the bundled `scripts/context-relay.mjs` CLI from the user's active workspace. Resolve the script relative to this skill directory and invoke it with Node.js.

## Start or resume

1. Look for `.context-relay/checkpoint.json` in the workspace or its parents.
2. If it exists, run `node <skill-root>/scripts/context-relay.mjs resume --json` before changing files. Compare the saved branch, HEAD, dirty paths, constraints, and next steps with the current workspace.
3. If it does not exist, run `node <skill-root>/scripts/context-relay.mjs init --objective "<the user's full objective>" --gitignore`.
4. Treat the live workspace and command results as authoritative. Treat checkpoint items according to their status: `proposed` is not applied; `applied` is not verified; `verified` has evidence.

## Capture work continuously

Record concise, decision-useful facts after each meaningful turn or tool result. Do not wait until the context limit is nearly exhausted.

- Capture user requirements or changed intent with `turn --user`.
- Capture important assistant commitments or explanations with `turn --assistant`.
- Capture hard user preferences with `constraint`.
- Capture choices and reasons with `decision`.
- Capture unsuccessful approaches with `attempt`; include why they failed.
- Capture a completed result with `done` only after evidence verifies it.
- Capture unfinished work with `next` using a concrete first action.
- Capture blockers with `blocker`; resolve them with `resolve <event-id>`.
- Prefer `run -- <command>` for important verification commands so exit codes and redacted output become evidence.

Examples:

```text
node <skill-root>/scripts/context-relay.mjs constraint "Do not add Redis"
node <skill-root>/scripts/context-relay.mjs decision "Keep the existing session format" --details "Avoid a data migration"
node <skill-root>/scripts/context-relay.mjs attempt "Changing SameSite did not fix the callback" --details "Reverted the change"
node <skill-root>/scripts/context-relay.mjs run -- npm test
node <skill-root>/scripts/context-relay.mjs done "OAuth unit tests pass" --evidence "npm test exited 0"
node <skill-root>/scripts/context-relay.mjs next "Fix the callback integration-test fixture"
```

## Checkpoint and hand off

Before a final response, pause, model switch, or expected context loss:

1. Record the latest assistant summary with `turn --assistant`.
2. Record at least one concrete `next` item if work remains.
3. Run `checkpoint`.
4. Run `doctor`; do not hand off invalid state.
5. When the recipient has the same workspace, provide `.context-relay/RESUME.md` and `.context-relay/checkpoint.json`.
6. When the recipient does not have the same workspace, run `export`. Use `--include-patch` only after reviewing source and secrets.

## Protect context quality

- Record conclusions, constraints, evidence, and failed approaches; avoid copying verbose chat when a precise summary preserves the decision state.
- Never record environment-variable values, credentials, private keys, access tokens, or unnecessary personal information.
- Inspect the current Git and filesystem state on resume; do not blindly execute a saved next step after workspace drift.
- Never describe an action as verified without command, test, rendered output, or other direct evidence.
