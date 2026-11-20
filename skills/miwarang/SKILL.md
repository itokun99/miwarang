---
name: miwarang
description: Use when a host exposes Miwarang delegation tools and an agent needs to hand off a coding task, manage a background run, or delegate across harnesses while preserving the original constraints and validating the result.
license: MIT
metadata:
  author: itokun99
  version: "1.2.0"
---

# Miwarang delegation

Miwarang passes a complete task to a configured second-orchestrator harness.
Each harness owns its model and agent. Miwarang selects a backend from the
configured delegation chain; it never accepts a model or agent override.

## When to delegate

- The task benefits from a second agent and separate context.
- The caller can continue coordinating while the delegated task runs.
- The configured chain should handle provider outages through fallback.

Do not delegate a task that the host tool cannot reach. If the Miwarang tools
are unavailable, report that rather than claiming the task was delegated.

## Fast path

1. Preserve the complete task prompt, constraints, acceptance criteria, and
   absolute `cwd` when project scope matters.
2. Use foreground mode by default. Choose background only when asynchronous
   work is requested.
3. Omit `backend` normally so Miwarang follows its configured chain. Pass it
   only when the caller explicitly requires that configured harness; this
   bypasses the rest of the chain.
4. Never pass `model` or `agent`. The harness owns its model and the backend
   config owns its agent.
5. Validate the delegated result before reporting success. A result is
   evidence, not truth.

## Host tool surfaces

Senpi/OMO, the OpenCode V2 plugin, and the MCP server expose these tools:

- `miwarang_delegate({ prompt, mode?, backend?, cwd? })`
- `miwarang_wait({ runId, backend? })`
- `miwarang_cancel({ runId, backend? })`

The Pi and OMP extensions expose one `miwarang` tool. Set `action` to
`delegate`, `wait`, or `cancel`; when omitted, `prompt` selects delegate and
`runId` selects wait. Use `runId` from a background result for later wait or
cancel.

See the [parameter and result contract](references/parameter-contract.md) for
exact arguments and result fields.

## Foreground and background

Foreground calls return after the harness finishes. Result details include
the selected backend, state, mode, and fallback information when used.

For background work, retain the returned `runId` and call `miwarang_wait` or
`miwarang_cancel` with that same ID. Do not start duplicate work because the
first run is still active. In OMO/Senpi, `omoThreadId` links the delegated run
to the caller's thread so the main orchestrator can validate the result.

Read [lifecycle and troubleshooting](references/lifecycle-and-troubleshooting.md)
for terminal states, fallback behavior, and error recovery.

## Fallback behavior

Miwarang walks the configured `delegation` chain in order. Provider failures
such as quota exhaustion, rate limits, HTTP 429, and upstream session
failures advance to the next configured backend. Configuration errors,
invalid flags, and other non-provider failures stop immediately.

For background work, failover happens only before a backend returns a run ID.
After a run starts, use wait/cancel to observe its lifecycle; Miwarang does
not silently launch a duplicate on another backend.

## Install

The tool and this skill are distributed from the same repository:

```sh
npx skills add itokun99/miwarang --skill miwarang
```

List the available skills first with:

```sh
npx skills add itokun99/miwarang --list
```

To install the tool for a host, use `npx miwarang init` after the npm package
is published. From a source checkout, run `bun src/installer.ts init`.
Choose the host target in the installer; it installs the Senpi/OMO extension,
Pi extension, OpenCode plugin, or MCP configuration as appropriate.

If Miwarang is installed as an npm dependency, `npx skills experimental_sync`
can discover the packaged `skills/miwarang/SKILL.md`; npm skill sync is
experimental. For the skills.sh/GitHub path, use `npx skills add` above.

Read [installation and host adapters](references/installation-and-hosts.md)
for per-host installation and approval details.

## Host-specific permissions

- **OpenCode:** the plugin checks `miwarang_delegate` and `miwarang_cancel`
  through OpenCode's permission rules before starting those actions.
- **OMP:** the extension asks for interactive confirmation before delegate
  and cancel actions by default.
- **Pi:** extensions run with the Pi process's operating-system permissions.
- **Claude Code and other MCP hosts:** tool approval is controlled by the
  host's MCP permission settings.

Never put credentials, API keys, or private config values in a delegated
prompt. Keep secrets in the target harness's authenticated configuration.

## Configuration

The shared config is normally `~/.config/miwarang/config.json`; override it
with `MIWARANG_CONFIG`. Backend definitions and fallback ordering are
documented in [configuration](references/configuration.md).
