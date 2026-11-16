import { describe, expect, test } from "bun:test";
import { invoke, makeHarness } from "./support/extension-harness.ts";

function commandBackend(overrides = {}) {
  return {
    runForeground: async () => {
      throw new Error("primary must not run");
    },
    start: async () => ({ runId: "run_primary", state: "running" }),
    wait: async () => ({}),
    cancel: async () => ({}),
    ...overrides,
  };
}

describe("delegation chain", () => {
  test("the primary backend receives the prompt and its configured agent", async () => {
    const { tools, calls } = makeHarness();

    const result = await invoke(tools.get("miwarang_delegate"), {
      prompt: "Inspect this project",
    });

    expect(calls).toEqual([
      [
        "foreground",
        { cwd: "/workspace", prompt: "Inspect this project", agent: "Orchestrator" },
      ],
    ]);
    expect(result.content[0].text).toBe("Foreground result");
    expect(result.details).toMatchObject({ backend: "opencode", resolvedVia: "primary" });
    expect(result.details).not.toHaveProperty("model");
  });

  test("quota failures advance to the next backend in the delegation chain", async () => {
    const opencode = commandBackend({
      runForeground: async () => {
        throw new Error(
          "Configured command failed with exit code 1: You've reached your 5-hour usage limit",
        );
      },
    });
    const commandcode = {
      runForeground: async () => ({ sessionId: "ses_command", text: "Command fallback result" }),
      start: async () => ({ runId: "run_command", state: "running" }),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({ backends: { opencode, commandcode, koma: commandcode } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      prompt: "Inspect this project",
    });

    expect(result.content[0].text).toBe("Command fallback result");
    expect(result.details).toMatchObject({
      backend: "commandcode",
      fallback: true,
      fallbackIndex: 1,
      agent: "General",
    });
  });

  test("non-provider failures stop immediately instead of burning the chain", async () => {
    const opencode = commandBackend({
      runForeground: async () => {
        throw new Error("Configured command failed with exit code 2: bad flags");
      },
    });
    const commandcode = {
      runForeground: async () => {
        throw new Error("fallback must not run");
      },
    };
    const { tools } = makeHarness({ backends: { opencode, commandcode, koma: commandcode } });

    await expect(
      invoke(tools.get("miwarang_delegate"), { prompt: "Inspect this project" }),
    ).rejects.toThrow(/bad flags/);
  });

  test("a background start failure falls back before a run ID is returned", async () => {
    const opencode = commandBackend({
      start: async () => {
        throw new Error("OpenCode session ses_x failed: quota exhausted");
      },
    });
    const commandcode = {
      start: async () => ({ runId: "run_command", state: "running" }),
    };
    const { tools, calls } = makeHarness({ backends: { opencode, commandcode, koma: commandcode } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      prompt: "Inspect this project",
      mode: "background",
    });

    expect(result.details).toMatchObject({ backend: "commandcode", fallback: true });
    expect(result.details).toHaveProperty("runId", "run_command");
  });

  test("an exhausted chain surfaces the last provider error", async () => {
    const failing = () => ({
      runForeground: async () => {
        throw new Error("Configured command failed with exit code 1: rate limit");
      },
    });
    const { tools } = makeHarness({
      backends: { opencode: failing(), commandcode: failing(), koma: failing() },
    });

    await expect(
      invoke(tools.get("miwarang_delegate"), { prompt: "Inspect this project" }),
    ).rejects.toThrow(/rate limit/);
  });
});
