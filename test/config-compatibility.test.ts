import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { validateConfig } from "../src/config.ts";

function validateConfigHelper(config: unknown) {
  return validateConfig(config as never);
}

describe("configuration example", () => {
  test("config.example.json satisfies the current config contract", async () => {
    const config = JSON.parse(
      await readFile(new URL("../config.example.json", import.meta.url), "utf8"),
    );

    expect(() => validateConfig(config)).not.toThrow();
  });
});

describe("legacy config migration", () => {
  const legacy = {
    backends: { opencode: { type: "opencode-v2", command: "opencode" } },
    routes: {
      "category:quick": { backend: "opencode", freeOnly: true },
      "agent:explore": { backend: "opencode", agent: "explore" },
    },
    defaultRoute: { backend: "opencode" },
    defaultModels: ["opencode/space-bunny-free"],
    blockNativeTask: "all",
  };

  test("a legacy v0.8 config is rejected with a migration pointer", () => {
    expect(() => validateConfigHelper(legacy)).toThrow(/"routes" was removed in v0.9.0/);
  });

  test("each removed key names itself so users can fix the config one error at a time", () => {
    const { routes, ...partial } = legacy;
    expect(() => validateConfigHelper(partial)).toThrow(/"defaultRoute" was removed/);
  });

  test("the removed opencode-v2 backend type gets its own migration message", () => {
    expect(() =>
      validateConfigHelper({
        backends: { opencode: { type: "opencode-v2", command: "opencode" } },
        delegation: ["opencode"],
      }),
    ).toThrow(/removed type "opencode-v2"/);
  });
});
