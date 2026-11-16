import { setupExtension } from "../../src/extension.ts";
import type { MiwarangConfig } from "../../src/config.ts";
import type { BackendAdapter } from "../../src/delegate-routing.ts";

export const config: MiwarangConfig = {
  backends: {
    opencode: {
      type: "opencode-cli",
      command: "opencode",
      args: ["run", "--agent", "{{agent}}"],
      promptInput: "argument",
      agent: "Orchestrator",
    },
    commandcode: {
      type: "command",
      command: "commandcode",
      args: ["-p", "-t"],
      promptInput: "argument",
      agent: "General",
    },
    koma: { type: "koma-sdk", command: "koma", args: ["sdk", "serve"] },
  },
  delegation: ["opencode", "commandcode", "koma"],
};

export const commandOnlyConfig: MiwarangConfig = {
  backends: {
    command: { type: "command", command: "commandcode", args: ["-p"], agent: "General" },
    claude: { type: "command", command: "claude", args: ["-p"], agent: "general" },
  },
  delegation: ["command", "claude"],
};

export function makeHarness({ config: activeConfig = config, backends, runStore, timers }: {
  config?: any;
  backends?: Record<string, any>;
  runStore?: any;
  timers?: any;
} = {}) {
  const tools: Map<string, any> = new Map();
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const calls: unknown[][] = [];
  const backend: any = {
    runForeground: async (request) => {
      calls.push(["foreground", request]);
      return { sessionId: "ses_foreground", text: "Foreground result" };
    },
    start: async (request) => {
      calls.push(["start", request]);
      return { sessionId: "ses_background", state: "running" };
    },
    wait: async (sessionId) => {
      calls.push(["wait", sessionId]);
      return { sessionId, text: "Background result" };
    },
    cancel: async (sessionId) => {
      calls.push(["cancel", sessionId]);
      return { sessionId, interrupted: true };
    },
  };
  const commandBackend: any = {
    runForeground: async (request) => {
      calls.push(["foreground", request]);
      return { sessionId: "ses_command_foreground", text: "Command foreground result" };
    },
    start: async (request) => {
      calls.push(["start", request]);
      return { sessionId: "ses_command_background", state: "running" };
    },
    wait: async (sessionId) => {
      calls.push(["wait", sessionId]);
      return { sessionId, text: "Command background result" };
    },
    cancel: async (sessionId) => {
      calls.push(["cancel", sessionId]);
      return { sessionId, interrupted: true };
    },
  };
  const pi: any = {
    cwd: "/workspace",
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on(name: string, handler: any) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
  };

  setupExtension(pi, {
    config: activeConfig,
    backends: backends ?? { opencode: backend, commandcode: commandBackend, koma: commandBackend },
    runStore,
    timers: timers ?? { setInterval: () => 0, clearInterval: () => {} },
  });

  return { tools, handlers, commands, calls, backend, commandBackend };
}

export async function invoke(tool: any, params: any, ctx: any = { cwd: "/workspace" }) {
  return tool.execute("test-call", params, undefined, undefined, ctx) as Promise<any>;
}

export function uiRecorder() {
  const statuses: [string, string | undefined][] = [];
  const notices: [string, string | undefined][] = [];
  return {
    statuses,
    notices,
    ui: {
      setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      notify: (text: string, level?: string) => notices.push([text, level as string | undefined]),
    },
  };
}
