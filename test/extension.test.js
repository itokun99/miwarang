import { describe, expect, test } from "bun:test";
import { setupExtension } from "../src/extension.js";

const config = {
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

const liveModels = [
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

const wildcardConfig = {
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

function makeHarness({ config: activeConfig = config } = {}) {
  const tools = new Map();
  const handlers = new Map();
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
    listModels: async () => liveModels,
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
    on(name, handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
  };

  setupExtension(pi, {
    config: activeConfig,
    backends: { opencode: backend, commandcode: commandBackend },
  });

  return { tools, handlers, calls, backend, commandBackend };
}

async function invoke(tool, params) {
  return tool.execute("test-call", params, undefined, undefined, { cwd: "/workspace" });
}

describe("Senpi extension", () => {
  test("registers delegation lifecycle tools and routing guidance", () => {
    const { tools } = makeHarness();

    expect([...tools.keys()]).toEqual([
      "miwarang_delegate",
      "miwarang_wait",
      "miwarang_cancel",
    ]);
    const guidance = tools.get("miwarang_delegate").promptGuidelines.join(" ");
    expect(guidance).toMatch(
      /category:quick.*category:visual-engineering.*agent:explore.*agent:omo-native-qa-executor/i,
    );
    expect(guidance).toContain("category:*");
    expect(guidance).toContain("defaultRoute");
  });

  test("dispatches foreground work to the configured backend and model", async () => {
    const { tools, calls } = makeHarness();

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:quick",
      prompt: "Inspect this project",
      mode: "foreground",
    });

    expect(calls[0]).toEqual([
      "foreground",
      {
        cwd: "/workspace",
        target: "category:quick",
        model: "opencode/space-bunny-free",
        prompt: "Inspect this project",
      },
    ]);
    expect(result.details).toMatchObject({
      sessionId: "ses_foreground",
      backend: "opencode",
      resolvedVia: "exact",
      model: "opencode/space-bunny-free",
    });
    expect(result.content[0].text).toContain("Foreground result");
  });

  test("starts background work and returns its session ID", async () => {
    const { tools, calls } = makeHarness();

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "agent:explore",
      prompt: "List relevant files",
      mode: "background",
    });

    expect(calls[0][0]).toBe("start");
    expect(calls[0][1]).toMatchObject({
      cwd: "/workspace",
      target: "agent:explore",
      model: "opencode-go/longcat-2.5-preview-free",
      agent: "explore",
    });
    expect(result.details).toMatchObject({
      sessionId: "ses_background",
      resolvedVia: "exact",
    });
  });

  test("waits for and cancels a background session by ID", async () => {
    const { tools, calls } = makeHarness();

    const waited = await invoke(tools.get("miwarang_wait"), {
      sessionId: "ses_background",
    });
    const cancelled = await invoke(tools.get("miwarang_cancel"), {
      sessionId: "ses_background",
    });

    expect(calls).toEqual([
      ["wait", "ses_background"],
      ["cancel", "ses_background"],
    ]);
    expect(waited.content[0].text).toContain("Background result");
    expect(cancelled.details).toMatchObject({
      sessionId: "ses_background",
      interrupted: true,
    });
  });

  test("redirects routed native tasks but preserves other task calls", async () => {
    const { handlers } = makeHarness();
    const handler = handlers.get("tool_call")[0];

    const redirected = await handler({
      toolName: "task",
      input: {
        category: "quick",
        prompt: "Inspect this project",
        run_in_background: true,
      },
    });
    const unchanged = await handler({
      toolName: "task",
      input: { category: "architect", prompt: "Design the system" },
    });

    expect(redirected).toMatchObject({ block: true });
    expect(redirected.reason).toContain("miwarang_delegate");
    expect(unchanged).toBeUndefined();
  });

  test("delegates a wildcard target and reports resolvedVia wildcard", async () => {
    const { tools, calls } = makeHarness({ config: wildcardConfig });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
      mode: "foreground",
    });

    expect(calls[0][1]).toMatchObject({
      cwd: "/workspace",
      target: "category:writing",
      model: "qwen/qwen3.8-max",
    });
    expect(result.details).toMatchObject({
      sessionId: "ses_foreground",
      backend: "opencode",
      resolvedVia: "wildcard",
      model: "qwen/qwen3.8-max",
      target: "category:writing",
    });
  });

  test("override to a command backend uses the wildcard route models", async () => {
    const { tools, calls } = makeHarness({ config: wildcardConfig });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
      mode: "foreground",
      backend: "commandcode",
    });

    expect(calls[0][1]).toMatchObject({
      cwd: "/workspace",
      target: "category:writing",
      model: "qwen/qwen3.8-max",
    });
    expect(result.details).toMatchObject({
      sessionId: "ses_command_foreground",
      backend: "commandcode",
      resolvedVia: "wildcard",
      model: "qwen/qwen3.8-max",
    });
  });

  test("reports resolvedVia default for a target that only matches defaultRoute", async () => {
    const withDefault = {
      backends: { opencode: { type: "opencode-v2", command: "opencode" } },
      routes: {
        "category:quick": { backend: "opencode", models: ["opencode/space-bunny-free"] },
      },
      defaultRoute: { backend: "opencode", models: ["opencode/space-bunny-free"] },
    };
    const { tools } = makeHarness({ config: withDefault });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:brand-new",
      prompt: "Hello",
      mode: "foreground",
    });

    expect(result.details).toMatchObject({
      backend: "opencode",
      resolvedVia: "default",
      model: "opencode/space-bunny-free",
      target: "category:brand-new",
    });
  });

  test("rejects an override to an unknown backend with the configured error", async () => {
    const { tools } = makeHarness({ config: wildcardConfig });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:writing",
        prompt: "Write the docs",
        backend: "nope",
      }),
    ).rejects.toThrow("Backend nope is not configured");
  });

  test("fails closed for an unconfigured target with no wildcard or default", async () => {
    const bare = {
      backends: { opencode: { type: "opencode-v2", command: "opencode" } },
      routes: {},
    };
    const { tools } = makeHarness({ config: bare });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:unknown",
        prompt: "Do the thing",
      }),
    ).rejects.toThrow("No route configured for category:unknown");
  });
});
