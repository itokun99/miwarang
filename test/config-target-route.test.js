import { describe, expect, test } from "bun:test";
import { resolveTargetRoute } from "../src/config.js";

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

describe("resolveTargetRoute", () => {
  test("prefers the exact route key over wildcard and default", () => {
    const result = resolveTargetRoute(qaConfig, "category:writing");
    expect(result.key).toBe("category:writing");
    expect(result.target).toBe("category:writing");
    expect(result.backend).toEqual(qaBackends.opencode);
    expect(result.backendName).toBe("opencode");
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

  test("backend override uses the matching fallback model list", () => {
    const configWithFallback = {
      ...qaConfig,
      routes: {
        ...qaConfig.routes,
        "category:quick": {
          backend: "opencode",
          models: ["opencode/space-bunny-free"],
          freeOnly: true,
          fallbacks: [{ backend: "claudeCli", models: ["claude-haiku-5"] }],
        },
      },
    };
    const result = resolveTargetRoute(configWithFallback, "category:quick", {
      backend: "claudeCli",
    });

    expect(result.backendName).toBe("claudeCli");
    expect(result.backend).toEqual(qaBackends.claudeCli);
    expect(result.models).toEqual(["claude-haiku-5"]);
    expect(result.freeOnly).toBeUndefined();
    expect(result.fallbacks).toEqual([]);
  });

  test("normalizes configured fallback backends without changing the primary route", () => {
    const configWithFallback = {
      ...qaConfig,
      routes: {
        ...qaConfig.routes,
        "category:quick": {
          backend: "opencode",
          models: ["opencode/space-bunny-free"],
          freeOnly: true,
          fallbacks: [{ backend: "claudeCli", models: ["claude-sonnet-5"] }],
        },
      },
    };
    const result = resolveTargetRoute(configWithFallback, "category:quick");

    expect(result.backendName).toBe("opencode");
    expect(result.fallbacks).toHaveLength(1);
    expect(result.fallbacks[0]).toMatchObject({
      backendName: "claudeCli",
      backend: qaBackends.claudeCli,
      models: ["claude-sonnet-5"],
      target: "category:quick",
    });
  });

  test("backend overrides disable configured fallbacks", () => {
    const configWithFallback = {
      ...qaConfig,
      routes: {
        ...qaConfig.routes,
        "category:quick": {
          backend: "opencode",
          models: ["opencode/space-bunny-free"],
          fallbacks: [{ backend: "claudeCli", models: ["claude-sonnet-5"] }],
        },
      },
    };

    expect(
      resolveTargetRoute(configWithFallback, "category:quick", { backend: "claudeCli" }).fallbacks,
    ).toEqual([]);
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

  test("OpenCode route without models resolves with no Miwarang model candidates", () => {
    const config = {
      backends: qaBackends,
      routes: { "category:quick": { backend: "opencode" } },
    };

    expect(resolveTargetRoute(config, "category:quick").models).toEqual([]);
  });
});
