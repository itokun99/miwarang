import { Type } from "typebox";
import { formatRunTable } from "./watch.js";

export function registerRunTools(pi, { config, backends, store, tracker, syncStatus }) {
  pi.registerTool({
    name: "miwarang_wait",
    label: "Wait for delegated task",
    description: "Wait for delegated background work and return its final result.",
    parameters: Type.Union([
      Type.Object({
        sessionId: Type.String(),
        backend: Type.Optional(Type.String()),
      }),
      Type.Object({
        runId: Type.String(),
        backend: Type.Optional(Type.String()),
      }),
    ]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = delegatedId(params);
      const backendId = await backendForRun(config, id, params.backend, store);
      const result = await backends[backendId].wait(id);
      tracker.resolve(id, result.state ?? "completed");
      syncStatus(ctx);
      return {
        content: [{ type: "text", text: result.text || `Task state: ${result.state}.` }],
        details: { ...result, backend: backendId },
      };
    },
  });

  pi.registerTool({
    name: "miwarang_cancel",
    label: "Cancel delegated task",
    description: "Interrupt delegated background work by its returned ID.",
    parameters: Type.Union([
      Type.Object({
        sessionId: Type.String(),
        backend: Type.Optional(Type.String()),
      }),
      Type.Object({
        runId: Type.String(),
        backend: Type.Optional(Type.String()),
      }),
    ]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = delegatedId(params);
      const backendId = await backendForRun(config, id, params.backend, store);
      const result = await backends[backendId].cancel(id);
      tracker.resolve(id, result.state ?? "cancelled");
      syncStatus(ctx);
      return {
        content: [{ type: "text", text: `Cancellation state: ${result.state ?? result.interrupted}.` }],
        details: { ...result, backend: backendId },
      };
    },
  });

  pi.registerCommand("miwarang", {
    description: "Show the miwarang background runs tracked in this session",
    handler: async (_args, ctx) => {
      await tracker.refresh();
      syncStatus(ctx);
      ctx.ui.notify(formatRunTable(tracker.list()), "info");
    },
  });
}

export async function backendForRun(config, runId, requestedBackend, store) {
  if (requestedBackend) {
    if (!config.backends[requestedBackend]) {
      throw new Error(`Backend ${requestedBackend} is not configured`);
    }
    return requestedBackend;
  }
  if (runId.startsWith("run_")) {
    const record = store ? await store.get(runId).catch(() => undefined) : undefined;
    if (record && typeof record.backend === "string" && config.backends[record.backend]) {
      return record.backend;
    }
  }
  if (runId.startsWith("ses_")) {
    const entry = Object.entries(config.backends).find(([, backend]) => backend.type === "opencode-v2");
    if (entry) return entry[0];
  }
  if (runId.startsWith("run_")) {
    const entry = Object.entries(config.backends).find(([, backend]) => backend.type === "command");
    if (entry) return entry[0];
  }
  throw new Error(`Cannot determine backend for run ID ${runId}`);
}

function delegatedId(params) {
  const id = params.sessionId ?? params.runId;
  if (typeof id !== "string" || !id) {
    throw new Error("Provide a sessionId or runId returned by miwarang_delegate");
  }
  return id;
}
