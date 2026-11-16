// External OMP extension: Oh My Pi is Pi-derived, so the tool registration
// mirrors the Pi wrapper, with OMP's extension permission tiers surfaced as a
// per-call confirmation through ctx.ui.confirm (OMP subagents run headless and
// cannot pause for approval; this tool runs in the interactive host).
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createCommandBackend } from "../../src/backends/command.ts";
import { createKomaBackend } from "../../src/backends/koma.ts";
import { RunStore } from "../../src/runs/store.ts";
import { createMiwarangService } from "../../src/service.ts";
import { createRunTracker } from "../../src/watch.ts";
import type { MiwarangConfig } from "../../src/config.ts";
import type { BackendAdapter } from "../../src/delegate-routing.ts";

const OPENCODE_DEFAULTS = {
  command: "opencode",
  args: ["run", "--agent", "{{agent}}"],
  promptInput: "argument" as const,
};

function createBackends(config: MiwarangConfig, store: RunStore): Record<string, BackendAdapter> {
  const backends: Record<string, BackendAdapter> = {};
  for (const [id, backend] of Object.entries(config.backends)) {
    if (backend.type === "opencode-cli") {
      backends[id] = createCommandBackend({ ...OPENCODE_DEFAULTS, ...backend, id } as never, { runStore: store });
    } else if (backend.type === "command") {
      backends[id] = createCommandBackend({ ...backend, id } as never, { runStore: store });
    } else if (backend.type === "koma-sdk") {
      backends[id] = createKomaBackend({ ...backend, id }, { runStore: store });
    }
  }
  return backends;
}

const params = Type.Object({
  prompt: Type.Optional(Type.String({ description: "For delegate. Complete delegated task, preserving the original constraints and acceptance criteria." })),
  mode: Type.Optional(Type.Union([Type.Literal("foreground"), Type.Literal("background")], { description: "Defaults to foreground. Use background only for async work." })),
  backend: Type.Optional(Type.String({ description: "Optional harness override. Omit to follow the configured delegation chain." })),
  cwd: Type.Optional(Type.String({ description: "Optional absolute project directory." })),
  runId: Type.Optional(Type.String({ description: "Run or session ID for wait/cancel." })),
  action: Type.Optional(Type.Union([Type.Literal("delegate"), Type.Literal("wait"), Type.Literal("cancel")], { description: "Defaults to delegate when prompt is set; wait or cancel needs runId." })),
});

export default async function (pi: any) {
  const configPath = process.env.MIWARANG_CONFIG ?? join(homedir(), ".config/miwarang/config.json");
  const config = await loadConfig(configPath);
  const store = new RunStore({ directory: config.runsDirectory });
  const tracker = createRunTracker({
    readCommandState: async (id) => (await store.get(id))?.state as string | undefined,
  });
  const service = createMiwarangService({ config, backends: createBackends(config, store), tracker, store });
  const requireConfirmation = process.env.MIWARANG_OMP_CONFIRM !== "0";

  pi.registerTool({
    name: "miwarang",
    label: "Miwarang",
    description:
      "Delegate a task to the configured second-orchestrator harnesses (OpenCode CLI, Command Code, Koma) by prompt; or wait for or cancel an earlier background run. Miwarang never selects a model; each harness owns its model and agent.",
    parameters: params,
    async execute(toolCallId: string, p: any, signal: unknown, onUpdate: unknown, ctx: any) {
      const action: "delegate" | "wait" | "cancel" =
        p.action ?? (p.prompt !== undefined ? "delegate" : p.runId !== undefined ? "wait" : "delegate");
      const needsExecTier = action === "delegate" || action === "cancel";
      if (requireConfirmation && needsExecTier && typeof ctx?.ui?.confirm === "function") {
        const approved = await ctx.ui.confirm(
          "Miwarang",
          `${action === "delegate" ? "Delegate this task" : `Cancel run ${p.runId}`} through Miwarang?`,
        );
        if (!approved) {
          return {
            content: [{ type: "text", text: "Miwarang call rejected by the operator." }],
            details: { version: 1, state: "rejected", action },
          };
        }
      }
      const args: any =
        action === "delegate"
          ? { prompt: p.prompt, mode: p.mode, backend: p.backend }
          : { runId: p.runId, backend: p.backend };
      const callCtx = {
        cwd: p.cwd ?? ctx?.cwd ?? process.cwd(),
        sessionId: typeof ctx?.session?.id === "string" ? ctx.session.id : undefined,
      };
      const { text, details } =
        action === "delegate"
          ? await service.delegate(args, callCtx)
          : action === "wait"
            ? await service.wait(args, callCtx)
            : await service.cancel(args, callCtx);
      return { content: [{ type: "text", text: `${text}\n\n${JSON.stringify(details, null, 2)}` }], details };
    },
  });
}
