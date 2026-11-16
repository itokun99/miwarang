import type { BackendConfig, MiwarangConfig } from "./config.ts";
import type { BackendAdapter } from "./backends/types.ts";
export type { BackendAdapter } from "./backends/types.ts";

export interface DelegateSelection {
  backendId: string;
  backend: BackendConfig;
  index: number;
  agent?: string;
}

export interface DelegateRequest {
  prompt: string;
  mode: "foreground" | "background";
  backend?: string;
  cwd?: string;
}

export interface DelegateResult {
  runId?: string;
  sessionId?: string;
  text?: string;
  state?: string;
  [key: string]: any;
}

export async function executeDelegate(
  config: MiwarangConfig,
  backends: Record<string, BackendAdapter>,
  request: DelegateRequest,
): Promise<{
  result: DelegateResult;
  selected: DelegateSelection;
  resolvedVia: string;
  mode: string;
}> {
  const { prompt, backend: backendOverride, mode, cwd } = request;
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("Delegated task prompt must be a non-empty string");
  }
  const chain = backendOverride !== undefined ? [backendOverride] : config.delegation;
  if (backendOverride !== undefined && !config.backends?.[backendOverride]) {
    throw new Error(`Backend ${backendOverride} is not configured`);
  }
  if (!chain.length) throw new Error("No backends configured for delegation");

  let selected: DelegateSelection | undefined;
  let lastError: unknown;
  for (let index = 0; index < chain.length; index += 1) {
    const backendId = chain[index] as string;
    const backend = config.backends[backendId];
    const adapter = backends[backendId];
    if (!backend || !adapter) {
      throw new Error(`Backend ${backendId} is not configured`);
    }
    selected = {
      backendId,
      backend,
      index,
      ...(backend.agent !== undefined ? { agent: backend.agent } : {}),
    };
    const backendRequest = {
      cwd,
      prompt,
      ...(backend.agent !== undefined ? { agent: backend.agent } : {}),
    };
    try {
      const result =
        mode === "background" ? await adapter.start(backendRequest) : await adapter.runForeground(backendRequest);
      return {
        result,
        selected,
        resolvedVia: backendOverride !== undefined ? "override" : index === 0 ? "primary" : "fallback",
        mode,
      };
    } catch (error) {
      lastError = error;
      // No run was returned by this backend, so trying the next chain entry is
      // safe for foreground and background alike. Once a backend returns a run
      // ID, wait/cancel failures surface to the caller instead of retrying.
      if (!isProviderFailure(backend, error)) throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`All delegated backends failed${lastError ? `: ${String(lastError)}` : ""}`);
}

export function isProviderFailure(backend: BackendConfig, error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  if (backend.type === "opencode-cli") {
    return (
      /OpenCode session \S+ (?:failed|returned no assistant text)/i.test(message) ||
      /OpenCode API \S+ \S+ failed \(exit \d+\)/i.test(message) ||
      /(?:quota|rate limit|usage limit|5-hour|weekly limit|credits exhausted|429)/i.test(message)
    );
  }
  if (backend.type === "command") {
    return /(?:quota|rate limit|usage limit|5-hour|weekly limit|credits exhausted|429)/i.test(message);
  }
  return false;
}
