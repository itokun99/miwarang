import { Type } from "typebox";
import { formatRunTable } from "./watch.ts";
import type { RunTracker } from "./watch.ts";
import type { MiwarangConfig } from "./config.ts";
import type { RunStore } from "./runs/store.ts";

interface WaitCancelResult {
  text?: string;
  state?: string;
  interrupted?: unknown;
  [key: string]: unknown;
}

interface BackendLike {
  wait?: (id: string) => Promise<WaitCancelResult>;
  cancel?: (id: string) => Promise<WaitCancelResult>;
  [key: string]: any;
}

interface RunToolsOptions {
  config: MiwarangConfig;
  backends: Record<string, BackendLike>;
  store: RunStore;
  tracker: RunTracker;
  syncStatus: (ctx?: any) => void;
}

interface PiContext {
  ui?: { notify?: (message: string, level?: string) => void };
  sessionId?: string;
  [key: string]: unknown;
}

interface PiHost {
  registerTool(definition: unknown): void;
  registerCommand(name: string, definition: unknown): void;
}

type WaitCancelParams = { sessionId: string; backend?: string } | { runId: string; backend?: string };

export function registerRunTools(pi: PiHost, { config, backends, store, tracker, syncStatus }: RunToolsOptions): void {
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
    async execute(_toolCallId: string, params: WaitCancelParams, _signal: unknown, _onUpdate: unknown, ctx?: PiContext) {
      const id = delegatedId(params);
      const backendId = await backendForRun(config, id, params.backend, store);
      const backend = backends[backendId];
      if (!backend?.wait) throw new Error(`Backend ${backendId} does not support wait`);
      const result = await backend.wait(id);
      tracker.resolve(id, result.state ?? "completed");
      syncStatus(ctx);
      return {
        content: [{ type: "text", text: result.text || `Task state: ${result.state}.` }],
        details: { ...result, backend: backendId, omoThreadId: ctx?.sessionId },
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
    async execute(_toolCallId: string, params: WaitCancelParams, _signal: unknown, _onUpdate: unknown, ctx?: PiContext) {
      const id = delegatedId(params);
      const backendId = await backendForRun(config, id, params.backend, store);
      const backend = backends[backendId];
      if (!backend?.cancel) throw new Error(`Backend ${backendId} does not support cancel`);
      const result = await backend.cancel(id);
      tracker.resolve(id, result.state ?? "cancelled");
      syncStatus(ctx);
      return {
        content: [{ type: "text", text: `Cancellation state: ${result.state ?? result.interrupted}.` }],
        details: { ...result, backend: backendId, omoThreadId: ctx?.sessionId },
      };
    },
  });

  pi.registerCommand("miwarang", {
    description: "Show the miwarang background runs tracked in this session",
    handler: async (_args: unknown, ctx: PiContext) => {
      await tracker.refresh();
      syncStatus(ctx);
      ctx.ui?.notify?.(formatRunTable(tracker.list()), "info");
    },
  });
}

export async function backendForRun(
  config: MiwarangConfig,
  runId: string,
  requestedBackend: string | undefined,
  store: RunStore,
): Promise<string> {
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
  const order = Array.isArray(config.delegation) ? config.delegation : Object.keys(config.backends);
  if (!runId) {
    throw new Error(`Cannot determine backend for run ID ${runId}`);
  }
  const candidate = order.find((id) => config.backends[id as string]);
  if (candidate) return candidate;
  throw new Error(`Cannot determine backend for run ID ${runId}`);
}

function delegatedId(params: WaitCancelParams): string {
  const id = (params as { sessionId?: unknown }).sessionId ?? (params as { runId?: unknown }).runId;
  if (typeof id !== "string" || !id) {
    throw new Error("Provide a sessionId or runId returned by miwarang_delegate");
  }
  return id;
}
