import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config.ts";

function validateConfigHelper(config: unknown) {
  return validateConfig(config as never);
}

const validConfig = {
  backends: {
    opencode: {
      type: "opencode-cli",
      command: "opencode",
      args: ["run", "--agent", "{{agent}}"],
      agent: "Orchestrator",
    },
    commandcode: {
      type: "command",
      command: "commandcode",
      args: ["-p", "-t"],
      agent: "General",
    },
    koma: { type: "koma-sdk", command: "koma", args: ["sdk", "serve"] },
  },
  delegation: ["opencode", "commandcode", "koma"],
};

describe("config v2 validation", () => {
  test("accepts the documented example shape", () => {
    expect(() => validateConfigHelper(validConfig)).not.toThrow();
  });

  test("rejects legacy routes with migration guidance", () => {
    expect(() =>
      validateConfigHelper({
        ...validConfig,
        routes: { "category:quick": { backend: "opencode" } },
      }),
    ).toThrow(/"routes" was removed in v0.9.0/);
  });

  test("rejects other removed keys with migration guidance", () => {
    for (const key of ["defaultRoute", "defaultModels", "pricePolicy", "defaultBackend", "blockNativeTask"]) {
      expect(() => validateConfigHelper({ ...validConfig, [key]: {} })).toThrow(
        new RegExp(`"${key}" was removed in v0.9.0`),
      );
    }
  });

  test("rejects the removed opencode-v2 backend type with a pointer to the CLI type", () => {
    expect(() =>
      validateConfigHelper({
        backends: { opencode: { type: "opencode-v2", command: "opencode" } },
        delegation: ["opencode"],
      }),
    ).toThrow(/removed type "opencode-v2".*opencode-cli/s);
  });

  test("requires a non-empty delegation chain of known backends", () => {
    expect(() => validateConfigHelper({ backends: validConfig.backends, delegation: [] })).toThrow(
      /delegation array/,
    );
    expect(() =>
      validateConfigHelper({ backends: validConfig.backends, delegation: ["missing"] }),
    ).toThrow(/unknown backend missing/);
    expect(() =>
      validateConfigHelper({ backends: validConfig.backends, delegation: ["opencode", "opencode"] }),
    ).toThrow(/more than once/);
    expect(() => validateConfigHelper({ backends: validConfig.backends })).toThrow(/delegation array/);
  });

  test("validates backend shapes per type", () => {
    expect(() =>
      validateConfigHelper({
        backends: { bad: { type: "command", args: ["-p"] } },
        delegation: ["bad"],
      }),
    ).toThrow(/must define a command/);
    expect(() =>
      validateConfigHelper({
        backends: { bad: { type: "command", command: "x", args: "nope" } },
        delegation: ["bad"],
      }),
    ).toThrow(/args must be a string array/);
    expect(() =>
      validateConfigHelper({
        backends: { bad: { type: "warp", command: "x", args: [] } },
        delegation: ["bad"],
      }),
    ).toThrow(/unknown type warp/);
    expect(() =>
      validateConfigHelper({
        backends: { bad: { type: "opencode-cli", command: "opencode", args: [], agent: 7 } },
        delegation: ["bad"],
      }),
    ).toThrow(/agent must be a string/);
    expect(() =>
      validateConfigHelper({
        backends: { bad: { type: "koma-sdk", command: "koma", args: ["sdk", "serve"], agent: "Koma" } },
        delegation: ["bad"],
      }),
    ).not.toThrow();
  });

  test("rejects non-object configs", () => {
    expect(() => validateConfigHelper(null)).toThrow(/must be a JSON object/);
    expect(() => validateConfigHelper([])).toThrow(/must be a JSON object/);
    expect(() => validateConfigHelper({})).toThrow(/backends object/);
  });
});
