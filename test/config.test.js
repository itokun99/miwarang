import { describe, expect, test } from "bun:test";
import { resolveRoute, resolveTargetRoute, validateConfig } from "../src/config.js";

const liveModels = [
  {
    providerID: "opencode",
    id: "space-bunny-free",
    cost: { input: 0, output: 0 },
  },
  {
    providerID: "opencode-go",
    id: "step-5-preview-free",
    cost: { input: 0, output: 0 },
  },
  {
    providerID: "opencode",
    id: "claude-sonnet-5",
    cost: { input: 3, output: 15 },
  },
];

const config = {
  backends: {
    opencode: { type: "opencode-v2", command: "opencode" },
  },
  routes: {
    "category:quick": {
      backend: "opencode",
      models: [
        "opencode/not-in-catalog",
        "opencode/claude-sonnet-5",
        "opencode/space-bunny-free",
      ],
      freeOnly: true,
    },
    "agent:explore": {
      backend: "opencode",
      models: ["opencode-go/step-5-preview-free"],
      freeOnly: true,
      agent: "explore",
    },
  },
};

describe("resolveRoute", () => {
  test("selects the first available free model from a category route", () => {
    expect(resolveRoute(config, "category:quick", liveModels)).toEqual({
      backend: { type: "opencode-v2", command: "opencode" },
      target: "category:quick",
      model: "opencode/space-bunny-free",
      freeOnly: true,
    });
  });

  test("preserves the configured agent for an agent route", () => {
    expect(resolveRoute(config, "agent:explore", liveModels)).toEqual({
      backend: { type: "opencode-v2", command: "opencode" },
      target: "agent:explore",
      model: "opencode-go/step-5-preview-free",
      agent: "explore",
      freeOnly: true,
    });
  });

  test("recognizes OpenCode array-shaped zero-cost tiers as free", () => {
    const model = {
      providerID: "opencode",
      id: "space-bunny-free",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    };

    expect(resolveRoute(config, "category:quick", [model]).model).toBe(
      "opencode/space-bunny-free",
    );
  });

  test("rejects array-shaped pricing when any tier is paid", () => {
    const model = {
      providerID: "opencode",
      id: "space-bunny-free",
      cost: [
        { input: 0, output: 0, cache: { read: 0, write: 0 } },
        { input: 1, output: 2, cache: { read: 0, write: 0 } },
      ],
    };

    expect(() => resolveRoute(config, "category:quick", [model])).toThrow(
      /no available free model/i,
    );
  });

  test("accepts an explicit available model override", () => {
    expect(
      resolveRoute(config, "category:quick", liveModels, {
        model: "opencode-go/step-5-preview-free",
      }).model,
    ).toBe("opencode-go/step-5-preview-free");
  });

  test("rejects an explicit paid model on a free-only route", () => {
    expect(() =>
      resolveRoute(config, "category:quick", liveModels, {
        model: "opencode/claude-sonnet-5",
      }),
    ).toThrow(/free/i);
  });

  test("fails when no configured free candidate is available", () => {
    expect(() =>
      resolveRoute(config, "category:quick", [liveModels[2]]),
    ).toThrow(/no available free model/i);
  });

  test("fails clearly for an unconfigured target", () => {
    expect(() =>
      resolveRoute(config, "category:unknown", liveModels),
    ).toThrow(/no route configured/i);
  });
});

describe("resolveTargetRoute", () => {
  const qaBackends = {
    opencode: { type: "opencode-v2", command: "opencode" },
    claudeCli: { type: "command", command: "claude" },
  };

  const qaConfig = {
    backends: qaBackends,
    routes: {
      "category:writing": {
        backend: "opencode",
        models: ["opencode/space-bunny-free"],
        freeOnly: true,
      },
      "category:*": {
        backend: "claudeCli",
        models: ["claude-sonnet-5"],
      },
      "agent:explore": {
        backend: "opencode",
        models: ["opencode/space-bunny-free"],
      },
    },
    defaultRoute: {
      backend: "claudeCli",
      models: ["claude-haiku-5"],
    },
  };

  test("prefers the exact route key over wildcard and default", () => {
    const result = resolveTargetRoute(qaConfig, "category:writing");
    expect(result.key).toBe("category:writing");
    expect(result.target).toBe("category:writing");
    expect(result.backend).toEqual(qaBackends.opencode);
    expect(result.backendName).toBe("opencode");
    expect(result.backend.type).toBe("opencode-v2");
    expect(result.models).toEqual(["opencode/space-bunny-free"]);
    expect(result.freeOnly).toBe(true);
  });

  test("falls back to the category:* wildcard route", () => {
    const result = resolveTargetRoute(qaConfig, "category:anything");
    expect(result.key).toBe("category:*");
    expect(result.target).toBe("category:anything");
    expect(result.backend).toEqual(qaBackends.claudeCli);
    expect(result.backendName).toBe("claudeCli");
    expect(result.backend.type).toBe("command");
    expect(result.models).toEqual(["claude-sonnet-5"]);
  });

  test("agent targets reach the agent:* wildcard before default", () => {
    const withAgentWildcard = {
      ...qaConfig,
      routes: {
        ...qaConfig.routes,
        "agent:*": { backend: "opencode", models: ["opencode/space-bunny-free"] },
      },
    };
    const result = resolveTargetRoute(withAgentWildcard, "agent:other");
    expect(result.key).toBe("agent:*");
    expect(result.backend).toEqual(qaBackends.opencode);
  });

  test("category targets do not leak into the agent:* wildcard", () => {
    const withAgentWildcard = {
      ...qaConfig,
      routes: {
        ...qaConfig.routes,
        "agent:*": { backend: "opencode", models: ["opencode/space-bunny-free"] },
      },
    };
    const result = resolveTargetRoute(withAgentWildcard, "category:other");
    expect(result.key).toBe("category:*");
  });

  test("falls back to defaultRoute when no key or wildcard matches", () => {
    const result = resolveTargetRoute(qaConfig, "agent:other");
    expect(result.key).toBe("defaultRoute");
    expect(result.target).toBe("agent:other");
    expect(result.backend).toEqual(qaBackends.claudeCli);
    expect(result.backendName).toBe("claudeCli");
    expect(result.models).toEqual(["claude-haiku-5"]);
  });

  test("throws for an unconfigured target with no wildcard or default", () => {
    const bare = {
      backends: qaBackends,
      routes: {
        "category:writing": { backend: "opencode", models: ["m"] },
      },
    };
    expect(() => resolveTargetRoute(bare, "category:unknown")).toThrow(
      "No route configured for category:unknown",
    );
  });

  test("backend override reselects the backend of an exact route", () => {
    const result = resolveTargetRoute(qaConfig, "category:writing", {
      backend: "claudeCli",
    });
    expect(result.key).toBe("category:writing");
    expect(result.backend).toEqual(qaBackends.claudeCli);
    expect(result.backendName).toBe("claudeCli");
    expect(result.backend.type).toBe("command");
    expect(result.models).toEqual(["opencode/space-bunny-free"]);
  });

  test("wildcard route resolved with override onto a command backend", () => {
    const result = resolveTargetRoute(qaConfig, "category:anything", {
      backend: "claudeCli",
    });
    expect(result.key).toBe("category:*");
    expect(result.backend).toEqual(qaBackends.claudeCli);
    expect(result.backend.type).toBe("command");
  });

  test("override onto a missing backend fails", () => {
    expect(() =>
      resolveTargetRoute(qaConfig, "category:writing", { backend: "nope" }),
    ).toThrow(/does not exist/);
  });

  test("requires a non-empty string target", () => {
    expect(() => resolveTargetRoute(qaConfig, "")).toThrow(/target/i);
  });
});

describe("validateConfig", () => {
  const base = {
    backends: { opencode: { type: "opencode-v2", command: "opencode" } },
    routes: { "category:quick": { backend: "opencode", models: ["m"] } },
  };

  test("accepts wildcard route keys", () => {
    expect(() =>
      validateConfig({
        ...base,
        routes: {
          "category:*": { backend: "opencode", models: ["m"] },
          "agent:*": { backend: "opencode", models: ["m"] },
        },
      }),
    ).not.toThrow();
  });

  test("accepts a valid defaultRoute", () => {
    expect(() =>
      validateConfig({
        ...base,
        defaultRoute: { backend: "opencode", models: ["m"] },
      }),
    ).not.toThrow();
  });

  test("rejects a defaultRoute without a models array", () => {
    expect(() =>
      validateConfig({ ...base, defaultRoute: { backend: "opencode" } }),
    ).toThrow(/defaultRoute must define a models string array/);
  });

  test("accepts blockNativeTask as boolean, string array, and per-route", () => {
    expect(() => validateConfig({ ...base, blockNativeTask: true })).not.toThrow();
    expect(() =>
      validateConfig({ ...base, blockNativeTask: ["category:quick"] }),
    ).not.toThrow();
    expect(() =>
      validateConfig({
        ...base,
        routes: {
          "category:quick": {
            backend: "opencode",
            models: ["m"],
            blockNativeTask: ["category:*"],
          },
        },
      }),
    ).not.toThrow();
  });

  test("rejects a malformed blockNativeTask", () => {
    expect(() => validateConfig({ ...base, blockNativeTask: 7 })).toThrow(
      /blockNativeTask/,
    );
  });

  test("accepts a known pricePolicy", () => {
    expect(() => validateConfig({ ...base, pricePolicy: "free-only" })).not.toThrow();
  });

  test("rejects an unknown pricePolicy", () => {
    expect(() => validateConfig({ ...base, pricePolicy: "cheapest" })).toThrow(
      /pricePolicy/,
    );
  });

  test('fail-fast: blockNativeTask "all" requires a wildcard route or defaultRoute', () => {
    expect(() => validateConfig({ ...base, blockNativeTask: "all" })).toThrow(
      /blockNativeTask "all"/,
    );
    expect(() =>
      validateConfig({
        ...base,
        blockNativeTask: "all",
        defaultRoute: { backend: "opencode", models: ["m"] },
      }),
    ).not.toThrow();
    expect(() =>
      validateConfig({
        ...base,
        blockNativeTask: "all",
        routes: { "category:*": { backend: "opencode", models: ["m"] } },
      }),
    ).not.toThrow();
  });

  test("still rejects a missing routes object", () => {
    expect(() => validateConfig({ backends: base.backends })).toThrow(
      /routes object/,
    );
  });
});

describe("v0.1.1 legacy fixture compatibility", () => {
  // Frozen v0.1.1 config: opencode backend only, two exact routes, none of the
  // new-style keys (no wildcard route, no defaultRoute, no blockNativeTask, no
  // pricePolicy). Proves the merged resolver keeps legacy configs working.
  const legacy = {
    backends: { opencode: { type: "opencode-v2", command: "opencode" } },
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

  test("validateConfig accepts a v0.1.1 config with no new-style keys", () => {
    expect(Object.keys(legacy.backends)).toEqual(["opencode"]);
    expect(Object.keys(legacy.routes)).toEqual(["category:quick", "agent:explore"]);
    expect(legacy.defaultRoute).toBeUndefined();
    expect(legacy.blockNativeTask).toBeUndefined();
    expect(legacy.pricePolicy).toBeUndefined();
    expect(() => validateConfig(legacy)).not.toThrow();
  });

  test("resolveRoute falls through the legacy candidate list to a free model", () => {
    const catalog = [
      {
        providerID: "opencode-go",
        id: "longcat-2.5-preview-free",
        cost: { input: 0, output: 0 },
      },
    ];

    expect(resolveRoute(legacy, "category:quick", catalog)).toEqual({
      backend: { type: "opencode-v2", command: "opencode" },
      target: "category:quick",
      model: "opencode-go/longcat-2.5-preview-free",
      freeOnly: true,
    });
  });

  test("resolveTargetRoute resolves legacy keys exactly and preserves the agent", () => {
    const quick = resolveTargetRoute(legacy, "category:quick");
    expect(quick.key).toBe("category:quick");
    expect(quick.target).toBe("category:quick");
    expect(quick.backend).toEqual({ type: "opencode-v2", command: "opencode" });
    expect(quick.backendName).toBe("opencode");
    expect(quick.models).toEqual([
      "opencode/space-bunny-free",
      "opencode-go/longcat-2.5-preview-free",
    ]);
    expect(quick.freeOnly).toBe(true);

    const explore = resolveTargetRoute(legacy, "agent:explore");
    expect(explore.key).toBe("agent:explore");
    expect(explore.backendName).toBe("opencode");
    expect(explore.agent).toBe("explore");
  });
});

describe("new-style routing fail-closed and override", () => {
  const backends = {
    opencode: { type: "opencode-v2", command: "opencode" },
    commandcode: { type: "command", command: "commandcode" },
  };

  test("unknown category target fails closed when only an agent:* wildcard exists", () => {
    const config = {
      backends,
      routes: {
        "agent:*": { backend: "opencode", models: ["opencode/space-bunny-free"] },
      },
      pricePolicy: "free-only",
    };

    expect(() => resolveTargetRoute(config, "category:unknown")).toThrow(
      "No route configured for category:unknown",
    );
  });

  test("wildcard route with a command override keeps the wildcard models", () => {
    const config = {
      backends,
      routes: {
        "category:quick": { backend: "opencode", models: ["opencode/space-bunny-free"] },
        "category:*": { backend: "commandcode", models: ["qwen/qwen3.8-max"] },
      },
    };

    const result = resolveTargetRoute(config, "category:writing", {
      backend: "commandcode",
    });
    expect(result.key).toBe("category:*");
    expect(result.backendName).toBe("commandcode");
    expect(result.backend.type).toBe("command");
    expect(result.models).toEqual(["qwen/qwen3.8-max"]);
  });
});

describe("dagWatch validation", () => {
  const baseConfig = {
    backends: { opencode: { type: "opencode-v2", command: "opencode" } },
    routes: { "category:quick": { backend: "opencode", models: ["opencode/space-bunny-free"] } },
  };

  test("accepts false, true and an object of knobs", () => {
    expect(() => validateConfig({ ...baseConfig, dagWatch: false })).not.toThrow();
    expect(() => validateConfig({ ...baseConfig, dagWatch: true })).not.toThrow();
    expect(() =>
      validateConfig({
        ...baseConfig,
        dagWatch: { category: "unspecified-low", pollSeconds: 5, timeoutMinutes: 10 },
      }),
    ).not.toThrow();
  });

  test("rejects malformed values", () => {
    expect(() => validateConfig({ ...baseConfig, dagWatch: "yes" })).toThrow(/dagWatch/);
    expect(() => validateConfig({ ...baseConfig, dagWatch: [] })).toThrow(/dagWatch/);
    expect(() => validateConfig({ ...baseConfig, dagWatch: { category: "" } })).toThrow(
      /dagWatch\.category/,
    );
    expect(() => validateConfig({ ...baseConfig, dagWatch: { pollSeconds: 0 } })).toThrow(
      /dagWatch\.pollSeconds/,
    );
    expect(() => validateConfig({ ...baseConfig, dagWatch: { timeoutMinutes: -1 } })).toThrow(
      /dagWatch\.timeoutMinutes/,
    );
  });
});
