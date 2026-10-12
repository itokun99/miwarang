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
];

function makeHarness() {
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
    config,
    backends: { opencode: backend },
  });

  return { tools, handlers, calls };
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
    expect(guidance).toMatch(/quick.*unspecified-low.*deep-low.*explore.*librarian/i);
    expect(guidance).toContain("category:quick");
    expect(guidance).toContain("agent:librarian");
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
    expect(result.details).toMatchObject({ sessionId: "ses_foreground" });
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
    expect(result.details).toMatchObject({ sessionId: "ses_background" });
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
});
