import { resolveRoute, resolveTargetRoute } from "./config.js";

export function configuredCommandModels(route, modelOverride) {
  const ids = modelOverride ? [modelOverride] : route.models;
  return ids.map((id) => {
    const slash = id.indexOf("/");
    return slash < 1
      ? { providerID: "", id, cost: { input: 1, output: 1 } }
      : { providerID: id.slice(0, slash), id: id.slice(slash + 1), cost: { input: 1, output: 1 } };
  });
}

export async function executeDelegate(config, backends, request) {
  const { target, backend: backendOverride, model, agent, prompt, mode, cwd } = request;
  if (backendOverride !== undefined && !config.backends?.[backendOverride]) {
    throw new Error(`Backend ${backendOverride} is not configured`);
  }
  const resolved = resolveTargetRoute(config, target, { backend: backendOverride });
  const candidates = [resolved, ...(resolved.fallbacks ?? [])];
  const routeWith = (candidate, models) => ({
    ...config,
    routes: {
      [target]: {
        backend: candidate.backendName,
        models,
        agent: candidate.agent,
      },
    },
  });
  const selectCandidate = async (startIndex) => {
    let lastError;
    for (let index = startIndex; index < candidates.length; index += 1) {
      const candidate = candidates[index];
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
          route: { ...candidate, model: undefined, agent: undefined },
        };
      }

      const liveModels =
        (await backend.listModels?.()) ??
        configuredCommandModels(candidate, index === 0 ? model : undefined);
      try {
        const route = resolveRoute(routeWith(candidate, candidate.models), target, liveModels, {
          model: index === 0 ? model : undefined,
          agent: index === 0 ? agent : undefined,
        });
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
  if (!firstSelection.route) throw firstSelection.error;
  let selected = firstSelection;
  const requestFor = () => ({
    cwd,
    target,
    prompt,
    ...(selected.route.model === undefined ? {} : { model: selected.route.model }),
    ...(selected.route.agent === undefined ? {} : { agent: selected.route.agent }),
  });
  let result;
  if (mode === "background") {
    const tried = [];
    for (;;) {
      try {
        result = await selected.backend.start(requestFor());
        break;
      } catch (error) {
        tried.push(selected.route.model);
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
                selected.liveModels,
                { agent },
              ),
            };
            continue;
          } catch {
            // The live catalog can change between selection and execution.
          }
        }
        const next = await selectCandidate(selected.index + 1);
        if (!next.route) throw error;
        selected = next;
        tried.length = 0;
      }
    }
  } else {
    const tried = [];
    for (;;) {
      try {
        result = await selected.backend.runForeground(requestFor());
        break;
      } catch (error) {
        tried.push(selected.route.model);
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
                selected.liveModels,
                { agent },
              ),
            };
            continue;
          } catch {
            // The live catalog can change between selection and execution.
          }
        }
        const next = await selectCandidate(selected.index + 1);
        if (!next.route) throw error;
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

function isModelAvailabilityFailure(error) {
  return /^No configured model is available for/.test(String(error?.message ?? error));
}

function isProviderFailure(candidate, error) {
  const message = String(error?.message ?? error);
  if (candidate.backend?.type === "opencode-v2") {
    return (
      /^OpenCode session \S+ (?:failed:|returned no assistant text)/.test(message) ||
      /^OpenCode API \S+ \S+ failed \(exit \d+\)/.test(message)
    );
  }
  if (candidate.backend?.type !== "command") return false;
  return /(?:quota|rate limit|usage limit|5-hour|weekly limit|credits exhausted|429)/i.test(
    message,
  );
}

function resolvedVia(key, target) {
  if (key === "defaultRoute") return "default";
  if (key === target) return "exact";
  return "wildcard";
}
