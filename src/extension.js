import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveRoute, resolveTargetRoute } from "./config.js";
import { createCommandBackend } from "./backends/command.js";
import { createOpenCodeBackend } from "./backends/opencode.js";
import { RunStore } from "./runs/store.js";

export default async function miwarangExtension(pi) {
  const configPath =
    process.env.MIWARANG_CONFIG ?? join(homedir(), ".config/miwarang/config.json");
  const config = await loadConfig(configPath);
  setupExtension(pi, { config });
}

export function setupExtension(pi, { config, backends: injectedBackends, runStore } = {}) {
  const store = runStore ?? new RunStore({ directory: config.runsDirectory });
  const backends = injectedBackends ?? createBackends(config, store);

  pi.registerTool({
    name: "miwarang_delegate",
    label: "Delegate task",
    description:
      "Delegate a foreground or background task to the configured agent backend and model.",
    promptSnippet:
      "Delegate eligible OMO category and agent tasks through the configured Miwarang backend.",
    promptGuidelines: [
      "Use miwarang_delegate instead of native task for these targets: " +
        "category:quick, category:unspecified-low, category:unspecified-high, " +
        "category:deep-low, category:deep-high, category:ultrabrain, category:artistry, " +
        "category:architect, category:writing, and category:visual-engineering, plus " +
        "agent:explore, agent:librarian, agent:plan-consultant, agent:plan-reviewer, " +
        "agent:omo-native-code-reviewer, agent:omo-native-gate-reviewer, and " +
        "agent:omo-native-qa-executor. Routes resolve exact key first, then the " +
        "category:* or agent:* wildcard, then defaultRoute. Pass the full target " +
        "prefix, preserve the task prompt, and map run_in_background to mode background.",
      "Use miwarang_wait or miwarang_cancel with the returned session or run ID for background work.",
    ],
    parameters: Type.Object({
      target: Type.String(),
      prompt: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal("foreground"), Type.Literal("background")])),
      backend: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      agent: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = normalizeTarget(params.target);
      if (params.backend !== undefined && !config.backends?.[params.backend]) {
        throw new Error(`Backend ${params.backend} is not configured`);
      }
      const resolved = resolveTargetRoute(config, target, { backend: params.backend });
      const backendId = resolved.backendName;
      const backend = backends[backendId];
      if (!backend) throw new Error(`Backend ${backendId} is not configured`);

      const liveModels =
        resolved.backend.type === "opencode-v2"
          ? await backend.listModels()
          : configuredCommandModels(resolved, params.model);
      const route = resolveRoute(
        {
          ...config,
          routes: { ...config.routes, [target]: modelSelectionRoute(resolved) },
        },
        target,
        liveModels,
        { model: params.model, agent: params.agent },
      );
      const request = {
        cwd: params.cwd ?? ctx?.cwd ?? pi.cwd ?? process.cwd(),
        target,
        model: route.model,
        agent: route.agent,
        prompt: params.prompt,
      };
      const mode = params.mode ?? "foreground";
      const result =
        mode === "background"
          ? await backend.start(request)
          : await backend.runForeground(request);
      const resolvedViaValue = resolvedVia(resolved.key, target);

      if (mode === "background") {
        const id = result.sessionId ?? result.runId;
        return {
          content: [{ type: "text", text: `Started ${target} in background (${id}).` }],
          details: {
            ...result,
            backend: backendId,
            resolvedVia: resolvedViaValue,
            model: route.model,
            target,
          },
        };
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          sessionId: result.sessionId,
          backend: backendId,
          resolvedVia: resolvedViaValue,
          model: route.model,
          target,
        },
      };
    },
  });

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
    async execute(_toolCallId, params) {
      const id = delegatedId(params);
      const backendId = await backendForRun(config, id, params.backend, store);
      const result = await backends[backendId].wait(id);
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
    async execute(_toolCallId, params) {
      const id = delegatedId(params);
      const backendId = await backendForRun(config, id, params.backend, store);
      const result = await backends[backendId].cancel(id);
      return {
        content: [{ type: "text", text: `Cancellation state: ${result.state ?? result.interrupted}.` }],
        details: { ...result, backend: backendId },
      };
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "task") return;
    const blocked = taskTargets(event.input).filter((target) =>
      shouldBlockNativeTask(config, target),
    );
    if (!blocked.length) return;

    const names = blocked.join(", ");
    return {
      block: true,
      reason:
        `OMO target ${names} is configured for Miwarang delegation. ` +
        "Call miwarang_delegate with the same prompt and target; use mode background " +
        "when run_in_background is true, then track the returned ID with miwarang_wait or miwarang_cancel.",
    };
  });
}

function createBackends(config, store = new RunStore({ directory: config.runsDirectory })) {
  const backends = {};
  for (const [id, backend] of Object.entries(config.backends)) {
    if (backend.type === "opencode-v2") {
      backends[id] = createOpenCodeBackend({ command: backend.command });
    } else if (backend.type === "command") {
      backends[id] = createCommandBackend({ ...backend, id }, { runStore: store });
    } else {
      throw new Error(`Unknown backend type ${backend.type} for ${id}`);
    }
  }
  return backends;
}

// Effective price policy: the route-level value wins over the backend-level
// one; both default to "any".
function effectivePricePolicy(route) {
  return route.pricePolicy ?? route.backend?.pricePolicy ?? "any";
}

// The route handed to resolveRoute. A command backend has no live catalog, so
// when the effective pricePolicy is "any" the freeOnly constraint cannot be
// enforced there; dropping it lets the command candidates through. opencode-v2
// keeps its catalog-backed freeOnly gate unchanged.
function modelSelectionRoute(resolved) {
  const pricePolicy = effectivePricePolicy(resolved);
  const commandBackend = resolved.backend?.type === "command";
  const freeOnly = resolved.freeOnly && !(commandBackend && pricePolicy === "any");
  return {
    backend: resolved.backendName,
    models: resolved.models,
    freeOnly,
    agent: resolved.agent,
  };
}

function resolvedVia(key, target) {
  if (key === "defaultRoute") return "default";
  if (key === target) return "exact";
  return "wildcard";
}

// Command backends have no live model catalog, so a freeOnly route only
// reaches one when the effective pricePolicy allows any model. The route-level
// pricePolicy wins over the backend-level one; both default to "any".
export function configuredCommandModels(route, modelOverride) {
  const ids = modelOverride ? [modelOverride] : route.models;
  const pricePolicy = effectivePricePolicy(route);
  if (route.freeOnly && pricePolicy === "freeOnly") {
    throw new Error("freeOnly routes require a backend with a live model catalog");
  }
  return ids.map((id) => {
    const slash = id.indexOf("/");
    return slash < 1
      ? { providerID: "command", id, cost: { input: 1, output: 1 } }
      : { providerID: id.slice(0, slash), id: id.slice(slash + 1), cost: { input: 1, output: 1 } };
  });
}

// Resolve which backend owns a delegated ID. An explicit `backend` parameter
// wins; otherwise a `run_` ID is looked up in the run store (command backends
// record their own id there), and only when no record is found does the legacy
// id-prefix heuristic apply. The heuristic is deliberately unchanged so
// pre-existing runs keep resolving.
export async function backendForRun(config, runId, requestedBackend, store) {
  if (requestedBackend) {
    if (!config.backends[requestedBackend]) throw new Error(`Backend ${requestedBackend} is not configured`);
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

function taskTargets(input) {
  if (!input || typeof input !== "object") return [];
  const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
  return tasks.flatMap((task) => {
    if (typeof task.category === "string") return [`category:${task.category}`];
    if (typeof task.subagent_type === "string") return [`agent:${task.subagent_type}`];
    return [];
  });
}

// Native-task interception policy. The effective route is resolved first; an
// explicit per-route blockNativeTask wins over the top-level flag, which
// defaults to "configured" (block exact and wildcard matches only, preserving
// v0.1.1 behaviour). defaultRoute is a fallback, not an explicit route, so it
// never blocks, and targets that do not resolve at all always pass through.
function shouldBlockNativeTask(config, target) {
  let resolved;
  try {
    resolved = resolveTargetRoute(config, target);
  } catch {
    return false;
  }
  if (resolved.key === "defaultRoute") return false;

  const flag = resolved.blockNativeTask ?? config.blockNativeTask ?? "configured";
  return blockNativeTaskCovers(flag, target);
}

function blockNativeTaskCovers(flag, target) {
  if (flag === false || flag === "none") return false;
  if (flag === true || flag === "all" || flag === "configured") return true;
  if (Array.isArray(flag)) {
    return flag.includes(target) || flag.includes(namespaceWildcard(target));
  }
  return false;
}

function namespaceWildcard(target) {
  if (target.startsWith("category:")) return "category:*";
  if (target.startsWith("agent:")) return "agent:*";
  return target;
}

function normalizeTarget(target) {
  if (typeof target !== "string") throw new Error("Delegation target must be a string");
  if (target.startsWith("category:") || target.startsWith("agent:")) return target;
  throw new Error("Delegation target must use category:<name> or agent:<name>");
}
