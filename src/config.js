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

export function resolveTargetRoute(config, target, { backend } = {}) {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("Target must be a non-empty string");
  }
  if (backend !== undefined && typeof backend !== "string") {
    throw new Error("Backend override must be a string");
  }

  const routes = config?.routes;
  const keys = [target];
  if (target.startsWith("category:")) keys.push("category:*");
  else if (target.startsWith("agent:")) keys.push("agent:*");

  let route;
  let key;
  for (const candidate of keys) {
    if (routes && typeof routes === "object" && routes[candidate]) {
      route = routes[candidate];
      key = candidate;
      break;
    }
  }
  if (
    !route &&
    config?.defaultRoute &&
    typeof config.defaultRoute === "object" &&
    !Array.isArray(config.defaultRoute)
  ) {
    route = config.defaultRoute;
    key = "defaultRoute";
  }
  if (!route) throw new Error(`No route configured for ${target}`);

  const backendName = backend ?? route.backend;
  const backendObj = config?.backends?.[backendName];
  if (!backendObj) {
    throw new Error(`Backend ${backendName} configured for ${target} does not exist`);
  }

  return {
    ...route,
    backend: backendObj,
    backendName,
    target,
    key,
  };
}

const PRICE_POLICIES = ["free-only", "free-first", "any"];

function validateRouteShape(name, route) {
  if (!route || typeof route.backend !== "string") {
    throw new Error(`Route ${name} must name a backend`);
  }
  if (!Array.isArray(route.models) || route.models.some((model) => typeof model !== "string")) {
    throw new Error(`Route ${name} must define a models string array`);
  }
  if (route.blockNativeTask !== undefined) {
    validateBlockNativeTask(route.blockNativeTask, `Route ${name}`);
  }
}

function validateBlockNativeTask(value, where) {
  if (typeof value === "boolean" || value === "all") return;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return;
  throw new Error(`${where} blockNativeTask must be a boolean, "all", or a string array`);
}

export function validateConfig(config) {
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
    validateRouteShape(target, route);
  }

  if (config.defaultRoute !== undefined) {
    if (
      !config.defaultRoute ||
      typeof config.defaultRoute !== "object" ||
      Array.isArray(config.defaultRoute)
    ) {
      throw new Error("defaultRoute must be a route object");
    }
    validateRouteShape("defaultRoute", config.defaultRoute);
  }

  if (config.blockNativeTask !== undefined) {
    validateBlockNativeTask(config.blockNativeTask, "Top-level");
    if (config.blockNativeTask === "all") {
      const hasWildcard = Object.keys(config.routes).some(
        (name) => name === "category:*" || name === "agent:*",
      );
      if (!hasWildcard && !config.defaultRoute) {
        throw new Error(
          `blockNativeTask "all" requires a wildcard route (category:* or agent:*) ` +
            `or defaultRoute so every target is covered`,
        );
      }
    }
  }

  if (config.pricePolicy !== undefined && !PRICE_POLICIES.includes(config.pricePolicy)) {
    throw new Error(`pricePolicy must be one of: ${PRICE_POLICIES.join(", ")}`);
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
