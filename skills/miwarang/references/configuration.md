# Configuration

The default config path is `~/.config/miwarang/config.json`. Set
`MIWARANG_CONFIG` to load a different file.

Configuration has two main fields:

- `backends`: named harness definitions.
- `delegation`: ordered backend IDs. Miwarang tries the next entry only for
  recognized provider failures.

```json
{
  "backends": {
    "opencode": {
      "type": "opencode-cli",
      "command": "opencode",
      "args": ["run"],
      "promptInput": "argument",
      "timeoutMs": 900000
    },
    "commandcode": {
      "type": "command",
      "command": "commandcode",
      "args": [
        "-p",
        "--no-session",
        "--yolo",
        "--max-turns",
        "200",
        "--tools-enable",
        "agent,agent_output",
        "-t"
      ],
      "promptInput": "argument",
      "timeoutMs": 900000,
      "agent": "General"
    },
    "koma": {
      "type": "koma-sdk",
      "command": "koma",
      "args": ["sdk", "serve"],
      "timeoutMs": 900000
    }
  },
  "delegation": ["opencode", "commandcode", "koma"],
  "runsDirectory": "~/.local/state/miwarang/runs"
}
```

This mirrors the repository's `config.example.json`.

## Harness-owned models and agents

Miwarang does not select models. Do not add a model list or a model flag for
the delegator to calculate. Each harness uses its own model configuration.
Set a backend's optional `agent` field only when that harness needs a
specific agent. Use `{{agent}}` in command arguments to pass the configured
agent to that harness; do not pass an agent name in the delegate call.

For example, Command Code can use its `General` agent and enable its
`agent,agent_output` tools. OpenCode can run `opencode run` without an
explicit agent so it uses the harness's configured default, or its backend
can explicitly configure an agent when desired.

## Delegation order

The `delegation` array establishes the primary backend and its ordered
fallbacks. Do not use OMO intent routes or target names; routing is configured
in Miwarang itself.

Legacy route/model keys such as `routes`, `defaultRoute`, `defaultModels`,
`pricePolicy`, `defaultBackend`, and `blockNativeTask` were removed in v0.9.
The loader rejects them and reports migration guidance.

## Security

Do not commit credentials or secrets. Store credentials in the selected
harness's own authenticated configuration. Avoid delegating secrets in a
prompt; Miwarang redacts common secret patterns from captured backend output,
but redaction is not a substitute for keeping secrets out of the task.

The Command Code recipe uses `--yolo`, which approves its tool calls. Keep
delegations scoped to the intended `cwd` and use a dedicated worktree when
the task's edits need isolation.
