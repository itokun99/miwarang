# Parameter and result contract

## Delegate

```ts
miwarang_delegate({
  prompt: string,
  mode?: "foreground" | "background",
  backend?: string,
  cwd?: string,
})
```

- `prompt` is required. Preserve the full task, constraints, and acceptance
  criteria.
- `mode` defaults to `foreground`.
- `backend` is optional. Omit it to follow the configured delegation chain.
  Setting it explicitly selects only that backend for this call.
- `cwd` is an optional absolute project directory.
- Do not pass `target`, `model`, or `agent`; these are not delegate inputs.

## Wait and cancel

Senpi/OMO, OpenCode, and MCP expose separate tools:

```ts
miwarang_wait({ runId: string, backend?: string })
miwarang_cancel({ runId: string, backend?: string })
```

Pi and OMP expose the same operations through their single `miwarang` tool:

```ts
{ action: "wait" | "cancel", runId: string, backend?: string }
```

Use the exact `runId` returned by a background delegate call. Do not invent
an ID or use a different run's ID.

## Result envelope

Delegate results include a versioned envelope in structured tool details:

```json
{
  "version": 1,
  "state": "completed",
  "backend": "opencode",
  "resolvedVia": "primary",
  "mode": "foreground",
  "exitCode": 0
}
```

The envelope may also include `runId`, `sessionId`, `signal`, `agent`,
`fallback`, `fallbackIndex`, and `omoThreadId`. A background start returns
the run/session ID and `state: "running"`. Wait and cancel return the
terminal state and backend exit/signal information when available.

The host may display the envelope as text instead of structured details. Do
not parse success from the text alone; inspect the state and validate the
delegated work in the workspace.
