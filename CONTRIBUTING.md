# Contributing

Thanks for helping improve Miwarang Senpi Delegate.

## Before you start

- Use Bun 1.4 or later.
- Keep changes focused and describe the user-visible behavior they affect.
- Do not commit API keys, access tokens, local agent credentials, or generated run data.
- Open an issue or discussion first for substantial behavior or configuration changes.

## Development

Install dependencies and run the tests:

```sh
bun install
bun test
```

For changes to OpenCode integration, also test with a local OpenCode v2 service and a model available in its authenticated catalog. Do not hardcode credentials or OpenCode-specific headers; use the local `opencode api` command.

## Adding a backend

- Add a backend adapter under `src/backends/`.
- Register its backend type in `src/extension.js`.
- Use executable-plus-argv invocation for command-line tools; do not interpolate prompts into a shell command.
- Add tests for argument construction, foreground results, background tracking, and cancellation.
- Update `config.example.json` and the README with the backend configuration.

## Pull requests

Include a concise summary, the reason for the change, and the verification commands you ran. Keep generated files, local configuration, and test credentials out of the pull request.
