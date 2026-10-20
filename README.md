# Miwarang Senpi Delegate

Miwarang registers Senpi tools that delegate work to a configured backend. The default backend is the local OpenCode v2 service, called through `opencode api` so OpenCode retains its own authentication. A command backend accepts any configured executable and argument array for other coding agents.

## Requirements

- Bun 1.4 or later
- Senpi 5.1.30 or later
- OpenCode v2 for the default backend

## Install

Clone the project, install its dependency, and create the user config without replacing an existing config:

```sh
git clone https://github.com/itokun99/miwarang.git
cd miwarang
bun install
mkdir -p ~/.config/miwarang ~/.omo/agent/extensions
if [ ! -e ~/.config/miwarang/config.json ]; then
  cp config.example.json ~/.config/miwarang/config.json
fi
wrapper="$HOME/.omo/agent/extensions/miwarang.js"
source_url="file://$(pwd -P)/src/extension.js"
if [ ! -e "$wrapper" ]; then
  printf 'export { default } from "%s";\n' "$source_url" > "$wrapper"
fi
```

Restart Senpi or run `/reload` to load the extension. Once the global wrapper exists, start Senpi normally; do not also pass `-e` for the same extension or Senpi will register its tools twice. Before installing the wrapper, a one-off test can use:

```sh
senpi -e ~/Projects/miwarang/src/extension.js
```

Set `MIWARANG_CONFIG` to use a different config file. Without it, the extension reads `~/.config/miwarang/config.json`.

## Multi-harness routing

Miwarang routes each OMO target to a configured backend. Routes resolve in this order: exact key, then the `category:*` or `agent:*` wildcard, then `defaultRoute`. A target that does not resolve fails closed with `No route configured for <target>`.

### Category → backend

| Target | Backend |
| --- | --- |
| `category:quick` | `opencode` |
| `category:unspecified-low` | `opencode` |
| `category:unspecified-high` | `opencode` |
| `category:deep-low` | `opencode` |
| `category:deep-high` | `opencode` |
| `category:ultrabrain` | `opencode` |
| `category:artistry` | `opencode` |
| `category:architect` | `opencode` |
| `category:writing` | `commandcode` |
| `category:visual-engineering` | `opencode` |
| `agent:explore` | `opencode` |
| `agent:librarian` | `opencode` |
| `agent:plan-consultant` | `opencode` |
| `agent:plan-reviewer` | `opencode` |
| `agent:omo-native-code-reviewer` | `commandcode` |
| `agent:omo-native-gate-reviewer` | `commandcode` |
| `agent:omo-native-qa-executor` | `commandcode` |

All 10 categories and 7 agents are routed in the example config below. `category:ultrabrain` and `category:deep-high` set `blockNativeTask: false`, so they are routed without intercepting native `task` calls; the top-level `blockNativeTask: "all"` blocks native `task` for every other category and agent target. `freeOnly` routes are checked against the live OpenCode model catalog; configured candidates are tried in order and an unavailable or paid-only route fails instead of silently selecting another model. This invariant applies to `freeOnly` routes on the opencode backend; command backends use `pricePolicy` to control model selection.

### Block policy

Native OMO `task` calls are intercepted based on an explicit policy, independent of route presence:

- Top-level `blockNativeTask` (default `"configured"`): `true` or `"configured"` blocks targets that resolve to an exact or wildcard route; `"all"` blocks every category/agent target (requires a wildcard route or `defaultRoute`); `false` or `"none"` disables blocking; a string array blocks only the listed targets.
- Per-route `blockNativeTask` overrides the top-level value for that route. Set it to `false` to route a target without intercepting native `task` calls for it.

When a native `task` call is blocked, the parent agent is guided to call `miwarang_delegate` with the same prompt and target.

### Per-call overrides

Pass `backend` to `miwarang_delegate` to route a single call to a different backend than the route's. The override must name a configured backend. `model` and `agent` overrides work the same way.

### Commandcode recipe

To add the commandcode harness as a backend:

```json
"commandcode": {
  "type": "command",
  "command": "commandcode",
  "args": ["-p", "--model", "{{model}}", "--no-session", "--yolo", "-t"],
  "promptInput": "argument",
  "timeoutMs": 900000,
  "pricePolicy": "any"
}
```

`--yolo` is required: commandcode's print mode denies file writes and shell by default, so without `--yolo` the harness cannot perform edits or run tools. With `--yolo`, commandcode auto-approves every tool call — scope each delegation with an explicit `cwd` and prefer dedicated worktrees for risky edits.

### Example config

The committed example config (`config.example.json`) routes all 10 categories and 7 agents:

```json
{
  "defaultBackend": "opencode",
  "backends": {
    "opencode": {
      "type": "opencode-v2",
      "command": "opencode"
    },
    "commandcode": {
      "type": "command",
      "command": "commandcode",
      "args": ["-p", "--model", "{{model}}", "--no-session", "--yolo", "-t"],
      "promptInput": "argument",
      "timeoutMs": 900000
    }
  },
  "routes": {
    "category:quick": {
      "backend": "opencode",
      "models": [
        "opencode/space-bunny-free",
        "opencode/mimo-v2.6-flash-free"
      ],
      "freeOnly": true
    },
    "category:unspecified-low": {
      "backend": "opencode",
      "models": [
        "opencode-go/longcat-2.5-preview-free",
        "opencode/longcat-2.5-preview-free"
      ],
      "freeOnly": true
    },
    "category:deep-low": {
      "backend": "opencode",
      "models": [
        "opencode-go/longcat-2.5-preview-free",
        "opencode/nemotron-3.5-super-vl-free"
      ],
      "freeOnly": true
    },
    "category:unspecified-high": {
      "backend": "opencode",
      "models": [
        "opencode-go/longcat-2.5-preview-free",
        "opencode/nemotron-3.5-lightning-free"
      ],
      "freeOnly": true
    },
    "category:writing": {
      "backend": "commandcode",
      "models": [
        "qwen/qwen3.8-max",
        "moonshotai/kimi-k3"
      ]
    },
    "category:artistry": {
      "backend": "opencode",
      "models": [
        "opencode/space-bunny-free",
        "opencode/glm-5.3-flash-free"
      ],
      "freeOnly": true
    },
    "category:architect": {
      "backend": "opencode",
      "models": [
        "opencode-go/longcat-2.5-preview-free",
        "opencode/nemotron-3.5-lightning-free"
      ],
      "freeOnly": true
    },
    "category:visual-engineering": {
      "backend": "opencode",
      "models": [
        "opencode/nemotron-3.5-super-vl-free",
        "opencode/mimo-v2.6-flash-free"
      ],
      "freeOnly": true
    },
    "category:ultrabrain": {
      "backend": "opencode",
      "models": [
        "opencode/nemotron-3-ultra-free",
        "opencode/deepseek-v4.1-flash-free",
        "opencode/big-pickle"
      ],
      "freeOnly": true,
      "blockNativeTask": false
    },
    "category:deep-high": {
      "backend": "opencode",
      "models": [
        "opencode/deepseek-v4.1-flash-free",
        "opencode/nemotron-3-ultra-free",
        "opencode/big-pickle"
      ],
      "freeOnly": true,
      "blockNativeTask": false
    },
    "agent:explore": {
      "backend": "opencode",
      "models": [
        "opencode-go/longcat-2.5-preview-free",
        "opencode/space-bunny-free"
      ],
      "freeOnly": true
    },
    "agent:librarian": {
      "backend": "opencode",
      "models": [
        "opencode-go/longcat-2.5-preview-free",
        "opencode/space-bunny-free"
      ],
      "freeOnly": true
    },
    "agent:plan-consultant": {
      "backend": "opencode",
      "models": [
        "opencode-go/longcat-2.5-preview-free",
        "opencode/nemotron-3.5-lightning-free"
      ],
      "freeOnly": true
    },
    "agent:plan-reviewer": {
      "backend": "opencode",
      "models": [
        "opencode-go/longcat-2.5-preview-free",
        "opencode/nemotron-3.5-lightning-free"
      ],
      "freeOnly": true
    },
    "agent:omo-native-code-reviewer": {
      "backend": "commandcode",
      "models": [
        "qwen/qwen3.8-max",
        "moonshotai/kimi-k3"
      ]
    },
    "agent:omo-native-gate-reviewer": {
      "backend": "commandcode",
      "models": [
        "qwen/qwen3.8-max",
        "moonshotai/kimi-k3"
      ]
    },
    "agent:omo-native-qa-executor": {
      "backend": "commandcode",
      "models": [
        "qwen/qwen3.8-max",
        "moonshotai/kimi-k3"
      ]
    },
    "category:*": {
      "backend": "opencode",
      "models": [
        "opencode-go/beam-free",
        "opencode-go/longcat-2.5-preview-free"
      ],
      "freeOnly": true
    }
  },
  "defaultRoute": {
    "backend": "opencode",
    "models": [
      "opencode-go/longcat-2.5-preview-free",
      "opencode/space-bunny-free"
    ],
    "freeOnly": true
  },
  "blockNativeTask": "all",
  "runsDirectory": "~/.local/state/miwarang/runs"
}
```

## Foreground and background work

Use `miwarang_delegate` with:

- `target`: a configured category or agent key, such as `category:quick` or `agent:explore`
- `prompt`: the delegated task
- `mode`: `foreground` (default) or `background`
- optional `model`, `agent`, `backend`, and `cwd` overrides

Foreground execution waits and returns the final assistant text. Background execution returns an OpenCode session ID or a Miwarang command-run ID. Pass an OpenCode ID as `sessionId` to `miwarang_wait` or `miwarang_cancel`; pass a command-run ID as `runId`.

OpenCode operations use the authenticated `opencode api` CLI. The extension does not store OpenCode credentials or construct OpenCode-specific request headers.

## Watching background runs

Every background delegation is tracked in the session:

- The TUI footer status line shows the active runs and their runtime.
- `/miwarang` lists every tracked run with its state, elapsed time, and target.
- Under OMO sessions a **dag watch run** starts automatically: one
  category-routed watcher node polls the delegated run until it settles, so its
  progress renders in the `/dag` view, the TUI status widget, and any dag pane
  (for example `omo-tmux-dag`). The `miwarang_delegate` result reports the watch
  run ID, or why the watch could not start.

The bridge is best-effort and never fails the delegation. Configure it with the top-level `dagWatch` key:

```json
{
  "dagWatch": { "category": "quick", "pollSeconds": 30, "timeoutMinutes": 60 }
}
```

- `false` disables the watch bridge entirely.
- `category` picks the watcher node's category route (default `quick`).
- `pollSeconds` sets the watcher's polling interval (default `30`).
- `timeoutMinutes` bounds the watch (default `60`).

## Configuring other CLI agents

Add a backend of type `command` and route a target to it:

```json
{
  "backends": {
    "opencode": {
      "type": "opencode-v2",
      "command": "opencode"
    },
    "opencode-cli": {
      "type": "command",
      "command": "opencode",
      "args": ["run", "--model", "{{model}}"],
      "promptInput": "argument",
      "timeoutMs": 300000
    }
  }
}
```

Command arguments are executed as an argv array without a shell. Supported placeholders are `{{model}}`, `{{agent}}`, `{{cwd}}`, and `{{target}}`. `promptInput` is either `argument` (append the prompt as one argument) or `stdin` (write the prompt to stdin). Configure the exact command and flags supported by the installed CLI.

Command-run metadata is stored under `~/.local/state/miwarang/runs` by default, or under `runsDirectory` in the config. Prompts and environment variables are not saved in run records.

## License

Miwarang Senpi Delegate is distributed under the MIT License. See [LICENSE](LICENSE).

## Development

```sh
bun test
senpi -e ./src/extension.js --list-models
opencode api GET /api/model
```
