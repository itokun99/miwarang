import { describe, expect, test } from "bun:test";
import { backendForRun } from "../src/run-tools.js";
import { invoke, makeHarness } from "./support/extension-harness.js";

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

describe("run backend resolution", () => {
  test("resolves a run ID through its store record, not config order", async () => {
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

  test("throws when no record and no ID heuristic can resolve", async () => {
    await expect(
      backendForRun(multiCommandConfig, "unknown", undefined, fakeRunStore()),
    ).rejects.toThrow("Cannot determine backend for run ID unknown");
  });

  test("resolves OpenCode session IDs without looking up the run store", async () => {
    const mixedConfig = {
      backends: {
        opencode: { type: "opencode-v2", command: "opencode" },
        command: { type: "command", command: "commandcode" },
      },
      routes: { "category:*": { backend: "opencode" } },
    };
    const store = fakeRunStore();

    expect(await backendForRun(mixedConfig, "ses_abc", undefined, store)).toBe("opencode");
    expect(store.gets).toEqual([]);
  });

  test("wait and cancel use the backend recorded for the run", async () => {
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

  test("a missing record falls back without crashing", async () => {
    expect(
      await backendForRun(multiCommandConfig, "run_missing", undefined, fakeRunStore()),
    ).toBe("command");
  });

  test("malformed and empty IDs are rejected", async () => {
    await expect(
      backendForRun(multiCommandConfig, "", undefined, fakeRunStore()),
    ).rejects.toThrow("Cannot determine backend for run ID ");
    await expect(
      backendForRun(multiCommandConfig, 123, undefined, fakeRunStore()),
    ).rejects.toThrow(TypeError);
  });

  test("a record naming an unconfigured backend falls back to the ID heuristic", async () => {
    const store = fakeRunStore({ run_A: { id: "run_A", backend: "ghost" } });

    expect(await backendForRun(multiCommandConfig, "run_A", undefined, store)).toBe("command");
  });
});
