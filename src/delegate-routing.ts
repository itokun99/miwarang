import { resolveTargetRoute } from "./config.ts";
import type { BackendConfig, MiwarangConfig } from "./config.ts";
import type { BackendAdapter } from "./backends/types.ts";
export type { BackendAdapter } from "./backends/types.ts";

export interface DelegateSelection {
  backendId: string;
  backend: BackendConfig;
  index: number;
  agent?: string;
  model?: string;
}

export interface DelegateRequest {
  target: string;
  prompt: string;
  mode: "foreground" | "background";
  backend?: string;
  model?: string;
  agent?: string;
  cwd?: string;
}

export interface DelegateResult {
  runId?: string;
  sessionId?: string;
  text?: string;
  state?: string;
  [key: string]: any;
}

interface BackendCandidate {
  backendId: string;
  backend: BackendConfig;
  index: number;
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
  const { target, backend: backendOverride, model, agent, prompt, mode, cwd } = request;
  if (backendOverride !== undefined && !config.backends?.[backendOverride]) {
    throw new Error(`Backend ${backendOverride} is not configured`);
  }
  const resolved = resolveTargetRoute(config, target, { backend: backendOverride });
  const candidates = buildBackendCandidates(resolved, config, backendOverride);
  if (!candidates.length) throw new Error(`No route configured for ${target}`);

  const first = candidates[0];
  if (!first) throw new Error(`No route configured for ${target}`);
  if (first.backend.type === "opencode-v2" && (model !== undefined || agent !== undefined)) {
    throw new Error(
      "OpenCode uses its configured default model; do not set model or agent for OpenCode.",
    );
  }
  let selected: DelegateSelection = {
    backendId: first.backendId,
    backend: first.backend,
    index: 0,
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
  };

  const requestFor = () => ({
    cwd,
    target,
    prompt,
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
  });

  const providerFailureCandidates = () =>
    selected.backend.type === "opencode-v2" || selected.backend.type === "command"
      ? candidates.slice(selected.index + 1)
      : [];

  let result: DelegateResult;
  const tried = new Set<string>([selected.backendId]);
  for (;;) {
    const adapter = backends[selected.backendId];
    if (!adapter) throw new Error(`Backend ${selected.backendId} is not configured`);
    try {
      result =
        mode === "background"
          ? await adapter.start(requestFor())
          : await adapter.runForeground(requestFor());
      break;
    } catch (error) {
      if (model !== undefined || !isProviderFailure(selected.backend, error)) throw error;
      const next = providerFailureCandidates().find(
        (candidate) => !tried.has(candidate.backendId),
      );
      if (!next) throw error;
      tried.add(next.backendId);
      selected = {
        backendId: next.backendId,
        backend: next.backend,
        index: next.index,
        ...(agent !== undefined ? { agent } : {}),
      };
    }
  }

  return {
    result,
    selected,
    resolvedVia: resolvedVia(resolved.key, target),
    mode,
  };
}

function buildBackendCandidates(
  resolved: ReturnType<typeof resolveTargetRoute>,
  config: MiwarangConfig,
  backendOverride: string | undefined,
): BackendCandidate[] {
  const primary: BackendCandidate = {
    backendId: resolved.backendName,
    backend: resolved.backend,
    index: 0,
  };
  const candidates = [primary];
  if (backendOverride === undefined && Array.isArray(resolved.fallbacks)) {
    for (const fallback of resolved.fallbacks) {
      const backend = config.backends?.[fallback.backendName];
      if (!backend) {
        throw new Error(
          `Backend ${fallback.backendName} configured for ${resolved.target} fallback does not exist`,
        );
      }
      candidates.push({
        backendId: fallback.backendName,
        backend,
        index: candidates.length,
      });
    }
  }
  return candidates;
}

function isProviderFailure(backend: BackendConfig, error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  if (backend?.type === "opencode-v2") {
    return (
      /^OpenCode session \S+ (?:failed:|returned no assistant text)/.test(message) ||
      /^OpenCode API \S+ \S+ failed \(exit \d+\)/.test(message)
    );
  }
  if (backend?.type !== "command" && backend?.type !== "koma-sdk") {
    return false;
  }
  return /(?:quota|rate limit|usage limit|5-hour|weekly limit|credits exhausted|429)/i.test(
    message,
  );
}

function resolvedVia(key: string, target: string): string {
  if (key === "defaultRoute") return "default";
  if (key === target) return "exact";
  return "wildcard";
}
