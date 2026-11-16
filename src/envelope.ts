// Versioned result envelope for miwarang_delegate: a caller can rely on the
// shape across backends even though each backend still owns its model and agent.
export const ENVELOPE_VERSION = 1;

export interface EnvelopeInput {
  result: {
    text?: string;
    state?: string;
    runId?: string;
    sessionId?: string;
    exitCode?: number;
    signal?: string | null;
    [key: string]: unknown;
  };
  backend: string;
  agent?: string;
  fallbackIndex?: number;
  resolvedVia: string;
  mode: string;
  omoThreadId?: string;
}

export function buildEnvelope({
  result,
  backend,
  agent,
  fallbackIndex,
  resolvedVia,
  mode,
  omoThreadId,
}: EnvelopeInput) {
  const state = result.state ?? (mode === "background" ? "running" : "completed");
  return {
    version: ENVELOPE_VERSION,
    state,
    backend,
    resolvedVia,
    mode,
    ...(result.runId !== undefined ? { runId: result.runId } : {}),
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(fallbackIndex !== undefined && fallbackIndex > 0 ? { fallback: true, fallbackIndex } : {}),
    ...(omoThreadId !== undefined ? { omoThreadId } : {}),
  };
}
