# Miwarang Delegate

Miwarang is a unified, prompt-driven delegation tool. It hands a complete task prompt to configured second-orchestrator harnesses — OpenCode CLI, Command Code, Koma, or any command-line agent — while every harness keeps owning its model and agent. Miwarang never selects a model and never runs an agent itself.

It ships in three shapes backed by one core: a Senpi/OMO extension, an OpenCode V2 plugin, Pi/OMP extensions, and a stdio MCP server that any MCP-speaking host (Claude Code, Cursor, OpenCode, …) can call.

## Install

One npm package, one command — the installer asks which host you use and wires the right artifact:

```sh
npx miwarang init
```

| You use | Installer does |
|---|---|
| OMO / Senpi | copies the extension into `~/.omo/agent/extensions/miwarang/` and seeds `~/.config/miwarang/config.json` from the example when none exists |
| Pi | copies the extension into `~/.pi/agent/extensions/miwarang.js` |
| OpenCode | copies the plugin into `.opencode/plugins/miwarang/` (or `~/.config/opencode/plugins/` with `--global`) |
| Claude Code | registers the MCP server in the project `.mcp.json` and `~/.claude/claude.json` |
| Other MCP host | prints a ready-to-paste `mcpServers` snippet |

Non-interactive equivalents:

```sh
npx miwarang init --target senpi
npx miwarang init --target pi
npx miwarang init --target opencode --global
npx miwarang init --target claude-code
npx miwarang init --target mcp
npx miwarang uninstall --target senpi
```

Set `MIWARANG_CONFIG` to use a different config file; without it the extension and MCP server read `~/.config/miwarang/config.json`.

## Requirements

- Bun 1.4 or later
- At least one configured harness: OpenCode CLI, Command Code, Koma, or any command-line agent
- For the Senpi/OMO extension: Senpi 5.1.30 or later

## Install from source

Clone the repository and run the installer from the checkout:

```sh
git clone https://github.com/itokun99/miwarang.git
cd miwarang
bun install
bun src/installer.ts init
```

The extension is written in TypeScript and executed directly by Bun; a thin `src/extension.js` shim keeps the installed wrapper working without changes. Restart Senpi or run `/reload` to load the extension. Once the global wrapper exists, start Senpi normally; do not also pass `-e` for the same extension or Senpi will register its tools twice. Before installing the wrapper, a one-off test can use:

```sh
senpi -e ~/Projects/miwarang/src/extension.ts
```

## MCP server

Run the server directly for any MCP host:

```sh
MIWARANG_CONFIG=~/.config/miwarang/config.json bun src/mcp-server.ts
```

The server exposes `miwarang_delegate`, `miwarang_wait`, and `miwarang_cancel`; every result carries the versioned envelope documented in `skills/miwarang/SKILL.md`.

## Delegation skill

`skills/miwarang/SKILL.md` is the companion skill: when to delegate, the tool contract, the response envelope, and host wiring recipes.

## How delegation works

1. The calling agent invokes `miwarang_delegate` with a `prompt` (plus optional `mode`, `backend`, `cwd`).
2. Miwarang walks the configured `delegation` chain in order and hands the prompt to the first available backend.
3. The backend harness (OpenCode CLI, Command Code, Koma, …) executes the task with its own configured model and agent.
4. The result returns to the caller, which validates it.

There are no routes and no targets: the prompt is the contract. If a backend fails with a provider error (quota, rate limit, upstream session failure), Miwarang continues to the next backend in the chain for foreground work and for background work before a run ID is returned. Once a background run has started, failures surface through `miwarang_wait` instead of being retried silently.

### Per-backend agents

Each backend can name the agent its harness should run, via the backend's own `agent` config field. For example, OpenCode can delegate to an `Orchestrator` agent while Command Code delegates to its `General` agent. Miwarang passes that agent through (`--agent {{agent}}` for OpenCode) and never overrides a harness's model.

## Tools

- `miwarang_delegate({ prompt, mode?, backend?, cwd? })` — delegate a task. `mode` is `foreground` (default) or `background`. `backend` overrides the chain order for an intentional harness choice; it must name a configured backend.
- `miwarang_wait({ sessionId | runId, backend? })` — wait for a background run and return its terminal result.
- `miwarang_cancel({ sessionId | runId, backend? })` — interrupt a background run.
- `/miwarang` — list the background runs tracked in the current session.

Background runs carry the caller's thread/session identity (`omoThreadId`) alongside the backend run/session ID, so the main orchestrator can correlate and validate results.

## Configuration

```jsonc
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
      "args": ["-p", "--no-session", "--yolo", "--max-turns", "200", "--tools-enable", "agent,agent_output", "-t"],
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

- `backends` — map of backend id to its config. `type` is one of `opencode-cli`, `command`, or `koma-sdk`.
- `delegation` — ordered chain of backend ids; the first available backend wins, later entries act as fallbacks.
- `agent` (per backend) — the harness agent Miwarang delegates to. It is passed through `{{agent}}` in the backend's args when present; Koma owns its agent internally.
- `runsDirectory` — where background command/koma run records are stored.

### Backend types

- `opencode-cli` — runs `opencode run` (the supported glm-5.3-flashmation path per [opencode.ai/docs](https://opencode.ai/docs/cli)). The OpenCode harness supplies its configured model; Miwarang only passes the configured agent. The old experimental `opencode-v2` SDK backend was removed in v0.9.0.
- `command` — any executable plus an argv array. Placeholders: `{{agent}}` and `{{cwd}}`. `promptInput` is `argument` (append the prompt as one argument) or `stdin` (default; write the prompt to stdin). Commands run without a shell; prompts are never interpolated into a command string.
- `koma-sdk` — speaks Koma's SDK stdio adapter (`koma sdk serve`), a JSON Lines protocol (`hello`, `create`, `submit`, `state` events, `interrupt`, `detach`). Koma's headless `koma run` prints only session metadata, so the SDK adapter is the supported path. Koma owns its model and agent; Miwarang sends only the prompt, cwd, and policy (default `{ "plan": "forbid", "approval": "reject" }`).

### Migrating from v0.8.x

The v0.8 keys `routes`, `defaultRoute`, `defaultModels`, `pricePolicy`, `defaultBackend`, and `blockNativeTask`, and the `opencode-v2` backend type, were removed. Miwarang rejects configs containing them with a message naming the replacement. Move the preferred backend to the front of `delegation`, put per-harness agents on each backend, and delete route/model lists — the harnesses own model choice now.

### Command Code recipe

```json
"commandcode": {
  "type": "command",
  "command": "commandcode",
  "args": ["-p", "--no-session", "--yolo", "--max-turns", "200", "--tools-enable", "agent,agent_output", "-t"],
  "promptInput": "argument",
  "timeoutMs": 900000,
  "agent": "General"
}
```

Command Code print mode uses its built-in General agent unless the harness is configured otherwise. `--tools-enable agent,agent_output` lets General delegate to the agents registered in that Command Code installation. `--yolo` is required: print mode denies file writes and shell by default, so without it the harness cannot perform edits or run tools. With `--yolo`, commandcode glm-5.3-flash-approves every tool call — scope each delegation with an explicit `cwd` and prefer dedicated worktrees for risky edits.

## Tracking background runs

Background runs are tracked directly by Miwarang without creating child OMO or DAG watcher processes:

- The TUI footer status line shows active runs and runtime.
- `/miwarang` lists tracked runs with state, elapsed time, and backend.
- `miwarang_wait` retrieves a terminal result by the returned `runId`.
- `miwarang_cancel` requests cancellation using that same identifier.

The main agent can start multiple background delegations and wait for each returned ID. There is no separate DAG watch process to become orphaned.

Command-run metadata is stored under `~/.local/state/miwarang/runs` by default, or under `runsDirectory` in the config. Prompts and environment variables are not saved in run records.

## License

Miwarang Delegate is distributed under the MIT License. See [LICENSE](LICENSE).

## Development

```sh
bun test
bunx tsc --noEmit
bun src/installer.ts init --target senpi   # or another target
senpi -e ./src/extension.ts --list-models
```

The test suite covers the delegation chain, failover, per-backend agent passthrough, config validation and migration errors, the command and koma adapters, run tracking, the wait/cancel lifecycle, the MCP server, the host integrations, and the installer.
