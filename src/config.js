import { readFile } from "node:fs/promises";

export async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, "utf8"));
  validateConfig(config);
  return config;
}

export function resolveRoute(config, target, liveModels, overrides = {}) {
  const route = config.routes?.[target];
  if (!route) throw new Error(`No route configured for ${target}`);

  const backend = config.backends?.[route.backend];
  if (!backend) {
    throw new Error(`Backend ${route.backend} configured for ${target} does not exist`);
  }

  const candidates = overrides.model ? [overrides.model] : route.models ?? [];
  for (const modelId of candidates) {
    const model = liveModels.find((candidate) => modelIdFor(candidate) === modelId);
    if (!model) {
      if (overrides.model) {
        throw new Error(`Requested model ${modelId} is not in the live model catalog`);
      }
      continue;
    }
    if (route.freeOnly && !isFree(model)) {
      if (overrides.model) {
        throw new Error(`Requested model ${modelId} is not free for ${target}`);
      }
      continue;
    }

    const result = {
      backend,
      target,
      model: modelId,
      freeOnly: route.freeOnly === true,
    };
    const agent = overrides.agent ?? route.agent;
    if (agent) result.agent = agent;
    return result;
  }

  if (route.freeOnly) {
    const availability = candidates
      .map((modelId) => {
        const model = liveModels.find((candidate) => modelIdFor(candidate) === modelId);
        if (!model) return `${modelId}: unavailable`;
        return `${modelId}: ${isFree(model) ? "free" : "not free"}`;
      })
      .join(", ");
    throw new Error(
      `No available free model is configured for ${target} ` +
        `(catalog: ${liveModels.length}; candidates: ${availability})`,
    );
  }
  throw new Error(`No configured model is available for ${target}`);
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Miwarang config must be a JSON object");
  }
  if (!config.backends || typeof config.backends !== "object" || Array.isArray(config.backends)) {
    throw new Error("Miwarang config must define a backends object");
  }
  if (!config.routes || typeof config.routes !== "object" || Array.isArray(config.routes)) {
    throw new Error("Miwarang config must define a routes object");
  }

  for (const [target, route] of Object.entries(config.routes)) {
    if (!route || typeof route.backend !== "string") {
      throw new Error(`Route ${target} must name a backend`);
    }
    if (!Array.isArray(route.models) || route.models.some((model) => typeof model !== "string")) {
      throw new Error(`Route ${target} must define a models string array`);
    }
  }
}

function modelIdFor(model) {
  if (!model || typeof model.providerID !== "string" || typeof model.id !== "string") return "";
  return `${model.providerID}/${model.id}`;
}

function isFree(model) {
  const tiers = Array.isArray(model.cost) ? model.cost : [model.cost];
  return (
    tiers.length > 0 &&
    tiers.every(
      (tier) =>
        (tier?.input === 0 || tier?.input === "0") &&
        (tier?.output === 0 || tier?.output === "0"),
    )
  );
}
