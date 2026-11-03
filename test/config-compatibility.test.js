import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolveRoute, resolveTargetRoute, validateConfig } from "../src/config.js";

describe("configuration example", () => {
  test("config.example.json satisfies the current config contract", async () => {
    const config = JSON.parse(
      await readFile(new URL("../config.example.json", import.meta.url), "utf8"),
    );

    expect(() => validateConfig(config)).not.toThrow();
  });
});

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

describe("legacy route compatibility", () => {
  test("accepts a legacy config with no new-style keys", () => {
    expect(() => validateConfig(legacy)).not.toThrow();
  });

  test("route resolution skips unavailable candidates without applying freeOnly", () => {
    const catalog = [
      {
        providerID: "opencode-go",
        id: "longcat-2.5-preview-free",
        cost: { input: 0, output: 0 },
      },
    ];

    expect(resolveRoute(legacy, "category:quick", catalog)).toMatchObject({
      target: "category:quick",
      model: "opencode-go/longcat-2.5-preview-free",
    });
  });

  test("route resolution keeps OMO target identity separate from route metadata", () => {
    const quick = resolveTargetRoute(legacy, "category:quick");
    const explore = resolveTargetRoute(legacy, "agent:explore");

    expect(quick.key).toBe("category:quick");
    expect(explore.key).toBe("agent:explore");
    expect(explore.agent).toBe("explore");
  });
});

describe("new-style route compatibility", () => {
  const backends = {
    opencode: { type: "opencode-v2", command: "opencode" },
    commandcode: { type: "command", command: "commandcode" },
  };

  test("unknown category target fails closed when only an agent:* wildcard exists", () => {
    const config = {
      backends,
      routes: { "agent:*": { backend: "opencode" } },
      pricePolicy: "free-only",
    };

    expect(() => resolveTargetRoute(config, "category:unknown")).toThrow(
      "No route configured for category:unknown",
    );
  });

  test("wildcard route with a Command Code override keeps the wildcard models", () => {
    const config = {
      backends,
      routes: {
        "category:quick": { backend: "opencode" },
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

describe("defaultModels inheritance", () => {
  const backends = {
    opencode: { type: "opencode-v2", command: "opencode" },
    commandcode: { type: "command", command: "commandcode" },
  };

  test("validateConfig accepts command routes without models when defaultModels exists", () => {
    expect(() =>
      validateConfig({
        backends,
        defaultModels: ["reflection/beam:free"],
        routes: { "category:writing": { backend: "commandcode" } },
      }),
    ).not.toThrow();
  });

  test("validateConfig requires models for Command Code routes without defaultModels", () => {
    expect(() =>
      validateConfig({
        backends,
        routes: { "category:writing": { backend: "commandcode" } },
      }),
    ).toThrow(/category:writing must define a models string array.*defaultModels/);
  });

  test("validateConfig accepts an OpenCode route without a model list", () => {
    expect(() =>
      validateConfig({
        backends,
        routes: { "category:quick": { backend: "opencode" } },
      }),
    ).not.toThrow();
  });

  test("validateConfig rejects malformed defaultModels", () => {
    expect(() =>
      validateConfig({
        backends,
        defaultModels: "reflection/beam:free",
        routes: {},
      }),
    ).toThrow(/defaultModels must be a string array/);
    expect(() =>
      validateConfig({ backends, defaultModels: [7], routes: {} }),
    ).toThrow(/defaultModels/);
  });

  test("resolveTargetRoute inherits defaultModels for command routes only when needed", () => {
    const config = {
      backends,
      defaultModels: ["reflection/beam:free", "deepseek/flash"],
      routes: {
        "category:writing": { backend: "commandcode" },
        "category:docs": { backend: "commandcode", models: ["qwen/flash"] },
      },
    };

    expect(resolveTargetRoute(config, "category:writing").models).toEqual([
      "reflection/beam:free",
      "deepseek/flash",
    ]);
    expect(resolveTargetRoute(config, "category:docs").models).toEqual(["qwen/flash"]);
  });

  test("resolveTargetRoute leaves defaultModels off OpenCode routes", () => {
    const config = {
      backends,
      defaultModels: ["reflection/beam:free"],
      routes: { "category:quick": { backend: "opencode" } },
    };

    expect(resolveTargetRoute(config, "category:quick").models).toEqual([]);
  });

  test("resolveTargetRoute leaves defaultModels off OpenCode fallbacks", () => {
    const config = {
      backends,
      defaultModels: ["reflection/beam:free"],
      routes: {
        "category:writing": {
          backend: "commandcode",
          models: ["qwen/flash"],
          fallbacks: [{ backend: "opencode" }],
        },
      },
    };

    expect(resolveTargetRoute(config, "category:writing").fallbacks[0].models).toEqual([]);
  });
});
