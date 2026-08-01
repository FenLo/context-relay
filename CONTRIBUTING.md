# Contributing

1. Create a focused branch.
2. Keep the CLI dependency-free unless a dependency has a compelling security and portability justification.
3. Update schemas when changing persisted structures.
4. Run `npm run check` before opening a pull request.
5. Include tests for Windows and POSIX behavior when changing command execution or paths.

Persisted data must remain model-neutral. Provider-specific behavior belongs in `adapters/`.
