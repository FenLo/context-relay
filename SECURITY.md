# Security policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose captured source code, credentials, or conversation data. Contact the maintainer privately and include the affected version, reproduction steps, and impact.

## Security model

Context Relay writes local files and can optionally execute commands explicitly supplied to `relay run`. It never downloads or executes commands from a checkpoint. `relay resume` and `relay doctor` are read-only.

Secret redaction reduces accidental disclosure but cannot recognize every credential format. Review exported bundles, especially `workspace.patch`, before sharing them.
