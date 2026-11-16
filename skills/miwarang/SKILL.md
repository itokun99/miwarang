---
name: miwarang
description: "Delegate tasks through Miwarang's configured harnesses (OpenCode CLI, Command Code, Koma) via MCP instead of running them inline. Use when a task should be handed to a second-orchestrator coding agent, choosing foreground or background execution, handling backend fallbacks, or waiting for or cancelling delegated work."
version: 1.1.0
license: MIT
---

# Miwarang delegation via MCP

Miwarang is a unified, prompt-driven delegation seam. It hands a complete task
prompt to the next configured harness (OpenCode CLI, Command Code, Koma) while
each harness keeps ownership of its model and agent. Miwarang never selects a
model.

## When to use

- The task needs a second coding agent with its own context window.
- The caller should stay free to keep orchestrating while work runs.
- A harness-specific outage (quota, rate limit) should fail over to the next
  configured backend without re-planning.

## Tools

- `miwarang_delegate({ prompt, mode?, backend?, cwd? })` — required: `prompt`.
  `mode` defaults to `foreground`; use `background` only for async work.
  Omit `backend` to follow the configured `delegation` chain.
- `miwarang_wait({ runId, backend? })` — resolve a background run.
- `miwarang_cancel({ runId, backend? })` — cancel a background run.

## Rules

1. Preserve the original prompt, constraints, acceptance criteria, and `cwd`.
2. Never pass a model or agent override: those live in the Miwarang config.
3. Prefer the configured chain; pass `backend` only when the user names it.
4. After a background `miwarang_delegate`, keep the returned `runId` and use
   `miwarang_wait` (or `miwarang_cancel`) rather than starting duplicate work.
5. Validate the returned result before reporting success; a delegation result
   is evidence, not truth.

## Response envelope

Every delegate call returns a versioned envelope:

```json
{
  "version": 1,
  "state": "completed",
  "backend": "opencode",
  "resolvedVia": "primary",
  "mode": "foreground"
}
```

Background starts add `runId` (and `omoThreadId` when the host provides a
thread id). Wait and cancel return the terminal `state`, `exitCode`, and
`signal` when the backend recorded them.

## Connecting a host

Run the server over stdio:

```bash
MIWARANG_CONFIG=~/.config/miwarang/config.json bun /path/to/miwarang/src/mcp-server.ts
```

Claude Code example (`.mcp.json` inside a plugin or project):

```json
{
  "mcpServers": {
    "miwarang": {
      "command": "bun",
      "args": ["/path/to/miwarang/src/mcp-server.ts"]
    }
  }
}
```
