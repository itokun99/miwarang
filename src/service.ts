import { executeDelegate } from "./delegate-routing.ts";
import { buildEnvelope } from "./envelope.ts";
import type { MiwarangConfig } from "./config.ts";
import type { BackendAdapter, DelegateRequest } from "./delegate-routing.ts";
import type { RunTracker, TrackedRun } from "./watch.ts";
import type { StreamSink } from "./stream.ts";
import { backendForRun } from "./run-tools.ts";

export interface MiwarangServiceOptions {
  config: MiwarangConfig;
  backends: Record<string, BackendAdapter>;
  tracker: RunTracker;
  store: import("./runs/store.ts").RunStore;
  onRunTracked?: (run: TrackedRun) => void;
}

export interface ServiceCallContext {
  cwd?: string;
  sessionId?: string;
}

export type ServiceResult = {
  text: string;
  details: Record<string, unknown>;
};

export type MiwarangService = {
  delegate(input: {
    prompt: string;
    mode?: "foreground" | "background";
    backend?: string;
    cwd?: string;
    onUpdate?: StreamSink;
  }, ctx?: ServiceCallContext): Promise<ServiceResult>;
  wait(input: { runId?: string; sessionId?: string; backend?: string }, ctx?: ServiceCallContext): Promise<ServiceResult>;
  cancel(input: { runId?: string; sessionId?: string; backend?: string }, ctx?: ServiceCallContext): Promise<ServiceResult>;
};

function serviceId(input: { runId?: string; sessionId?: string }): string {
  const id = input.sessionId ?? input.runId;
  if (typeof id !== "string" || !id) {
    throw new Error("Provide a sessionId or runId returned by miwarang_delegate");
  }
  return id;
}

export function createMiwarangService({
  config,
  backends,
  tracker,
  store,
  onRunTracked,
}: MiwarangServiceOptions): MiwarangService {
  return {
    async delegate(input, ctx = {}) {
      const execution = await executeDelegate(config, backends, {
        prompt: input.prompt,
        mode: input.mode ?? "foreground",
        backend: input.backend,
        cwd: input.cwd ?? ctx.cwd ?? process.cwd(),
        onUpdate: input.onUpdate,
      } as DelegateRequest);
      const { result, selected, mode, resolvedVia } = execution;
      const envelope = buildEnvelope({
        result,
        backend: selected.backendId,
        agent: selected.agent,
        fallbackIndex: selected.index,
        resolvedVia,
        mode,
      });
      if (mode === "background") {
        const id = result.sessionId ?? result.runId;
        const run: TrackedRun = {
          id: id as string,
          backend: selected.backendId,
          backendType: selected.backend.type,
          startedAt: Date.now(),
          ...(ctx.sessionId !== undefined ? { omoThreadId: ctx.sessionId } : {}),
        } as TrackedRun;
        tracker.track(run);
        onRunTracked?.(run);
        return {
          text: `Started background delegation (${id}).`,
          details: {
            ...envelope,
            ...(ctx.sessionId !== undefined ? { omoThreadId: ctx.sessionId } : {}),
          },
        };
      }
      return { text: result.text ?? "", details: envelope };
    },

    async wait(input, ctx = {}) {
      const id = serviceId(input);
      const backendId = await backendForRun(config, id, input.backend, store);
      const backend = backends[backendId];
      if (!backend?.wait) throw new Error(`Backend ${backendId} does not support wait`);
      const result = await backend.wait(id);
      tracker.resolve(id, result.state ?? "completed");
      return {
        text: result.text || `Task state: ${result.state}.`,
        details: { ...result, backend: backendId, omoThreadId: ctx.sessionId },
      };
    },

    async cancel(input, ctx = {}) {
      const id = serviceId(input);
      const backendId = await backendForRun(config, id, input.backend, store);
      const backend = backends[backendId];
      if (!backend?.cancel) throw new Error(`Backend ${backendId} does not support cancel`);
      const result = await backend.cancel(id);
      tracker.resolve(id, result.state ?? "cancelled");
      return {
        text: `Cancellation state: ${result.state ?? result.interrupted}.`,
        details: { ...result, backend: backendId, omoThreadId: ctx.sessionId },
      };
    },
  };
}
