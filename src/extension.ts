import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createCommandBackend } from "./backends/command.ts";
import { createKomaBackend } from "./backends/koma.ts";
import { RunStore } from "./runs/store.ts";
import { registerRunTools } from "./run-tools.ts";
import { createMiwarangService } from "./service.ts";
import {
  createRunTracker,
  formatStatusLine,
  isTerminalState,
} from "./watch.ts";
import type { MiwarangConfig, BackendConfig } from "./config.ts";
import type { BackendAdapter } from "./delegate-routing.ts";
import type { RunTracker, TrackedRun } from "./watch.ts";

const STATUS_POLL_MS = 15_000;

const OPENCODE_DEFAULTS = {
  command: "opencode",
  args: ["run", "--agent", "{{agent}}"],
  promptInput: "argument" as const,
};

export interface PiContext {
  cwd?: string;
  ui?: {
    setStatus?: (id: string, line: string | undefined) => void;
    notify?: (message: string, level?: string) => void;
  };
  [key: string]: unknown;
}

export interface PiHost {
  cwd?: string;
  registerTool(definition: unknown): void;
  registerCommand?(name: string, definition: unknown): void;
  on?(event: string, handler: (event: unknown) => unknown): void;
  [key: string]: unknown;
}

interface Clock {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

interface ExtensionOptions {
  config: MiwarangConfig;
  backends?: Record<string, BackendAdapter>;
  runStore?: RunStore;
  timers?: Clock;
}

export default async function miwarangExtension(pi: PiHost): Promise<void> {
  const configPath =
    process.env.MIWARANG_CONFIG ?? join(homedir(), ".config/miwarang/config.json");
  const config = await loadConfig(configPath);
  setupExtension(pi, { config });
}

export function setupExtension(
  pi: PiHost,
  { config, backends: injectedBackends, runStore, timers }: ExtensionOptions,
): void {
  const store = runStore ?? new RunStore({ directory: config.runsDirectory });
  const backends = injectedBackends ?? createBackends(config, store);
  const tracker: RunTracker = createRunTracker({
    readCommandState: async (id) => (await store.get(id))?.state as string | undefined,
  });
  const clock = timers ?? { setInterval, clearInterval };
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let statusCtx: PiContext | undefined;

  function syncStatus(ctx?: PiContext) {
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

  const service = createMiwarangService({
    config,
    backends,
    tracker,
    store,
    onRunTracked: () => syncStatus(statusCtx),
  });

  pi.registerTool({
    name: "miwarang_delegate",
    label: "Delegate task",
    description:
      "Delegate a task to the configured second-orchestrator harnesses (OpenCode CLI, Command Code, Koma) by prompt.",
    promptSnippet:
      "Delegate tasks through the configured backend delegation chain.",
    promptGuidelines: [
      "miwarang_delegate is a unified prompt-driven delegation tool: pass the complete task prompt and let the configured backend harnesses own their models and agents.",
      "Only prompt is required. mode defaults to foreground; use background only for asynchronous work. Omit cwd to inherit the active workspace context.",
      "Omit backend to follow the configured delegation chain order. Pass backend only for an intentional user-required override. Foreground provider failures may continue through the chain; background runtime failures are reported instead of retried silently.",
      "Each backend's agent comes from the Miwarang config (for example an Orchestrator agent for OpenCode); Miwarang never selects or overrides a model.",
      "Use miwarang_wait or miwarang_cancel with the returned run ID for background work. Background delegations are tracked glm-5.3-flashmatically: the session status line lists active runs, /miwarang shows the full table, and miwarang_wait returns the terminal result.",
    ],
    parameters: Type.Object({
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
            "Optional harness override. Omit in normal routing so Miwarang follows the configured delegation chain.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Optional absolute project directory. Omit to inherit the active workspace context.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        prompt: string;
        mode?: "foreground" | "background";
        backend?: string;
        cwd?: string;
      },
      _signal: unknown,
      onUpdate: unknown,
      ctx?: PiContext,
    ) {
      syncStatus(ctx);
      const { text, details } = await service.delegate(
        {
          prompt: params.prompt,
          mode: params.mode,
          backend: params.backend,
          onUpdate:
            typeof onUpdate === "function"
              ? (onUpdate as (delta: string) => void)
              : undefined,
        },
        { cwd: params.cwd ?? ctx?.cwd ?? pi.cwd ?? process.cwd(), sessionId: typeof ctx?.sessionId === "string" ? ctx.sessionId : undefined },
      );
      return { content: [{ type: "text", text }], details };
    },
  });
  registerRunTools(pi as any, { config, backends: backends as Record<string, BackendAdapter>, store, tracker, syncStatus });
}
function createBackends(config: MiwarangConfig, store: RunStore = new RunStore({ directory: config.runsDirectory })) {
  const backends: Record<string, BackendAdapter> = {};
  for (const [id, backend] of Object.entries(config.backends)) {
    backends[id] = createBackend(id, backend, store);
  }
  return backends;
}
function createBackend(id: string, backend: BackendConfig, store: RunStore): BackendAdapter {
  if (backend.type === "opencode-cli") {
    return createCommandBackend(
      { ...OPENCODE_DEFAULTS, ...backend, id } as never,
      { runStore: store },
    );
  }
  if (backend.type === "command") {
    return createCommandBackend({ ...backend, id } as never, { runStore: store });
  }
  if (backend.type === "koma-sdk") {
    return createKomaBackend({ ...backend, id }, { runStore: store });
  }
  throw new Error(`Unknown backend type ${backend.type} for ${id}`);
}
