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

// Frozen v0.1.1 config shape: the opencode backend only, two exact routes, and
// none of the new-style keys (no wildcard route, no defaultRoute, no
// blockNativeTask, no pricePolicy, no commandcode backend). Pins legacy-config
// compatibility so the merged resolver cannot silently change old behavior.
const legacyConfig = {
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

// New-style config: an exact route alongside a category:* wildcard that points
// at a command backend with a different model list. Used to prove the wildcard
// route's models win over the pre-override/exact route list.
const wildcardOverrideConfig = {
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

  test("v0.1.1 fixture carries none of the new-style keys", () => {
    expect(Object.keys(legacyConfig.backends)).toEqual(["opencode"]);
    expect(Object.keys(legacyConfig.routes)).toEqual(["category:quick", "agent:explore"]);
    expect(legacyConfig.routes["category:*"]).toBeUndefined();
    expect(legacyConfig.routes["agent:*"]).toBeUndefined();
    expect(legacyConfig.defaultRoute).toBeUndefined();
    expect(legacyConfig.blockNativeTask).toBeUndefined();
    expect(legacyConfig.pricePolicy).toBeUndefined();
    expect(legacyConfig.backends.commandcode).toBeUndefined();
  });

  test("v0.1.1 fixture delegates category:quick to the opencode free model", async () => {
    const { tools, calls } = makeHarness({ config: legacyConfig });

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
      target: "category:quick",
    });
  });

  test("v0.1.1 fixture keeps the configured agent for agent:explore", async () => {
    const { tools, calls } = makeHarness({ config: legacyConfig });

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
      backend: "opencode",
      resolvedVia: "exact",
      target: "agent:explore",
    });
  });

  test("wildcard route with a command-backend override uses the wildcard models", async () => {
    const { tools, calls } = makeHarness({ config: wildcardOverrideConfig });

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
    // The wildcard route's models win; the exact route's pre-override list must not leak.
    expect(calls[0][1].model).not.toBe("opencode/space-bunny-free");
    expect(result.details).toMatchObject({
      sessionId: "ses_command_foreground",
      backend: "commandcode",
      resolvedVia: "wildcard",
      model: "qwen/qwen3.8-max",
      target: "category:writing",
    });
  });

  test("unknown target on a new-style config fails closed", async () => {
    const newStyleConfig = {
      backends: {
        opencode: { type: "opencode-v2", command: "opencode" },
        commandcode: { type: "command", command: "commandcode" },
      },
      routes: {
        "agent:*": { backend: "opencode", models: ["opencode/space-bunny-free"] },
      },
      pricePolicy: "free-only",
    };
    const { tools } = makeHarness({ config: newStyleConfig });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:unknown",
        prompt: "Do the thing",
      }),
    ).rejects.toThrow("No route configured for category:unknown");
  });
});

describe("native task blocking policy", () => {
  const policyBackends = { opencode: { type: "opencode-v2", command: "opencode" } };

  function route(blockNativeTask) {
    const entry = { backend: "opencode", models: ["opencode/space-bunny-free"] };
    if (blockNativeTask !== undefined) entry.blockNativeTask = blockNativeTask;
    return entry;
  }

  async function taskResult(activeConfig, input) {
    const { handlers } = makeHarness({ config: activeConfig });
    return handlers.get("tool_call")[0]({ toolName: "task", input });
  }

  test("blocks an exact route that opts in with blockNativeTask true", async () => {
    const activeConfig = { backends: policyBackends, routes: { "category:writing": route(true) } };

    const result = await taskResult(activeConfig, { category: "writing", prompt: "Write the docs" });

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("miwarang_delegate");
    expect(result.reason).toContain("category:writing");
  });

  test("passes through an exact route with blockNativeTask false", async () => {
    const activeConfig = { backends: policyBackends, routes: { "category:deep-high": route(false) } };

    const result = await taskResult(activeConfig, { category: "deep-high", prompt: "Think" });

    expect(result).toBeUndefined();
  });

  test("passes through a target that only matches defaultRoute", async () => {
    const activeConfig = {
      backends: policyBackends,
      routes: { "category:writing": route(true) },
      defaultRoute: route(true),
    };

    const result = await taskResult(activeConfig, { category: "brand-new", prompt: "Hello" });

    expect(result).toBeUndefined();
  });

  test("passes through an unresolvable target without throwing", async () => {
    const activeConfig = { backends: policyBackends, routes: {} };

    const result = await taskResult(activeConfig, { category: "unknown", prompt: "Hi" });

    expect(result).toBeUndefined();
  });

  test("treats an absent policy as configured: exact and wildcard block, defaultRoute does not", async () => {
    const activeConfig = {
      backends: policyBackends,
      routes: { "category:writing": route(undefined), "category:*": route(undefined) },
      defaultRoute: route(undefined),
    };

    expect(await taskResult(activeConfig, { category: "writing" })).toMatchObject({ block: true });
    expect(await taskResult(activeConfig, { category: "other" })).toMatchObject({ block: true });
    expect(await taskResult(activeConfig, { agent: "thing" })).toBeUndefined();
  });

  test('top-level "all" blocks configured targets that carry no per-route flag', async () => {
    const activeConfig = {
      backends: policyBackends,
      blockNativeTask: "all",
      routes: { "category:writing": route(undefined), "category:*": route(undefined) },
    };

    expect(await taskResult(activeConfig, { category: "writing" })).toMatchObject({ block: true });
    expect(await taskResult(activeConfig, { category: "other" })).toMatchObject({ block: true });
  });

  test('top-level "none" passes configured targets unless the route opts in', async () => {
    const activeConfig = {
      backends: policyBackends,
      blockNativeTask: "none",
      routes: { "category:writing": route(undefined), "category:architect": route(true) },
    };

    expect(await taskResult(activeConfig, { category: "writing" })).toBeUndefined();
    expect(await taskResult(activeConfig, { category: "architect" })).toMatchObject({ block: true });
  });

  test("per-route false overrides a top-level blocking policy", async () => {
    const activeConfig = {
      backends: policyBackends,
      blockNativeTask: "all",
      routes: { "category:deep-high": route(false) },
    };

    expect(await taskResult(activeConfig, { category: "deep-high" })).toBeUndefined();
  });

  test("array flag blocks only the listed targets", async () => {
    const activeConfig = {
      backends: policyBackends,
      routes: {
        "category:writing": route(["category:writing"]),
        "category:*": route(["category:writing"]),
      },
    };

    expect(await taskResult(activeConfig, { category: "writing" })).toMatchObject({ block: true });
    expect(await taskResult(activeConfig, { category: "other" })).toBeUndefined();
  });

  test("array flag with a namespace wildcard covers every target in that namespace", async () => {
    const activeConfig = {
      backends: policyBackends,
      routes: { "category:*": route(["category:*"]) },
    };

    expect(await taskResult(activeConfig, { category: "anything" })).toMatchObject({ block: true });
    expect(await taskResult(activeConfig, { agent: "explore" })).toBeUndefined();
  });

  test("blocks a batched task when any target is policy-blocked", async () => {
    const activeConfig = {
      backends: policyBackends,
      routes: { "category:writing": route(true), "category:deep-high": route(false) },
    };

    const result = await taskResult(activeConfig, {
      tasks: [{ category: "deep-high" }, { category: "writing" }],
    });

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("category:writing");
    expect(result.reason).not.toContain("category:deep-high");
  });

  const matrixKinds = ["exact", "wildcard", "default", "no-match"];
  const matrixFlags = [false, true, undefined];
  const matrixTop = ["configured", "all", "none"];

  function matrixConfig(kind, flag, top) {
    const routes = {};
    if (kind === "exact") {
      routes["category:writing"] = route(flag);
      routes["category:*"] = route(undefined);
    } else if (kind === "wildcard") {
      routes["category:*"] = route(flag);
    } else if (kind === "default") {
      routes["category:unrelated"] = route(undefined);
    } else {
      routes["category:unrelated"] = route(flag);
    }
    const activeConfig = { backends: policyBackends, routes, blockNativeTask: top };
    if (kind === "default") activeConfig.defaultRoute = route(flag);
    return activeConfig;
  }

  const matrixTarget = {
    exact: { category: "writing" },
    wildcard: { category: "other" },
    default: { agent: "thing" },
    "no-match": { category: "writing" },
  };

  function matrixExpected(kind, flag, top) {
    if (kind === "default" || kind === "no-match") return false;
    if (flag === false) return false;
    if (flag === true) return true;
    return top !== "none";
  }

  for (const kind of matrixKinds) {
    for (const flag of matrixFlags) {
      for (const top of matrixTop) {
        const label =
          `matrix ${kind} / route flag ${flag === undefined ? "none" : flag} / top ${top}`;
        test(label, async () => {
          const result = await taskResult(matrixConfig(kind, flag, top), matrixTarget[kind]);

          if (matrixExpected(kind, flag, top)) {
            expect(result).toMatchObject({ block: true });
            expect(result.reason).toContain("miwarang_delegate");
          } else {
            expect(result).toBeUndefined();
          }
        });
      }
    }
  }
});
