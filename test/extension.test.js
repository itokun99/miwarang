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

function makeHarness({ config: activeConfig = config, backends, runStore, timers } = {}) {
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
    // Production command backends return undefined unless listModelsArgv is
    // configured (or when the probe fails); tests that need a live command
    // catalogue inject their own backend.
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

async function invoke(tool, params, ctx = { cwd: "/workspace" }) {
  return tool.execute("test-call", params, undefined, undefined, ctx);
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
    expect(guidance).toContain("omo.jsonc");
    expect(guidance).toContain("OMO configuration supplies intent/category only");
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

describe("progress surfaces", () => {
  function uiRecorder() {
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

  test("the status line shows a run on start and clears after wait", async () => {
    const { tools } = makeHarness();
    const { statuses, ui } = uiRecorder();
    const ctx = { cwd: "/workspace", ui };

    await invoke(
      tools.get("miwarang_delegate"),
      { target: "agent:explore", prompt: "List files", mode: "background" },
      ctx,
    );
    expect(statuses.at(-1)[0]).toBe("miwarang");
    expect(statuses.at(-1)[1]).toContain("1 active");
    expect(statuses.at(-1)[1]).toContain("ses_");

    await invoke(tools.get("miwarang_wait"), { sessionId: "ses_background" }, ctx);
    expect(statuses.at(-1)).toEqual(["miwarang", undefined]);
  });

  test("tracks and waits for five background runs without a DAG child", async () => {
    const sessions = [];
    const opencode = {
      listModels: async () => liveModels,
      start: async () => {
        const sessionId = `ses_multi_${sessions.length + 1}`;
        sessions.push(sessionId);
        return { sessionId, state: "running" };
      },
      wait: async (sessionId) => ({
        sessionId,
        state: "completed",
        text: `completed ${sessionId}`,
      }),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({ backends: { opencode } });
    const { statuses, ui } = uiRecorder();
    const ctx = { cwd: "/workspace", ui };

    const started = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        invoke(
          tools.get("miwarang_delegate"),
          {
            target: "category:quick",
            prompt: `Background task ${index + 1}`,
            mode: "background",
          },
          ctx,
        ),
      ),
    );
    const ids = started.map((result) => result.details.sessionId);
    expect(ids).toEqual([
      "ses_multi_1",
      "ses_multi_2",
      "ses_multi_3",
      "ses_multi_4",
      "ses_multi_5",
    ]);
    const completed = await Promise.all(
      ids.map((sessionId) =>
        invoke(tools.get("miwarang_wait"), { sessionId }, ctx),
      ),
    );
    expect(completed.map((result) => result.content[0].text)).toEqual([
      "completed ses_multi_1",
      "completed ses_multi_2",
      "completed ses_multi_3",
      "completed ses_multi_4",
      "completed ses_multi_5",
    ]);
    expect(statuses.at(-1)).toEqual(["miwarang", undefined]);
  });

  test("/miwarang reports the tracked runs", async () => {
    const { tools, commands } = makeHarness();
    const { notices, ui } = uiRecorder();
    const ctx = { cwd: "/workspace", ui };

    await invoke(
      tools.get("miwarang_delegate"),
      { target: "agent:explore", prompt: "List files", mode: "background" },
      ctx,
    );
    await commands.get("miwarang").handler("", ctx);

    const [text, level] = notices.at(-1);
    expect(text).toContain("ses_background");
    expect(text).toContain("agent:explore");
    expect(level).toBe("info");
  });

  test("the command backend status line polls the run store while alive", async () => {
    const intervals = [];
    const { tools } = makeHarness({
      config: wildcardOverrideConfig,
      timers: {
        setInterval: (fn, ms) => {
          intervals.push(ms);
          return intervals.length;
        },
        clearInterval: () => {},
      },
    });
    const { ui } = uiRecorder();

    await invoke(
      tools.get("miwarang_delegate"),
      { target: "category:architect", prompt: "Do it", mode: "background" },
      { cwd: "/workspace", ui },
    );

    expect(intervals).toEqual([15000]);
  });
});

describe("target model availability", () => {
  const probeConfig = {
    backends: {
      commandcode: { type: "command", command: "commandcode", listModelsArgv: ["--list-models"] },
    },
    routes: {
      "category:writing": {
        backend: "commandcode",
        models: ["qwen/qwen3.8-max", "moonshotai/kimi-k3"],
      },
    },
  };

  const qwen = { providerID: "qwen", id: "qwen3.8-max", cost: { input: 1, output: 1 } };
  const kimi = { providerID: "moonshotai", id: "kimi-k3", cost: { input: 1, output: 1 } };
  const beamFree = { providerID: "reflection", id: "beam:free", cost: { input: 0, output: 0 } };

  function probeBackend(catalog) {
    const calls = [];
    return {
      calls,
      listModels: async () => catalog,
      runForeground: async (request) => {
        calls.push(["foreground", request]);
        return { sessionId: "ses_probe", text: `probe ran ${request.model}` };
      },
      start: async (request) => {
        calls.push(["start", request]);
        return { sessionId: "ses_probe_bg", state: "running" };
      },
      wait: async (sessionId) => ({ sessionId, text: "probe wait" }),
      cancel: async (sessionId) => ({ sessionId, interrupted: true }),
    };
  }

  test("an unavailable first candidate is skipped for the next probed model", async () => {
    const backend = probeBackend([kimi]);
    const { tools } = makeHarness({ config: probeConfig, backends: { commandcode: backend } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
    });

    expect(backend.calls[0][1].model).toBe("moonshotai/kimi-k3");
    expect(result.details.model).toBe("moonshotai/kimi-k3");
  });

  test("an override that is not in the probed catalogue is rejected", async () => {
    const backend = probeBackend([kimi]);
    const { tools } = makeHarness({ config: probeConfig, backends: { commandcode: backend } });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:writing",
        prompt: "Write the docs",
        model: "cloviela/glm-5.3-flash",
      }),
    ).rejects.toThrow(
      "Requested model cloviela/glm-5.3-flash is not in the live model catalog (catalog: 1 models)",
    );
    expect(backend.calls).toHaveLength(0);
  });

  test("an override that exists in the probed catalogue is honoured", async () => {
    const backend = probeBackend([qwen, kimi]);
    const { tools } = makeHarness({ config: probeConfig, backends: { commandcode: backend } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
      model: "moonshotai/kimi-k3",
    });

    expect(backend.calls[0][1].model).toBe("moonshotai/kimi-k3");
    expect(result.details.model).toBe("moonshotai/kimi-k3");
  });

  test("a route without models inherits the top-level defaultModels chain", async () => {
    const inheritedConfig = {
      backends: { opencode: { type: "opencode-v2", command: "opencode" } },
      defaultModels: ["opencode/space-bunny-free", "opencode-go/longcat-2.5-preview-free"],
      routes: { "category:quick": { backend: "opencode", freeOnly: true } },
    };
    const { tools, calls } = makeHarness({ config: inheritedConfig });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:quick",
      prompt: "Hello",
    });

    expect(calls[0][1].model).toBe("opencode/space-bunny-free");
    expect(result.details.model).toBe("opencode/space-bunny-free");
  });

  test("a freeOnly route on a probing command backend only accepts free models", async () => {
    const freeOnlyConfig = {
      backends: {
        commandcode: { type: "command", command: "commandcode", listModelsArgv: ["--list-models"] },
      },
      routes: {
        "category:writing": {
          backend: "commandcode",
          models: ["qwen/qwen3.8-max", "reflection/beam:free"],
          freeOnly: true,
        },
      },
    };

    const paidOnly = probeBackend([qwen]);
    await expect(
      invoke(makeHarness({ config: freeOnlyConfig, backends: { commandcode: paidOnly } }).tools.get("miwarang_delegate"), {
        target: "category:writing",
        prompt: "Write the docs",
      }),
    ).rejects.toThrow(/no available free model/i);

    const withFree = probeBackend([qwen, beamFree]);
    const result = await invoke(
      makeHarness({ config: freeOnlyConfig, backends: { commandcode: withFree } }).tools.get("miwarang_delegate"),
      { target: "category:writing", prompt: "Write the docs" },
    );

    expect(result.details.model).toBe("reflection/beam:free");
  });
});

describe("foreground failover", () => {
  const failoverConfig = {
    backends: { opencode: { type: "opencode-v2", command: "opencode" } },
    routes: {
      "category:quick": {
        backend: "opencode",
        models: ["opencode/space-bunny-free", "opencode-go/longcat-2.5-preview-free"],
        freeOnly: true,
      },
    },
  };

  function flakyBackend(script) {
    const calls = [];
    return {
      calls,
      listModels: async () => liveModels,
      runForeground: async (request) => {
        calls.push(["foreground", request]);
        const outcome = script[request.model];
        if (!outcome) throw new Error(`no outcome for ${request.model}`);
        if (outcome.error) throw new Error(outcome.error);
        return { sessionId: "ses_after_failover", text: outcome.text };
      },
      start: async (request) => {
        calls.push(["start", request]);
        throw new Error(script.startError ?? "start failed");
      },
      wait: async () => ({}),
      cancel: async () => ({}),
    };
  }

  const providerError = (id) =>
    `OpenCode session ${id} failed: provider.quota (402) Upstream request failed: Endpoint is unavailable.`;

  test("a provider failure retries the next configured candidate", async () => {
    const backend = flakyBackend({
      "opencode/space-bunny-free": { error: providerError("ses_1") },
      "opencode-go/longcat-2.5-preview-free": { text: "Recovered result" },
    });
    const { tools } = makeHarness({ config: failoverConfig, backends: { opencode: backend } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:quick",
      prompt: "Inspect this project",
    });

    expect(backend.calls.map((call) => call[1].model)).toEqual([
      "opencode/space-bunny-free",
      "opencode-go/longcat-2.5-preview-free",
    ]);
    expect(result.content[0].text).toContain("Recovered result");
    expect(result.details.model).toBe("opencode-go/longcat-2.5-preview-free");
  });

  test("failover stops after the last candidate and surfaces its error", async () => {
    const backend = flakyBackend({
      "opencode/space-bunny-free": { error: providerError("ses_1") },
      "opencode-go/longcat-2.5-preview-free": { error: providerError("ses_2") },
    });
    const { tools } = makeHarness({ config: failoverConfig, backends: { opencode: backend } });

    await expect(
      invoke(tools.get("miwarang_delegate"), { target: "category:quick", prompt: "Inspect" }),
    ).rejects.toThrow(/ses_2/);
    expect(backend.calls).toHaveLength(2);
  });

  test("an explicit model override is never retried on another model", async () => {
    const backend = flakyBackend({
      "opencode/space-bunny-free": { error: providerError("ses_1") },
      "opencode-go/longcat-2.5-preview-free": { text: "should not run" },
    });
    const { tools } = makeHarness({ config: failoverConfig, backends: { opencode: backend } });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:quick",
        prompt: "Inspect",
        model: "opencode/space-bunny-free",
      }),
    ).rejects.toThrow(/provider\.quota/);
    expect(backend.calls).toHaveLength(1);
  });

  test("non-provider failures do not trigger failover", async () => {
    const backend = flakyBackend({
      "opencode/space-bunny-free": { error: "OpenCode configuration rejected the request" },
      "opencode-go/longcat-2.5-preview-free": { text: "should not run" },
    });
    const { tools } = makeHarness({ config: failoverConfig, backends: { opencode: backend } });

    await expect(
      invoke(tools.get("miwarang_delegate"), { target: "category:quick", prompt: "Inspect" }),
    ).rejects.toThrow(/configuration rejected/);
    expect(backend.calls).toHaveLength(1);
  });

  test("background start failures exhaust configured models before surfacing", async () => {
    const backend = flakyBackend({ startError: providerError("ses_1") });
    const { tools } = makeHarness({ config: failoverConfig, backends: { opencode: backend } });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:quick",
        prompt: "Inspect",
        mode: "background",
      }),
    ).rejects.toThrow(/provider\.quota/);
    expect(backend.calls).toHaveLength(2);
  });

  test("provider exhaustion falls back to the configured command backend", async () => {
    const configWithBackendFallback = {
      backends: {
        opencode: { type: "opencode-v2", command: "opencode" },
        commandcode: { type: "command", command: "commandcode" },
      },
      routes: {
        "category:quick": {
          backend: "opencode",
          models: ["opencode/space-bunny-free", "opencode-go/longcat-2.5-preview-free"],
          freeOnly: true,
          fallbacks: [
            {
              backend: "commandcode",
              models: ["qwen/qwen3.8-max"],
            },
          ],
        },
      },
    };
    const opencode = flakyBackend({
      "opencode/space-bunny-free": { error: providerError("ses_1") },
      "opencode-go/longcat-2.5-preview-free": { error: providerError("ses_2") },
    });
    const commandcode = {
      calls: [],
      listModels: async () => undefined,
      runForeground: async (request) => {
        commandcode.calls.push(["foreground", request]);
        return { sessionId: "ses_commandcode", text: "Recovered result" };
      },
      start: async () => ({ runId: "run_commandcode", state: "running" }),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({
      config: configWithBackendFallback,
      backends: { opencode, commandcode },
    });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:quick",
      prompt: "Inspect this project",
    });

    expect(opencode.calls.map((call) => call[1].model)).toEqual([
      "opencode/space-bunny-free",
      "opencode-go/longcat-2.5-preview-free",
    ]);
    expect(commandcode.calls[0][1].model).toBe("qwen/qwen3.8-max");
    expect(result.content[0].text).toBe("Recovered result");
    expect(result.details).toMatchObject({
      backend: "commandcode",
      model: "qwen/qwen3.8-max",
      fallback: true,
      fallbackIndex: 1,
    });
  });

  test("commandcode quota exhaustion advances from free to cheap models", async () => {
    const configWithCheapFallback = {
      backends: {
        opencode: { type: "opencode-v2", command: "opencode" },
        commandcode: { type: "command", command: "commandcode" },
      },
      routes: {
        "category:quick": {
          backend: "opencode",
          models: ["opencode/space-bunny-free"],
          freeOnly: true,
          fallbacks: [
            {
              backend: "commandcode",
              models: ["reflection/beam:free", "deepseek/deepseek-v4-flash"],
            },
          ],
        },
      },
    };
    const opencode = {
      listModels: async () => liveModels,
      runForeground: async () => {
        throw new Error(providerError("ses_opencode"));
      },
      start: async () => ({ sessionId: "ses_opencode", state: "running" }),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const commandcode = {
      calls: [],
      listModels: async () => undefined,
      runForeground: async (request) => {
        commandcode.calls.push(request);
        if (commandcode.calls.length === 1) {
          throw new Error(
            "Configured command failed with exit code 1: You've reached your 5-hour usage limit",
          );
        }
        return { sessionId: "ses_commandcode", text: "Cheap model result" };
      },
      start: async () => ({ runId: "run_commandcode", state: "running" }),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({
      config: configWithCheapFallback,
      backends: { opencode, commandcode },
    });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:quick",
      prompt: "Inspect this project",
    });

    expect(commandcode.calls.map((request) => request.model)).toEqual([
      "reflection/beam:free",
      "deepseek/deepseek-v4-flash",
    ]);
    expect(result.content[0].text).toBe("Cheap model result");
    expect(result.details).toMatchObject({
      backend: "commandcode",
      model: "deepseek/deepseek-v4-flash",
      fallback: true,
    });
  });

  test("background start failure falls back before returning a run ID", async () => {
    const configWithBackendFallback = {
      backends: {
        opencode: { type: "opencode-v2", command: "opencode" },
        commandcode: { type: "command", command: "commandcode" },
      },
      routes: {
        "category:deep-high": {
          backend: "opencode",
          models: ["opencode/deepseek-v4.1-flash-free"],
          freeOnly: true,
          fallbacks: [
            {
              backend: "commandcode",
              models: ["reflection/beam:free"],
            },
          ],
        },
      },
    };
    const opencode = {
      listModels: async () => [
        {
          providerID: "opencode",
          id: "deepseek-v4.1-flash-free",
          cost: { input: 0, output: 0 },
        },
      ],
      start: async () => {
        throw new Error(
          "OpenCode API POST /api/session/ses_test/prompt failed (exit 1)",
        );
      },
      runForeground: async () => {
        throw new Error("should not run foreground");
      },
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const commandcode = {
      calls: [],
      listModels: async () => undefined,
      start: async (request) => {
        commandcode.calls.push(request);
        return { runId: "run_commandcode", state: "running" };
      },
      runForeground: async () => {
        throw new Error("should not run foreground");
      },
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({
      config: configWithBackendFallback,
      backends: { opencode, commandcode },
    });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:deep-high",
      prompt: "Inspect this project",
      mode: "background",
    });

    expect(commandcode.calls[0].model).toBe("reflection/beam:free");
    expect(result.details).toMatchObject({
      backend: "commandcode",
      model: "reflection/beam:free",
      fallback: true,
      fallbackIndex: 1,
    });
  });

  test("catalogue exhaustion selects a backend fallback before execution", async () => {
    const configWithBackendFallback = {
      backends: {
        opencode: { type: "opencode-v2", command: "opencode" },
        commandcode: { type: "command", command: "commandcode" },
      },
      routes: {
        "category:quick": {
          backend: "opencode",
          models: ["opencode/space-bunny-free"],
          freeOnly: true,
          fallbacks: [{ backend: "commandcode", models: ["qwen/qwen3.8-max"] }],
        },
      },
    };
    const opencode = {
      calls: [],
      listModels: async () => [],
      runForeground: async (request) => {
        opencode.calls.push(request);
        throw new Error("should not run");
      },
      start: async () => ({ sessionId: "ses_unexpected", state: "running" }),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const commandcode = {
      calls: [],
      listModels: async () => undefined,
      runForeground: async (request) => {
        commandcode.calls.push(request);
        return { sessionId: "ses_commandcode", text: "Catalogue fallback result" };
      },
      start: async () => ({ runId: "run_commandcode", state: "running" }),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({
      config: configWithBackendFallback,
      backends: { opencode, commandcode },
    });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:quick",
      prompt: "Inspect this project",
    });

    expect(opencode.calls).toHaveLength(0);
    expect(commandcode.calls[0].model).toBe("qwen/qwen3.8-max");
    expect(result.details.backend).toBe("commandcode");
  });
});
