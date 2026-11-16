// OpenCode V2 plugin part for Miwarang. Registers three tools in the OpenCode
// server (miwarang_delegate, miwarang_wait, miwarang_cancel) backed by the
// shared host-neutral service, and asserts a permission before each call so
// OpenCode's permission map can allow/ask/deny delegation per agent.
// External plugin: OpenCode V2 types come from the host's own @opencode/plugin
// install (the repo's tsconfig does not include this integration), so the
// plugin ctx and editor are typed loosely here on purpose.
import { Plugin } from "@opencode/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createCommandBackend } from "../../src/backends/command.ts";
import { createKomaBackend } from "../../src/backends/koma.ts";
import { RunStore } from "../../src/runs/store.ts";
import { createMiwarangService } from "../../src/service.ts";
import { createRunTracker } from "../../src/watch.ts";
import type { MiwarangConfig, BackendConfig } from "../../src/config.ts";
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

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Required. Complete delegated task, preserving the original constraints and acceptance criteria." },
    mode: { type: "string", enum: ["foreground", "background"], description: "Optional. Defaults to foreground. Use background only for async work." },
    backend: { type: "string", description: "Optional harness override. Omit to follow the configured delegation chain." },
    cwd: { type: "string", description: "Optional absolute project directory." },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

const RUN_ID_SCHEMA = {
  type: "object",
  properties: {
    runId: { type: "string", description: "Run or session ID returned by miwarang_delegate." },
    backend: { type: "string", description: "Optional backend override." },
  },
  required: ["runId"],
  additionalProperties: false,
} as const;

export default Plugin.define({
  id: "miwarang",
  async setup(ctx: any) {
    const configPath = (ctx.options as { configPath?: string } | undefined)?.configPath
      ?? process.env.MIWARANG_CONFIG
      ?? join(homedir(), ".config/miwarang/config.json");
    const config = await loadConfig(configPath);
    const store = new RunStore({ directory: config.runsDirectory });
    const tracker = createRunTracker({
      readCommandState: async (id) => (await store.get(id))?.state as string | undefined,
    });
    const service = createMiwarangService({
      config,
      backends: createBackends(config, store),
      tracker,
      store,
    });
    const workdir = ctx.location?.directory ?? process.cwd();

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "miwarang_delegate",
        description:
          "Delegate a task to the configured second-orchestrator harnesses (OpenCode CLI, Command Code, Koma) by prompt. Each harness owns its model and agent; Miwarang never selects a model.",
        input: INPUT_SCHEMA,
        execute: async (input: any, context: any) => {
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "miwarang_delegate",
            resources: [input.backend ?? "chain"],
          });
          const { text, details } = await service.delegate(
            { prompt: input.prompt, mode: input.mode, backend: input.backend },
            { cwd: input.cwd ?? workdir, sessionId: context.sessionID },
          );
          return { content: `${text}\n\n${JSON.stringify(details, null, 2)}` };
        },
      });
      editor.add({
        name: "miwarang_wait",
        description: "Wait for delegated background work and return its final result.",
        input: RUN_ID_SCHEMA,
        execute: async (input: any, context: any) => {
          const { text, details } = await service.wait(input, { sessionId: context.sessionID });
          return { content: `${text}\n\n${JSON.stringify(details, null, 2)}` };
        },
      });
      editor.add({
        name: "miwarang_cancel",
        description: "Interrupt delegated background work by its returned ID.",
        input: RUN_ID_SCHEMA,
        execute: async (input: any, context: any) => {
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "miwarang_cancel",
            resources: [input.backend ?? "chain"],
          });
          const { text, details } = await service.cancel(input, { sessionId: context.sessionID });
          return { content: `${text}\n\n${JSON.stringify(details, null, 2)}` };
        },
      });
    });
  },
});
