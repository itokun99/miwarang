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

## OMO routing

The example routes these OMO targets through OpenCode:

| Target | Preferred free model |
| --- | --- |
| `category:quick` | `opencode/space-bunny-free` |
| `category:unspecified-low` | `opencode-go/longcat-2.5-preview-free` |
| `category:deep-low` | `opencode-go/step-5-preview-free` |
| `agent:explore` | `opencode-go/longcat-2.5-preview-free` |
| `agent:librarian` | `opencode-go/longcat-2.5-preview-free` |

When a native OMO `task` call targets one of these routes, the extension blocks that call and guides the parent agent to `miwarang_delegate`. Other native OMO task calls remain unchanged. `freeOnly` routes are checked against the current OpenCode model catalog, and configured model candidates are tried in order. An unavailable or paid-only route fails instead of silently selecting another model.

Set `model` or `agent` on `miwarang_delegate` to override the selected route for one task. OpenCode agent names must exist in the user's OpenCode configuration.

## Foreground and background work

Use `miwarang_delegate` with:

- `target`: a configured category or agent key, such as `category:quick` or `agent:explore`
- `prompt`: the delegated task
- `mode`: `foreground` (default) or `background`
- optional `model`, `agent`, `backend`, and `cwd` overrides

Foreground execution waits and returns the final assistant text. Background execution returns an OpenCode session ID or a Miwarang command-run ID. Pass an OpenCode ID as `sessionId` to `miwarang_wait` or `miwarang_cancel`; pass a command-run ID as `runId`.

OpenCode operations use the authenticated `opencode api` CLI. The extension does not store OpenCode credentials or construct OpenCode-specific request headers.

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
