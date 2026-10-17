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
