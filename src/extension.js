import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveRoute, resolveTargetRoute } from "./config.js";
import { createCommandBackend } from "./backends/command.js";
import { createOpenCodeBackend } from "./backends/opencode.js";
import { RunStore } from "./runs/store.js";
import {
  buildEvalCode,
  buildWatchDefinition,
  createRunTracker,
  formatRunTable,
  formatStatusLine,
  isTerminalState,
  normalizeDagWatch,
  parseWatchRunId,
  shortId,
} from "./watch.js";

// How often the footer status line re-reads command run records while a run is
// alive. Opencode sessions have no cheap state probe, so only command runs
// drive this interval.
const STATUS_POLL_MS = 15_000;

export default async function miwarangExtension(pi) {
  const configPath =
    process.env.MIWARANG_CONFIG ?? join(homedir(), ".config/miwarang/config.json");
  const config = await loadConfig(configPath);
  setupExtension(pi, { config });
}

export function setupExtension(pi, { config, backends: injectedBackends, runStore, timers } = {}) {
  const store = runStore ?? new RunStore({ directory: config.runsDirectory });
  const backends = injectedBackends ?? createBackends(config, store);
  const dagWatch = normalizeDagWatch(config.dagWatch);
  const tracker = createRunTracker({
    readCommandState: async (id) => (await store.get(id))?.state,
  });
  const clock = timers ?? { setInterval, clearInterval };
  let statusTimer;
  let statusCtx;

  function syncStatus(ctx) {
    statusCtx = ctx ?? statusCtx;
    const runs = tracker.list();
    if (typeof statusCtx?.ui?.setStatus === "function") {
      statusCtx.ui.setStatus("miwarang", formatStatusLine(runs));
    }
    const needsPoll = runs.some(
      (run) => run.backendType === "command" && !isTerminalState(run.state),
    );
    if (needsPoll && !statusTimer) {
      statusTimer = clock.setInterval(async () => {
        await tracker.refresh();
        syncStatus();
      }, STATUS_POLL_MS);
      statusTimer?.unref?.();
    } else if (!needsPoll && statusTimer) {
      clock.clearInterval(statusTimer);
      statusTimer = undefined;
    }
  }

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
      "Background delegations are tracked automatically: the session status line lists active runs, /miwarang shows the full table, and a dag watch run renders their progress in /dag.",
      "OMO configuration supplies intent/category only. Never copy a model or backend from omo.jsonc or the OMO session. Omit model and backend so Miwarang probes the selected harness's live catalogue and resolves the configured route/fallback chain.",
      "Routes may define ordered fallbacks with their own backend and model list. Omit backend to let Miwarang choose a configured fallback with the correct harness-specific models; pass backend only for an intentional user-required override. Foreground provider failures may continue through fallbacks, and background runtime failures are reported instead of retried silently.",
    ],
    parameters: Type.Object({
      target: Type.String(),
      prompt: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal("foreground"), Type.Literal("background")])),
      backend: Type.Optional(Type.String()),
      model: Type.Optional(
        Type.String({
          description:
            "Optional target-harness model id; it must exist in the target's live catalog " +
            "(the OpenCode model catalog, or a command backend's model list). Omit it so " +
            "Miwarang picks from the route's configured candidates. Never pass the OMO " +
            "session's own model or a model pinned in omo.jsonc.",
        }),
      ),
      agent: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = normalizeTarget(params.target);
      if (params.backend !== undefined && !config.backends?.[params.backend]) {
        throw new Error(`Backend ${params.backend} is not configured`);
      }
      const resolved = resolveTargetRoute(config, target, { backend: params.backend });
      const candidates = [resolved, ...(resolved.fallbacks ?? [])];
      const routeWith = (candidate, models) => ({
        ...config,
        routes: { [target]: modelSelectionRoute(candidate, models) },
      });
      const selectCandidate = async (startIndex) => {
        let lastError;
        for (let index = startIndex; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          const backend = backends[candidate.backendName];
          if (!backend) throw new Error(`Backend ${candidate.backendName} is not configured`);

          const liveModels =
            candidate.backend.type === "opencode-v2"
              ? await backend.listModels()
              : ((await backend.listModels?.()) ??
                configuredCommandModels(candidate, index === 0 ? params.model : undefined));
          try {
            const route = resolveRoute(routeWith(candidate), target, liveModels, {
              model: index === 0 ? params.model : undefined,
              agent: params.agent,
            });
            return {
              backend,
              backendId: candidate.backendName,
              candidate,
              index,
              liveModels,
              route,
            };
          } catch (error) {
            if (
              !isModelAvailabilityFailure(error) ||
              (index === 0 && params.model !== undefined)
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
      const requestFor = (model) => ({
        cwd: params.cwd ?? ctx?.cwd ?? pi.cwd ?? process.cwd(),
        target,
        model,
        agent: selected.route.agent,
        prompt: params.prompt,
      });
      // Runtime provider or quota failures are invisible to the catalogue
      // check, so foreground runs continue down the configured candidates
      // and then any explicitly configured fallback backends until one
      // produces text. Background start failures can use the same chain
      // until a run ID is created; failures after a run ID exists are
      // reported through miwarang_wait instead of retried silently.
      const mode = params.mode ?? "foreground";
      let result;
      if (mode === "background") {
        const tried = [];
        for (;;) {
          try {
            result = await selected.backend.start(requestFor(selected.route.model));
            break;
          } catch (error) {
            tried.push(selected.route.model);
            if (params.model !== undefined || !isProviderFailure(selected.candidate, error)) {
              throw error;
            }
            const remaining = selected.candidate.models.filter(
              (model) => !tried.includes(model),
            );
            if (remaining.length) {
              try {
                selected = {
                  ...selected,
                  route: resolveRoute(routeWith(selected.candidate, remaining), target, selected.liveModels, {
                    agent: params.agent,
                  }),
                };
                continue;
              } catch {
                // The live catalogue can change between selection and execution.
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
            result = await selected.backend.runForeground(requestFor(selected.route.model));
            break;
          } catch (error) {
            tried.push(selected.route.model);
            if (params.model !== undefined || !isProviderFailure(selected.candidate, error)) {
              throw error;
            }
            const remaining = selected.candidate.models.filter(
              (model) => !tried.includes(model),
            );
            if (remaining.length) {
              try {
                selected = {
                  ...selected,
                  route: resolveRoute(routeWith(selected.candidate, remaining), target, selected.liveModels, {
                    agent: params.agent,
                  }),
                };
                continue;
              } catch {
                // The live catalogue can change between selection and execution.
              }
            }
            const next = await selectCandidate(selected.index + 1);
            if (!next.route) throw error;
            selected = next;
            tried.length = 0;
          }
        }
      }
      const resolvedViaValue = resolvedVia(resolved.key, target);

      if (mode === "background") {
        const id = result.sessionId ?? result.runId;
        tracker.track({
          id,
          backend: selected.backendId,
          backendType: selected.candidate.backend.type,
          target,
          startedAt: Date.now(),
        });
        syncStatus(ctx);
        const watch = dagWatch.enabled
          ? await startWatchDag(ctx, {
              id,
              backendType: selected.candidate.backend.type,
              target,
              runsDirectory: store.directory,
              watch: dagWatch,
            })
          : undefined;
        let text = `Started ${target} in background (${id}).`;
        if (watch?.runId) text += ` Dag watch: ${watch.runId}.`;
        if (watch?.error) text += ` Dag watch unavailable: ${watch.error}.`;
        return {
          content: [{ type: "text", text }],
          details: {
            ...result,
            backend: selected.backendId,
            resolvedVia: resolvedViaValue,
            model: selected.route.model,
            target,
            ...(selected.index > 0
              ? { fallback: true, fallbackIndex: selected.index }
              : {}),
            ...(watch ? { dagWatch: watch } : {}),
          },
        };
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          sessionId: result.sessionId,
          backend: selected.backendId,
          resolvedVia: resolvedViaValue,
          model: selected.route.model,
          target,
          ...(selected.index > 0 ? { fallback: true, fallbackIndex: selected.index } : {}),
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = delegatedId(params);
      const backendId = await backendForRun(config, id, params.backend, store);
      const result = await backends[backendId].wait(id);
      tracker.resolve(id, result.state ?? "completed");
      syncStatus(ctx);
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = delegatedId(params);
      const backendId = await backendForRun(config, id, params.backend, store);
      const result = await backends[backendId].cancel(id);
      tracker.resolve(id, result.state ?? "cancelled");
      syncStatus(ctx);
      return {
        content: [{ type: "text", text: `Cancellation state: ${result.state ?? result.interrupted}.` }],
        details: { ...result, backend: backendId },
      };
    },
  });

  pi.registerCommand("miwarang", {
    description: "Show the miwarang background runs tracked in this session",
    handler: async (_args, ctx) => {
      await tracker.refresh();
      syncStatus(ctx);
      ctx.ui.notify(formatRunTable(tracker.list()), "info");
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

// The dag `workflow` tool is exposure-hidden from model calls, and a plain
// ctx.executeTool("workflow", ...) cannot reach it ("Tool workflow not found",
// verified 2026-10-20); the eval kernel's `tool` proxy can, so the watch
// bridge runs one eval cell and reads the run back from the cell output.
// Runs created here are ordinary dag runs: /dag, the status widget, and any
// dag pane (for example omo-tmux-dag) render them like any other run.
async function startWatchDag(ctx, { id, backendType, target, runsDirectory, watch }) {
  if (typeof ctx?.executeTool !== "function") {
    return { error: "this host does not offer ctx.executeTool" };
  }
  const definition = buildWatchDefinition({ id, backendType, target, runsDirectory, watch });
  try {
    const response = await ctx.executeTool("eval", {
      action: "run",
      language: "js",
      summary: `miwarang dag watch ${shortId(id)}`,
      code: buildEvalCode(definition),
    });
    const text = response?.content?.[0]?.text ?? "";
    const runId = parseWatchRunId(text);
    return runId ? { runId } : { error: "the dag start returned no run id" };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
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

// The route handed to resolveRoute. A command backend without a model-list
// probe (listModelsArgv) cannot verify availability or prices, so when the
// effective pricePolicy is "any" its freeOnly constraint is dropped there.
// opencode-v2 and probing command backends keep the catalogue-backed gate.
function modelSelectionRoute(resolved, models = resolved.models) {
  const pricePolicy = effectivePricePolicy(resolved);
  const unverifiableCommand =
    resolved.backend?.type === "command" && !resolved.backend?.listModelsArgv;
  const freeOnly = resolved.freeOnly && !(unverifiableCommand && pricePolicy === "any");
  return {
    backend: resolved.backendName,
    models,
    freeOnly,
    agent: resolved.agent,
  };
}

function resolvedVia(key, target) {
  if (key === "defaultRoute") return "default";
  if (key === target) return "exact";
  return "wildcard";
}

function isModelAvailabilityFailure(error) {
  return /^(?:No available free model is configured for|No configured model is available for)/.test(
    String(error?.message ?? error),
  );
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

// Fallback catalogue for command backends without a listModelsArgv probe, or
// when that probe fails: the configured candidates themselves become the
// catalogue with unknown (non-free) pricing, so a freeOnly route only reaches
// one when the effective pricePolicy allows any model. The route-level
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
      ? { providerID: "", id, cost: { input: 1, output: 1 } }
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
