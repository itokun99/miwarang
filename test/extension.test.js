import { describe, expect, test } from "bun:test";
import { backendForRun, configuredCommandModels, setupExtension } from "../src/extension.js";
import { resolveTargetRoute } from "../src/config.js";

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

function makeHarness({ config: activeConfig = config, backends, runStore } = {}) {
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
    backends: backends ?? { opencode: backend, commandcode: commandBackend },
    runStore,
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

// GAP-2 / F-1: with more than one command backend configured, a run_ ID must
// resolve to the backend that created it (recorded in the run store) instead of
// the first command backend in config order. The legacy id-prefix heuristic is
// the fallback only when no record exists.
describe("run backend resolution (run store)", () => {
  const multiCommandConfig = {
    backends: {
      command: { type: "command", command: "commandcode" },
      claude: { type: "command", command: "claude" },
    },
    routes: {
      "category:*": { backend: "command", models: ["qwen/qwen3.8-max"] },
    },
  };

  const records = {
    run_A: { id: "run_A", backend: "command", state: "completed" },
    run_B: { id: "run_B", backend: "claude", state: "completed" },
  };

  function fakeRunStore(seed = records) {
    const gets = [];
    return {
      gets,
      async get(id) {
        gets.push(id);
        return seed[id];
      },
    };
  }

  test("resolves a run_ ID through the store record, not config order", async () => {
    const store = fakeRunStore();

    expect(await backendForRun(multiCommandConfig, "run_A", undefined, store)).toBe("command");
    expect(await backendForRun(multiCommandConfig, "run_B", undefined, store)).toBe("claude");
    expect(store.gets).toEqual(["run_A", "run_B"]);
  });

  test("an explicit backend parameter wins over the store record", async () => {
    const store = fakeRunStore();

    expect(await backendForRun(multiCommandConfig, "run_A", "claude", store)).toBe("claude");
    expect(await backendForRun(multiCommandConfig, "run_B", "command", store)).toBe("command");
    expect(store.gets).toEqual([]);
  });

  test("falls back to the legacy heuristic when no record exists", async () => {
    const store = fakeRunStore();

    expect(await backendForRun(multiCommandConfig, "run_x", undefined, store)).toBe("command");
    expect(store.gets).toEqual(["run_x"]);
  });

  test("throws a descriptive error when no record and no heuristic can resolve", async () => {
    await expect(
      backendForRun(multiCommandConfig, "unknown", undefined, fakeRunStore()),
    ).rejects.toThrow("Cannot determine backend for run ID unknown");
  });

  test("resolves ses_ IDs to opencode-v2 without touching the store", async () => {
    const mixedConfig = {
      backends: {
        opencode: { type: "opencode-v2", command: "opencode" },
        command: { type: "command", command: "commandcode" },
      },
      routes: { "category:*": { backend: "opencode", models: ["opencode/space-bunny-free"] } },
    };
    const store = fakeRunStore();

    expect(await backendForRun(mixedConfig, "ses_abc", undefined, store)).toBe("opencode");
    expect(store.gets).toEqual([]);
  });

  test("waits and cancels through the backend recorded for the run", async () => {
    const calls = [];
    function commandLike(id) {
      return {
        wait: async (runId) => {
          calls.push([`${id}:wait`, runId]);
          return { runId, text: `${id} result` };
        },
        cancel: async (runId) => {
          calls.push([`${id}:cancel`, runId]);
          return { runId, state: "cancelling" };
        },
      };
    }
    const { tools } = makeHarness({
      config: multiCommandConfig,
      backends: { command: commandLike("command"), claude: commandLike("claude") },
      runStore: fakeRunStore(),
    });

    const waited = await invoke(tools.get("miwarang_wait"), { runId: "run_B" });
    const cancelled = await invoke(tools.get("miwarang_cancel"), { runId: "run_B" });

    expect(waited.details.backend).toBe("claude");
    expect(cancelled.details.backend).toBe("claude");
    expect(calls).toEqual([
      ["claude:wait", "run_B"],
      ["claude:cancel", "run_B"],
    ]);
  });

  test("stale state: a missing record falls back without crashing", async () => {
    const store = fakeRunStore();

    expect(await backendForRun(multiCommandConfig, "run_missing", undefined, store)).toBe("command");
  });

  test("malformed input: empty and non-string IDs are rejected", async () => {
    await expect(
      backendForRun(multiCommandConfig, "", undefined, fakeRunStore()),
    ).rejects.toThrow("Cannot determine backend for run ID ");
    await expect(
      backendForRun(multiCommandConfig, 123, undefined, fakeRunStore()),
    ).rejects.toThrow(TypeError);
  });

  test("a store record naming an unconfigured backend falls back to the heuristic", async () => {
    const store = fakeRunStore({ run_A: { id: "run_A", backend: "ghost" } });

    expect(await backendForRun(multiCommandConfig, "run_A", undefined, store)).toBe("command");
  });
});

// GAP-3: a freeOnly route may target a command backend when the effective
// pricePolicy ("any"|"freeOnly", default "any") allows it. The route-level
// policy wins over the backend-level one.
describe("command backend pricePolicy", () => {
  const commandBackends = {
    commandcode: { type: "command", command: "commandcode" },
  };

  const CATALOG_ERROR = "freeOnly routes require a backend with a live model catalog";

  function resolvedRoute(routeOverrides = {}, backends = commandBackends) {
    const route = {
      backend: "commandcode",
      models: ["qwen/qwen3.8-max", "moonshotai/kimi-k3"],
      freeOnly: true,
      ...routeOverrides,
    };
    return resolveTargetRoute(
      { backends, routes: { "category:writing": route } },
      "category:writing",
    );
  }

  test("a freeOnly route does not throw when the route pricePolicy is any", () => {
    const models = configuredCommandModels(resolvedRoute({ pricePolicy: "any" }));

    expect(models).toEqual([
      { providerID: "qwen", id: "qwen3.8-max", cost: { input: 1, output: 1 } },
      { providerID: "moonshotai", id: "kimi-k3", cost: { input: 1, output: 1 } },
    ]);
  });

  test("a freeOnly route throws the catalog error when the route pricePolicy is freeOnly", () => {
    expect(() => configuredCommandModels(resolvedRoute({ pricePolicy: "freeOnly" }))).toThrow(
      CATALOG_ERROR,
    );
  });

  test("a freeOnly route defaults to any and does not throw", () => {
    expect(() => configuredCommandModels(resolvedRoute())).not.toThrow();
  });

  test("a model override on a freeOnly route with pricePolicy any resolves", () => {
    const models = configuredCommandModels(resolvedRoute({ pricePolicy: "any" }), "qwen/qwen3.8-max");

    expect(models).toEqual([
      { providerID: "qwen", id: "qwen3.8-max", cost: { input: 1, output: 1 } },
    ]);
  });

  test("backend pricePolicy freeOnly makes a freeOnly route throw", () => {
    const backends = {
      commandcode: { type: "command", command: "commandcode", pricePolicy: "freeOnly" },
    };

    expect(() => configuredCommandModels(resolvedRoute({}, backends))).toThrow(CATALOG_ERROR);
  });

  test("backend pricePolicy any lets a freeOnly route pass", () => {
    const backends = {
      commandcode: { type: "command", command: "commandcode", pricePolicy: "any" },
    };

    expect(() => configuredCommandModels(resolvedRoute({}, backends))).not.toThrow();
  });

  test("route pricePolicy any overrides backend pricePolicy freeOnly", () => {
    const backends = {
      commandcode: { type: "command", command: "commandcode", pricePolicy: "freeOnly" },
    };

    expect(() =>
      configuredCommandModels(resolvedRoute({ pricePolicy: "any" }, backends)),
    ).not.toThrow();
  });

  test("route pricePolicy freeOnly overrides backend pricePolicy any", () => {
    const backends = {
      commandcode: { type: "command", command: "commandcode", pricePolicy: "any" },
    };

    expect(() =>
      configuredCommandModels(resolvedRoute({ pricePolicy: "freeOnly" }, backends)),
    ).toThrow(CATALOG_ERROR);
  });

  test("a non-freeOnly route never throws, even with pricePolicy freeOnly", () => {
    expect(() =>
      configuredCommandModels(resolvedRoute({ freeOnly: false, pricePolicy: "freeOnly" })),
    ).not.toThrow();
  });

  test("the delegate surfaces the catalog error for a freeOnly command route with pricePolicy freeOnly", async () => {
    const activeConfig = {
      backends: { commandcode: { type: "command", command: "commandcode" } },
      routes: {
        "category:writing": {
          backend: "commandcode",
          models: ["qwen/qwen3.8-max"],
          freeOnly: true,
          pricePolicy: "freeOnly",
        },
      },
    };
    const { tools } = makeHarness({ config: activeConfig });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:writing",
        prompt: "Write the docs",
      }),
    ).rejects.toThrow(CATALOG_ERROR);
  });

  test("a freeOnly route with pricePolicy any delegates successfully to a command backend", async () => {
    const activeConfig = {
      backends: { commandcode: { type: "command", command: "commandcode" } },
      routes: {
        "category:writing": {
          backend: "commandcode",
          models: ["qwen/qwen3.8-max", "moonshotai/kimi-k3"],
          freeOnly: true,
          pricePolicy: "any",
        },
      },
    };
    const { tools, calls } = makeHarness({ config: activeConfig });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
      mode: "foreground",
    });

    expect(calls[0][1]).toMatchObject({
      target: "category:writing",
      model: "qwen/qwen3.8-max",
    });
    expect(result.details).toMatchObject({
      backend: "commandcode",
      resolvedVia: "exact",
      model: "qwen/qwen3.8-max",
    });
    expect(result.content[0].text).toContain("Command foreground result");
  });

  test("pricePolicy any does not bypass the live-catalog gate for opencode-v2", async () => {
    const paidCatalog = [
      { providerID: "opencode", id: "claude-sonnet-5", cost: { input: 3, output: 15 } },
    ];
    const opencodeBackend = {
      listModels: async () => paidCatalog,
      runForeground: async () => ({ sessionId: "ses_should_not_run", text: "should not run" }),
      start: async () => ({ sessionId: "ses_should_not_run", state: "running" }),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const activeConfig = {
      backends: { opencode: { type: "opencode-v2", command: "opencode" } },
      routes: {
        "category:quick": {
          backend: "opencode",
          models: ["opencode/claude-sonnet-5"],
          freeOnly: true,
          pricePolicy: "any",
        },
      },
    };
    const { tools } = makeHarness({
      config: activeConfig,
      backends: { opencode: opencodeBackend },
    });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:quick",
        prompt: "Do the thing",
      }),
    ).rejects.toThrow(/free/i);
  });
});
