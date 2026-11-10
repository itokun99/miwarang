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

All 10 categories and 7 agents are routed in the example config below. `category:ultrabrain` and `category:deep-high` set `blockNativeTask: false`; the top-level `blockNativeTask: "all"` blocks native `task` calls for the other configured targets.

Every Command Code lane — `category:quick`, `category:writing`, and the three `agent:omo-native-*` routes — also carries koma as a final fallback, so the bundled free model absorbs work when OpenCode and Command Code are unavailable.

OpenCode sessions use the model configured in the OpenCode harness and the `orchestrator` agent. Miwarang does not query OpenCode's model catalogue or apply `freeOnly` restrictions. Command Code routes still use their configured model candidates in order, but Miwarang does not filter candidates by free/paid status. Both backends may have ordered fallbacks.

### Block policy

Native OMO `task` calls are intercepted based on an explicit policy, independent of route presence:

- Top-level `blockNativeTask` (default `"configured"`): `true` or `"configured"` blocks targets that resolve to an exact or wildcard route; `"all"` blocks every category/agent target (requires a wildcard route or `defaultRoute`); `false` or `"none"` disables blocking; a string array blocks only the listed targets.
- Per-route `blockNativeTask` overrides the top-level value for that route. Set it to `false` to route a target without intercepting native `task` calls for it.

When a native `task` call is blocked, the parent agent is guided to call `miwarang_delegate` with the same prompt and target.

### Per-call overrides

Pass `backend` only for an intentional harness override; it must name a configured backend. OpenCode targets reject `model` and `agent` overrides: sessions use the configured default model and the `orchestrator` agent. Command-line `agent` overrides work only when that backend's args contain `{{agent}}`. An OMO target such as `agent:explore` selects a Miwarang route; it is not a harness agent name. Never forward the OMO session's own model.

### Model selection and availability

Model choice belongs to the target harness, not to OMO:

- `opencode-v2` sessions omit the `model` field and use the OpenCode configuration for the workspace. Miwarang selects the `orchestrator` agent, and does not query the model catalogue or enforce legacy `freeOnly` fields on OpenCode routes.
- Command backends use `models` as an ordered candidate list. If `listModelsArgv` is configured, Miwarang skips candidates absent from that harness's live catalogue; it does not filter candidates by free/paid status. Route order controls the candidate priority; the example puts free candidates before cheap models. A command backend without a model-list probe treats its configured list as authoritative.
- Command routes may omit `models` to inherit `defaultModels`; OpenCode routes may omit `models` because OpenCode chooses its own default.
- A route can opt into cross-backend failover with an ordered `fallbacks` array. Command Code candidates continue through that list for quota, rate-limit, credit, five-hour, weekly-limit, and HTTP 429 failures. OpenCode runtime failures move to the next configured backend fallback rather than trying Miwarang's model list. Background runtime failures are reported through `miwarang_wait`.

Example route using OpenCode's configured default model and a Command Code fallback:

```json
{
  "backend": "opencode",
  "fallbacks": [
    {
      "backend": "commandcode",
      "models": [
        "reflection/beam:free",
        "poolside/laguna-s-2.1-free",
        "stealth/glyph-cluster:free",
        "deepseek/deepseek-v4-flash",
        "qwen/qwen3.8-flash",
        "qwen/qwen3.7-flash"
      ]
    }
  ]
}
```

### Commandcode recipe

To add the commandcode harness as a backend:

```json
"commandcode": {
  "type": "command",
  "command": "commandcode",
  "args": ["-p", "--model", "{{model}}", "--no-session", "--yolo", "--tools-enable", "agent,agent_output", "-t"],
  "promptInput": "argument",
  "timeoutMs": 900000,
  "listModelsArgv": ["--list-models"]
}
```

Command Code print mode uses its built-in General agent unless a harness agent is explicitly selected. `--tools-enable agent,agent_output` lets General delegate to the agents registered in that Command Code installation. The CLI has no `--agent` flag, so Miwarang does not pass OMO agent names as Command Code agent overrides.

`--yolo` is required: commandcode's print mode denies file writes and shell by default, so without `--yolo` the harness cannot perform edits or run tools. With `--yolo`, commandcode auto-approves every tool call — scope each delegation with an explicit `cwd` and prefer dedicated worktrees for risky edits. `listModelsArgv` turns on the availability check: `commandcode --list-models` feeds the configured candidate selection.

### Koma recipe

To add the [koma](https://koma.run) harness as a backend:

```json
"koma": {
  "type": "koma-sdk",
  "command": "koma",
  "args": ["sdk", "serve"],
  "timeoutMs": 900000
}
```

Koma has no reply-printing headless mode: `koma run --prompt … --once` prints only session metadata, and the assistant reply never reaches its stdout. Miwarang therefore talks to koma's public SDK stdio adapter, a JSON Lines protocol (`hello`, `create`, `submit`, `state` events, `interrupt`, `detach`) documented in the koma repository under `src-core-sdk/protocol/CONTRACT.md`. Nothing is interpolated into a shell: the adapter spawns `koma sdk serve` as an argv array and streams the prompt over that process's stdin.

A koma route names model candidates exactly like a command backend, and there is no model-list probe, so the configured list is authoritative. koma's bundled free model is `koma/apple` (provider `koma free`, `api_type` `koma_free`, endpoint `https://koma.run/api/v1/koma-free`); it is used unless the route names another candidate. Add `"policy"` only to change the session policy — the default is `{ "plan": "forbid", "approval": "reject" }`, matching koma's own headless default, where `plan` is `allow` or `forbid` and `approval` is `default` or `reject`.

Delegations run headless: koma starts a turn, Miwarang waits for the terminal turn state, and returns the newest assistant message. Background runs expose a Miwarang run ID; `miwarang_wait` returns the recorded result, and `miwarang_cancel` interrupts the active turn.

In the example config, koma is appended as a last-resort fallback after the Command Code candidates. Move it earlier in a route's `fallbacks` array to prefer the free model before the paid candidates.

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
      "args": ["-p", "--model", "{{model}}", "--no-session", "--yolo", "--tools-enable", "agent,agent_output", "-t"],
      "promptInput": "argument",
      "timeoutMs": 900000,
      "listModelsArgv": ["--list-models"]
    },
    "koma": {
      "type": "koma-sdk",
      "command": "koma",
      "args": ["sdk", "serve"],
      "timeoutMs": 900000
    }
  },
  "routes": {
    "category:quick": {
      "backend": "opencode",
      "fallbacks": [
        {
          "backend": "commandcode",
          "models": [
            "reflection/beam:free",
            "poolside/laguna-s-2.1-free",
            "stealth/glyph-cluster:free",
            "deepseek/deepseek-v4-flash",
            "qwen/qwen3.8-flash",
            "qwen/qwen3.7-flash"
          ]
        },
        {
          "backend": "koma",
          "models": ["koma/apple"]
        }
      ]
    },
    "category:unspecified-low": {
      "backend": "opencode"
    },
    "category:deep-low": {
      "backend": "opencode"
    },
    "category:unspecified-high": {
      "backend": "opencode"
    },
    "category:writing": {
      "backend": "commandcode",
      "models": [
        "reflection/beam:free",
        "poolside/laguna-s-2.1-free",
        "stealth/glyph-cluster:free",
        "deepseek/deepseek-v4-flash",
        "qwen/qwen3.8-flash",
        "qwen/qwen3.7-flash"
      ],
      "fallbacks": [{ "backend": "koma", "models": ["koma/apple"] }]
    },
    "category:artistry": {
      "backend": "opencode"
    },
    "category:architect": {
      "backend": "opencode"
    },
    "category:visual-engineering": {
      "backend": "opencode"
    },
    "category:ultrabrain": {
      "backend": "opencode",
      "blockNativeTask": false
    },
    "category:deep-high": {
      "backend": "opencode",
      "blockNativeTask": false
    },
    "agent:explore": {
      "backend": "opencode"
    },
    "agent:librarian": {
      "backend": "opencode"
    },
    "agent:plan-consultant": {
      "backend": "opencode"
    },
    "agent:plan-reviewer": {
      "backend": "opencode"
    },
    "agent:omo-native-code-reviewer": {
      "backend": "commandcode",
      "models": [
        "reflection/beam:free",
        "poolside/laguna-s-2.1-free",
        "stealth/glyph-cluster:free",
        "deepseek/deepseek-v4-flash",
        "qwen/qwen3.8-flash",
        "qwen/qwen3.7-flash"
      ],
      "fallbacks": [{ "backend": "koma", "models": ["koma/apple"] }]
    },
    "agent:omo-native-gate-reviewer": {
      "backend": "commandcode",
      "models": [
        "reflection/beam:free",
        "poolside/laguna-s-2.1-free",
        "stealth/glyph-cluster:free",
        "deepseek/deepseek-v4-flash",
        "qwen/qwen3.8-flash",
        "qwen/qwen3.7-flash"
      ],
      "fallbacks": [{ "backend": "koma", "models": ["koma/apple"] }]
    },
    "agent:omo-native-qa-executor": {
      "backend": "commandcode",
      "models": [
        "reflection/beam:free",
        "poolside/laguna-s-2.1-free",
        "stealth/glyph-cluster:free",
        "deepseek/deepseek-v4-flash",
        "qwen/qwen3.8-flash",
        "qwen/qwen3.7-flash"
      ],
      "fallbacks": [{ "backend": "koma", "models": ["koma/apple"] }]
    },
    "category:*": {
      "backend": "opencode"
    }
  },
  "defaultRoute": {
    "backend": "opencode"
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
- optional `model`, `agent`, `backend`, and `cwd` for command backends; OpenCode model/agent overrides are not used

Foreground execution waits and returns the final assistant text. Background execution returns an OpenCode session ID or a Miwarang command-run ID. Pass an OpenCode ID as `sessionId` to `miwarang_wait` or `miwarang_cancel`; pass a command-run ID as `runId`.

OpenCode operations use the authenticated `opencode api` CLI. The extension does not store OpenCode credentials or construct OpenCode-specific request headers.

## Tracking background runs

Background runs are tracked directly by Miwarang without creating child OMO or
DAG watcher processes:

- The TUI footer status line shows active runs and runtime.
- `/miwarang` lists tracked runs with state, elapsed time, and target.
- `miwarang_wait` retrieves a terminal result by the returned `sessionId` or
  `runId`.
- `miwarang_cancel` requests cancellation using that same identifier.

The main agent can start multiple background delegations and wait for each
returned ID. There is no separate DAG watch process to become orphaned.

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
