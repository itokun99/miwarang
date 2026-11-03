import { setupExtension } from "../../src/extension.js";

export const config = {
  backends: {
    opencode: { type: "opencode-v2", command: "opencode" },
  },
  routes: {
    "category:quick": {
      backend: "opencode",
      models: ["opencode/space-bunny-free"],
      freeOnly: true,
    },
    "agent:explore": {
      backend: "opencode",
      models: ["opencode-go/longcat-2.5-preview-free"],
      freeOnly: true,
      agent: "explore",
    },
  },
};

export const liveModels = [
  {
    providerID: "opencode",
    id: "space-bunny-free",
    cost: { input: 0, output: 0 },
  },
  {
    providerID: "opencode-go",
    id: "longcat-2.5-preview-free",
    cost: { input: 0, output: 0 },
  },
  {
    providerID: "qwen",
    id: "qwen3.8-max",
    cost: { input: 0, output: 0 },
  },
];

export const wildcardConfig = {
  backends: {
    opencode: { type: "opencode-v2", command: "opencode" },
    commandcode: { type: "command", command: "commandcode" },
  },
  routes: {
    "category:*": {
      backend: "opencode",
      models: ["qwen/qwen3.8-max"],
    },
  },
};

export const legacyConfig = {
  backends: {
    opencode: { type: "opencode-v2", command: "opencode" },
  },
  routes: {
    "category:quick": {
      backend: "opencode",
      models: ["opencode/space-bunny-free", "opencode-go/longcat-2.5-preview-free"],
      freeOnly: true,
    },
    "agent:explore": {
      backend: "opencode",
      models: ["opencode-go/longcat-2.5-preview-free"],
      freeOnly: true,
      agent: "explore",
    },
  },
};

export const wildcardOverrideConfig = {
  backends: {
    opencode: { type: "opencode-v2", command: "opencode" },
    commandcode: { type: "command", command: "commandcode" },
  },
  routes: {
    "category:quick": {
      backend: "opencode",
      models: ["opencode/space-bunny-free"],
      freeOnly: true,
    },
    "category:*": {
      backend: "commandcode",
      models: ["qwen/qwen3.8-max", "moonshotai/kimi-k3"],
    },
  },
};

export function makeHarness({ config: activeConfig = config, backends, runStore, timers } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  const backend = {
    listModels: async () => liveModels,
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
  const commandBackend = {
    listModels: async () => undefined,
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
  const pi = {
    cwd: "/workspace",
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(name, handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
  };

  setupExtension(pi, {
    config: activeConfig,
    backends: backends ?? { opencode: backend, commandcode: commandBackend },
    runStore,
    timers: timers ?? { setInterval: () => 0, clearInterval: () => {} },
  });

  return { tools, handlers, commands, calls, backend, commandBackend };
}

export async function invoke(tool, params, ctx = { cwd: "/workspace" }) {
  return tool.execute("test-call", params, undefined, undefined, ctx);
}

export function uiRecorder() {
  const statuses = [];
  const notices = [];
  return {
    statuses,
    notices,
    ui: {
      setStatus: (key, text) => statuses.push([key, text]),
      notify: (text, level) => notices.push([text, level]),
    },
  };
}
