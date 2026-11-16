import { describe, expect, test } from "bun:test";
import { invoke, makeHarness } from "./support/extension-harness.ts";

const providerFailure = (id: string) =>
  `OpenCode session ${id} failed: provider.quota (402) Upstream request failed: Endpoint is unavailable.`;

function commandBackend(behavior: Record<string, any> = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    runForeground: async (request: any) => {
      calls.push(request);
      if (behavior.runForeground) return behavior.runForeground(request, calls);
      return { sessionId: "ses_command", text: "Command fallback result" };
    },
    start: async (request: any) => {
      calls.push(request);
      if (behavior.start) return behavior.start(request, calls);
      return { runId: "run_command", state: "running" };
    },
    wait: async () => ({}),
    cancel: async () => ({}),
  };
}

describe("delegate backend failover", () => {
  test("an OpenCode provider error falls back to the next backend in the chain", async () => {
    const opencodeCalls: unknown[] = [];
    const opencode = {
      runForeground: async (request: any) => {
        opencodeCalls.push(request);
        throw new Error(providerFailure("ses_default"));
      },
      start: async () => {
        throw new Error(providerFailure("ses_default"));
      },
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const commandcode = commandBackend();
    const { tools } = makeHarness({
      backends: { opencode, commandcode, koma: commandBackend() },
    });

    const result = await invoke(tools.get("miwarang_delegate"), {
      prompt: "Inspect this project",
    });

    expect(opencodeCalls).toEqual([
      { cwd: "/workspace", prompt: "Inspect this project", agent: "Orchestrator" },
    ]);
    expect(commandcode.calls[0]).toEqual({
      cwd: "/workspace",
      prompt: "Inspect this project",
      agent: "General",
    });
    expect(result.content[0].text).toBe("Command fallback result");
    expect(result.details).toMatchObject({
      backend: "commandcode",
      fallback: true,
      fallbackIndex: 1,
    });
  });

  test("an OpenCode failure surfaces when the chain has no fallback", async () => {
    const calls: unknown[] = [];
    const opencode = {
      runForeground: async (request: any) => {
        calls.push(request);
        throw new Error(providerFailure("ses_default"));
      },
      start: async () => ({}),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({
      config: {
        backends: { opencode: { type: "opencode-cli", command: "opencode", args: ["run"] } },
        delegation: ["opencode"],
      },
      backends: { opencode },
    });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        prompt: "Inspect",
      }),
    ).rejects.toThrow(/provider\.quota/);
    expect(calls).toEqual([
      { cwd: "/workspace", prompt: "Inspect", agent: undefined },
    ]);
  });

  test("non-provider failures do not trigger backend failover", async () => {
    const opencode = {
      runForeground: async () => {
        throw new Error("OpenCode run failed: configuration rejected the request");
      },
    };
    const commandcode = commandBackend();
    const { tools } = makeHarness({ backends: { opencode, commandcode, koma: commandcode } });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        prompt: "Inspect",
      }),
    ).rejects.toThrow(/configuration rejected/);
    expect(commandcode.calls).toEqual([]);
  });

  test("an OpenCode background-start failure falls back before a run ID is returned", async () => {
    const opencode = {
      runForeground: async () => ({}),
      start: async () => {
        throw new Error(providerFailure("ses_default"));
      },
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const commandcode = commandBackend();
    const { tools } = makeHarness({ backends: { opencode, commandcode, koma: commandcode } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      prompt: "Inspect this project",
      mode: "background",
    });

    expect(result.details).toMatchObject({
      backend: "commandcode",
      fallback: true,
      fallbackIndex: 1,
    });
    expect(result.details).toHaveProperty("runId", "run_command");
  });

  test("command quota errors advance to the configured backend fallback", async () => {
    const commandcode = commandBackend({
      runForeground: async () => {
        throw new Error(
          "Configured command failed with exit code 1: You've reached your 5-hour usage limit",
        );
      },
    });
    const komaCalls: unknown[] = [];
    const koma = {
      runForeground: async (request: any) => {
        komaCalls.push(request);
        return { sessionId: "ses_koma", text: "Koma fallback result" };
      },
      start: async () => ({ runId: "run_koma", state: "running" }),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({ backends: { opencode: commandcode, commandcode, koma } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      prompt: "Inspect this project",
    });

    expect(komaCalls).toEqual([
      { cwd: "/workspace", prompt: "Inspect this project" },
    ]);
    expect(result.content[0].text).toBe("Koma fallback result");
    expect(result.details).toMatchObject({ backend: "koma", fallback: true, fallbackIndex: 2 });
  });
});
