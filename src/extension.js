import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createCommandBackend } from "./backends/command.js";
import { createOpenCodeBackend } from "./backends/opencode.js";
import { executeDelegate } from "./delegate-routing.js";
import { registerNativeTaskHook } from "./native-task.js";
import { RunStore } from "./runs/store.js";
import { registerRunTools } from "./run-tools.js";
import {
  createRunTracker,
  formatStatusLine,
  isTerminalState,
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
      "Delegate an OMO task to the configured OpenCode or Command Code harness.",
    promptSnippet:
      "Delegate OMO route tasks through the configured backend.",
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
      "Background delegations are tracked automatically: the session status line lists active runs, /miwarang shows the full table, and miwarang_wait returns the terminal result.",
      "OMO configuration supplies intent/category only. Never copy a model or backend from omo.jsonc or the OMO session.",
      "OpenCode uses its configured default model and the orchestrator agent; Miwarang does not inspect its model catalog or apply a freeOnly filter.",
      "Command Code uses its General agent by default. Keep the harness agent and agent_output tools enabled so General can route to available agents.",
      "Command backends select configured model candidates in order without a freeOnly filter. OMO target agent:<name> selects a Miwarang route, not a harness agent override.",
      "Only target and prompt are required. Omit backend, model, and agent in normal routing. mode defaults to foreground; use background only for asynchronous work. Omit cwd to inherit the active workspace.",
      "Routes may define ordered fallbacks with their own backend and model list. Omit backend to let Miwarang choose a configured fallback with the correct harness-specific models; pass backend only for an intentional user-required override. Foreground provider failures may continue through fallbacks, and background runtime failures are reported instead of retried silently.",
    ],
    parameters: Type.Object({
      target: Type.String({
        description:
          "Required. Full Miwarang route key with its prefix: category:<name> or agent:<name>.",
      }),
      prompt: Type.String({
        description:
          "Required. Complete delegated task, preserving the original constraints and acceptance criteria.",
      }),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal("foreground"), Type.Literal("background")],
          {
            description:
              "Optional. Defaults to foreground. Use background only when asynchronous work was requested.",
          },
        ),
      ),
      backend: Type.Optional(
        Type.String({
          description:
            "Optional harness override. Omit in normal routing so Miwarang selects the configured route and fallback chain.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Optional command-backend model override from that route's candidate list. OpenCode uses its configured default model; do not set model for OpenCode.",
        }),
      ),
      agent: Type.Optional(
        Type.String({
          description:
            "Optional command-line agent argument when the backend args use {{agent}}. OpenCode always uses orchestrator; Command Code uses General and its internal agent tool. This is not the OMO target agent:<name>.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Optional absolute project directory. Omit to inherit the active workspace context.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = normalizeTarget(params.target);
      const execution = await executeDelegate(config, backends, {
        target,
        prompt: params.prompt,
        mode: params.mode ?? "foreground",
        backend: params.backend,
        model: params.model,
        agent: params.agent,
        cwd: params.cwd ?? ctx?.cwd ?? pi.cwd ?? process.cwd(),
      });
      const {
        result,
        selected,
        mode,
        resolvedVia: resolvedViaValue,
      } = execution;

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
        let text = `Started ${target} in background (${id}).`;
        return {
          content: [{ type: "text", text }],
          details: {
            ...result,
            backend: selected.backendId,
            resolvedVia: resolvedViaValue,
            target,
            ...(selected.route.model === undefined ? {} : { model: selected.route.model }),
            ...(selected.index > 0
              ? { fallback: true, fallbackIndex: selected.index }
              : {}),
          },
        };
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          sessionId: result.sessionId,
          backend: selected.backendId,
          resolvedVia: resolvedViaValue,
          target,
          ...(selected.route.model === undefined ? {} : { model: selected.route.model }),
          ...(selected.index > 0 ? { fallback: true, fallbackIndex: selected.index } : {}),
        },
      };
    },
  });

  registerRunTools(pi, { config, backends, store, tracker, syncStatus });
  registerNativeTaskHook(pi, config);
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

function normalizeTarget(target) {
  if (typeof target !== "string") throw new Error("Delegation target must be a string");
  if (target.startsWith("category:") || target.startsWith("agent:")) return target;
  throw new Error("Delegation target must use category:<name> or agent:<name>");
}
