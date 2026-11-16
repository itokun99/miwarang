import { describe, expect, test } from "bun:test";
import { backendForRun } from "../src/run-tools.ts";
import { invoke, makeHarness } from "./support/extension-harness.ts";

const multiCommandConfig = {
  backends: {
    command: { type: "command", command: "commandcode", args: ["-p"], agent: "General" },
    claude: { type: "command", command: "claude", args: ["-p"], agent: "general" },
  },
  delegation: ["command", "claude"],
};

const records = {
  run_A: { id: "run_A", backend: "command", state: "completed" },
  run_B: { id: "run_B", backend: "claude", state: "completed" },
};

function fakeRunStore(seed: Record<string, any> = records) {
  const gets: string[] = [];
  return {
    gets,
    async get(id: string) {
      gets.push(id);
      return seed[id as keyof typeof seed];
    },
  };
}

describe("run backend resolution", () => {
  test("resolves a run ID through its store record, not config order", async () => {
    const store = fakeRunStore();

    expect(await backendForRun(multiCommandConfig as never, "run_A", undefined, store as never)).toBe("command");
    expect(await backendForRun(multiCommandConfig as never, "run_B", undefined, store as never)).toBe("claude");
    expect(store.gets).toEqual(["run_A", "run_B"]);
  });

  test("an explicit backend parameter wins over the store record", async () => {
    const store = fakeRunStore();
    expect(await backendForRun(multiCommandConfig as never, "run_A", "claude", store as never)).toBe("claude");
    expect(await backendForRun(multiCommandConfig as never, "run_B", "command", store as never)).toBe("command");
    expect(store.gets).toEqual([]);
  });

  test("an unconfigured explicit backend is rejected", async () => {
    await expect(
      backendForRun(multiCommandConfig as never, "run_A", "ghost", fakeRunStore() as never),
    ).rejects.toThrow(/Backend ghost is not configured/);
  });

  test("falls back to the delegation chain order when no record exists", async () => {
    const store = fakeRunStore({});
    expect(await backendForRun(multiCommandConfig as never, "run_x", undefined, store as never)).toBe("command");
    expect(store.gets).toEqual(["run_x"]);
  });

  test("an unknown ID resolves to the first chain backend, whose wait rejects it", async () => {
    expect(
      await backendForRun(multiCommandConfig as never, "unknown", undefined, fakeRunStore() as never),
    ).toBe("command");
  });

  test("wait and cancel use the backend recorded for the run", async () => {
    const calls: unknown[][] = [];
    function commandLike(id: string) {
      return {
        wait: async (runId: string) => {
          calls.push([`${id}:wait`, runId]);
          return { runId, text: `${id} result` };
        },
        cancel: async (runId: string) => {
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

  test("malformed and empty IDs are rejected", async () => {
    await expect(
      backendForRun(multiCommandConfig as never, "", undefined, fakeRunStore() as never),
    ).rejects.toThrow("Cannot determine backend for run ID ");
  });
});
