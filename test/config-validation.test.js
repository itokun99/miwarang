import { describe, expect, test } from "bun:test";
import { resolveTargetRoute, validateConfig } from "../src/config.js";

const opencodeBackend = { opencode: { type: "opencode-v2", command: "opencode" } };
const commandBackend = { commandcode: { type: "command", command: "commandcode" } };
const base = {
  backends: opencodeBackend,
  routes: { "category:quick": { backend: "opencode", models: ["m"] } },
};

describe("validateConfig", () => {
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

  test("accepts an OpenCode route without a Miwarang model list", () => {
    expect(() =>
      validateConfig({
        backends: opencodeBackend,
        routes: { "category:quick": { backend: "opencode" } },
        defaultRoute: { backend: "opencode" },
      }),
    ).not.toThrow();
  });

  test("requires models for a command route without defaultModels", () => {
    expect(() =>
      validateConfig({
        backends: commandBackend,
        routes: { "category:writing": { backend: "commandcode" } },
      }),
    ).toThrow(/category:writing must define a models string array/);
  });

  test("accepts a valid defaultRoute", () => {
    expect(() =>
      validateConfig({
        ...base,
        defaultRoute: { backend: "opencode", models: ["m"] },
      }),
    ).not.toThrow();
  });

  test("requires a model list for a command defaultRoute", () => {
    expect(() =>
      validateConfig({
        backends: commandBackend,
        routes: { "category:writing": { backend: "commandcode", models: ["m"] } },
        defaultRoute: { backend: "commandcode" },
      }),
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

  test("accepts backend fallback route objects", () => {
    expect(() =>
      validateConfig({
        ...base,
        backends: {
          ...base.backends,
          ...commandBackend,
        },
        routes: {
          "category:quick": {
            backend: "opencode",
            fallbacks: [{ backend: "commandcode", models: ["qwen/model"] }],
          },
        },
      }),
    ).not.toThrow();
  });

  test("rejects malformed or nested backend fallbacks", () => {
    expect(() =>
      validateConfig({
        ...base,
        routes: {
          "category:quick": {
            backend: "opencode",
            fallbacks: { backend: "opencode", models: ["m"] },
          },
        },
      }),
    ).toThrow(/fallbacks must be a route object array/);
    expect(() =>
      validateConfig({
        ...base,
        backends: {
          ...base.backends,
          ...commandBackend,
        },
        routes: {
          "category:quick": {
            backend: "opencode",
            fallbacks: [
              {
                backend: "commandcode",
                models: ["m"],
                fallbacks: [{ backend: "opencode" }],
              },
            ],
          },
        },
      }),
    ).toThrow(/must not define nested fallbacks/);
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
        defaultRoute: { backend: "opencode" },
      }),
    ).not.toThrow();
    expect(() =>
      validateConfig({
        ...base,
        blockNativeTask: "all",
        routes: { "category:*": { backend: "opencode" } },
      }),
    ).not.toThrow();
  });

  test("still rejects a missing routes object", () => {
    expect(() => validateConfig({ backends: base.backends })).toThrow(
      /routes object/,
    );
  });
});

describe("defaultModels inheritance", () => {
  test("validateConfig accepts command routes without models when defaultModels exists", () => {
    expect(() =>
      validateConfig({
        backends: commandBackend,
        defaultModels: ["qwen/model"],
        routes: { "category:writing": { backend: "commandcode" } },
      }),
    ).not.toThrow();
  });

  test("validateConfig rejects command routes without models or defaultModels", () => {
    expect(() =>
      validateConfig({
        backends: commandBackend,
        routes: { "category:writing": { backend: "commandcode" } },
      }),
    ).toThrow(/category:writing must define a models string array.*defaultModels/);
  });

  test("validateConfig rejects a malformed defaultModels", () => {
    expect(() =>
      validateConfig({
        backends: commandBackend,
        defaultModels: "qwen/model",
        routes: {},
      }),
    ).toThrow(/defaultModels must be a string array/);
    expect(() =>
      validateConfig({
        backends: commandBackend,
        defaultModels: [7],
        routes: {},
      }),
    ).toThrow(/defaultModels/);
  });

  test("resolveTargetRoute inherits defaultModels unless a command route overrides", () => {
    const config = {
      backends: commandBackend,
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
});
