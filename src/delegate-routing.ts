import { resolveRoute, resolveTargetRoute } from "./config.ts";
import type { BackendConfig, LiveModel, MiwarangConfig, ResolvedRoute, RouteConfig } from "./config.ts";
import type { BackendAdapter } from "./backends/types.ts";
export type { BackendAdapter } from "./backends/types.ts";

export type SelectionRoute = {
  backend: BackendConfig;
  target: string;
  model?: string;
  agent?: string;
  [key: string]: unknown;
};

export interface DelegateBackend {
  backend: BackendAdapter;
  backendId: string;
  candidate: ResolvedRoute;
  index: number;
  liveModels?: LiveModel[];
  route: SelectionRoute;
}

export interface DelegateFailure {
  error: unknown;
}

export type DelegateSelection = DelegateBackend | DelegateFailure;

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
  [key: string]: unknown;
}

export function configuredCommandModels(route: ResolvedRoute, modelOverride?: string): LiveModel[] {
  const ids = modelOverride ? [modelOverride] : route.models;
  return ids.map((id) => {
    const slash = id.indexOf("/");
    return slash < 1
      ? { providerID: "", id, cost: { input: 1, output: 1 } }
      : { providerID: id.slice(0, slash), id: id.slice(slash + 1), cost: { input: 1, output: 1 } };
  });
}

export async function executeDelegate(
  config: MiwarangConfig,
  backends: Record<string, BackendAdapter>,
  request: DelegateRequest,
): Promise<{ result: DelegateResult; selected: DelegateBackend; resolvedVia: string; mode: string }> {
  const { target, backend: backendOverride, model, agent, prompt, mode, cwd } = request;
  if (backendOverride !== undefined && !config.backends?.[backendOverride]) {
    throw new Error(`Backend ${backendOverride} is not configured`);
  }
  const resolved = resolveTargetRoute(config, target, { backend: backendOverride });
  const candidates: ResolvedRoute[] = [resolved, ...(resolved.fallbacks ?? [])];
  const routeWith = (candidate: ResolvedRoute, models: string[]): MiwarangConfig => ({
    ...config,
    routes: {
      [target]: {
        backend: candidate.backendName,
        models,
        agent: candidate.agent,
      } as RouteConfig,
    },
  });
  const selectCandidate = async (startIndex: number): Promise<DelegateSelection> => {
    let lastError: unknown;
    for (let index = startIndex; index < candidates.length; index += 1) {
      const candidate = candidates[index] as ResolvedRoute;
      const backend = backends[candidate.backendName];
      if (!backend) throw new Error(`Backend ${candidate.backendName} is not configured`);

      if (candidate.backend.type === "opencode-v2") {
        if (index === 0 && (model !== undefined || agent !== undefined)) {
          throw new Error(
            "OpenCode uses its configured default model and orchestrator agent; omit model and agent overrides",
          );
        }
        return {
          backend,
          backendId: candidate.backendName,
          candidate,
          index,
          liveModels: undefined,
          route: { ...candidate, model: undefined, agent: undefined } as unknown as SelectionRoute,
        };
      }

      const liveModels: LiveModel[] =
        (await backend.listModels?.()) ??
        configuredCommandModels(candidate, index === 0 ? model : undefined);
      try {
        const route = resolveRoute(routeWith(candidate, candidate.models), target, liveModels, {
          model: index === 0 ? model : undefined,
          agent: index === 0 ? agent : undefined,
        }) as unknown as SelectionRoute;
        return { backend, backendId: candidate.backendName, candidate, index, liveModels, route };
      } catch (error) {
        if (
          !isModelAvailabilityFailure(error) ||
          (index === 0 && model !== undefined)
        ) {
          throw error;
        }
        lastError = error;
      }
    }
    return { error: lastError };
  };

  const firstSelection = await selectCandidate(0);
  if (!isDelegateBackend(firstSelection)) throw firstSelection.error;
  let selected: DelegateBackend = firstSelection;
  const requestFor = () => ({
    cwd,
    target,
    prompt,
    ...(selected.route.model === undefined ? {} : { model: selected.route.model }),
    ...(selected.route.agent === undefined ? {} : { agent: selected.route.agent }),
  });
  let result: DelegateResult;
  if (mode === "background") {
    const tried: (string | undefined)[] = [];
    for (;;) {
      try {
        result = await selected.backend.start(requestFor());
        break;
      } catch (error) {
        tried.push(selected.route.model as string | undefined);
        if (
          model !== undefined ||
          !isProviderFailure(selected.candidate, error)
        ) {
          throw error;
        }
        const remaining =
          selected.candidate.backend.type === "opencode-v2"
            ? []
            : selected.candidate.models.filter((candidateModel) => !tried.includes(candidateModel));
        if (remaining.length) {
          try {
            selected = {
              ...selected,
              route: resolveRoute(
                routeWith(selected.candidate, remaining),
                target,
                selected.liveModels ?? [],
                { agent },
              ) as unknown as SelectionRoute,
            };
            continue;
          } catch {
            // The live catalog can change between selection and execution.
          }
        }
        const next = await selectCandidate(selected.index + 1);
        if (!isDelegateBackend(next)) throw error;
        selected = next;
        tried.length = 0;
      }
    }
  } else {
    const tried: (string | undefined)[] = [];
    for (;;) {
      try {
        result = await selected.backend.runForeground(requestFor());
        break;
      } catch (error) {
        tried.push(selected.route.model as string | undefined);
        if (
          model !== undefined ||
          !isProviderFailure(selected.candidate, error)
        ) {
          throw error;
        }
        const remaining =
          selected.candidate.backend.type === "opencode-v2"
            ? []
            : selected.candidate.models.filter((candidateModel) => !tried.includes(candidateModel));
        if (remaining.length) {
          try {
            selected = {
              ...selected,
              route: resolveRoute(
                routeWith(selected.candidate, remaining),
                target,
                selected.liveModels ?? [],
                { agent },
              ) as unknown as SelectionRoute,
            };
            continue;
          } catch {
            // The live catalog can change between selection and execution.
          }
        }
        const next = await selectCandidate(selected.index + 1);
        if (!isDelegateBackend(next)) throw error;
        selected = next;
        tried.length = 0;
      }
    }
  }
  return {
    result,
    selected,
    resolvedVia: resolvedVia(resolved.key, target),
    mode,
  };
}

function isDelegateBackend(selection: DelegateSelection): selection is DelegateBackend {
  return (selection as DelegateBackend).route !== undefined;
}

function isModelAvailabilityFailure(error: unknown): boolean {
  return /^No configured model is available for/.test(String((error as Error)?.message ?? error));
}

function isProviderFailure(candidate: ResolvedRoute, error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  if (candidate.backend?.type === "opencode-v2") {
    return (
      /^OpenCode session \S+ (?:failed:|returned no assistant text)/.test(message) ||
      /^OpenCode API \S+ \S+ failed \(exit \d+\)/.test(message)
    );
  }
  if (candidate.backend?.type !== "command" && candidate.backend?.type !== "koma-sdk") {
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
