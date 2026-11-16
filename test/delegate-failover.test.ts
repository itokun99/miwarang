import { describe, expect, test } from "bun:test";
import { invoke, makeHarness } from "./support/extension-harness.ts";

const providerFailure = (id) =>
  `OpenCode session ${id} failed: provider.quota (402) Upstream request failed: Endpoint is unavailable.`;

function commandBackend(behavior = {}) {
  const calls = [];
  return {
    calls,
    runForeground: async (request) => {
      calls.push(request);
      if (behavior.runForeground) return behavior.runForeground(request, calls);
      return { sessionId: "ses_command", text: "Command fallback result" };
    },
    start: async (request) => {
      calls.push(request);
      if (behavior.start) return behavior.start(request, calls);
      return { runId: "run_command", state: "running" };
    },
    wait: async () => ({}),
    cancel: async () => ({}),
  };
}

describe("delegate backend failover", () => {
  test("an OpenCode provider error falls back to the configured backend fallback", async () => {
    const config = {
      backends: {
        opencode: { type: "opencode-v2", command: "opencode" },
        commandcode: { type: "command", command: "commandcode" },
      },
      routes: {
        "category:quick": {
          backend: "opencode",
          fallbacks: [{ backend: "commandcode" }],
        },
      },
    };
    const opencodeCalls = [];
    const opencode = {
      listModels: async () => {
        throw new Error("OpenCode model list must not be queried");
      },
      runForeground: async (request) => {
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
      config,
      backends: { opencode, commandcode },
    });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:quick",
      prompt: "Inspect this project",
    });

    expect(opencodeCalls).toEqual([
      { cwd: "/workspace", target: "category:quick", prompt: "Inspect this project" },
    ]);
    expect(commandcode.calls[0]).toEqual({
      cwd: "/workspace",
      target: "category:quick",
      prompt: "Inspect this project",
    });
    expect(result.content[0].text).toBe("Command fallback result");
    expect(result.details).toMatchObject({
      backend: "commandcode",
      fallback: true,
      fallbackIndex: 1,
    });
  });

  test("an OpenCode failure surfaces when no backend fallback exists", async () => {
    const config = {
      backends: { opencode: { type: "opencode-v2", command: "opencode" } },
      routes: {
        "category:quick": { backend: "opencode" },
      },
    };
    const calls = [];
    const opencode = {
      listModels: async () => {
        throw new Error("OpenCode model list must not be queried");
      },
      runForeground: async (request) => {
        calls.push(request);
        throw new Error(providerFailure("ses_default"));
      },
      start: async () => ({}),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({ config, backends: { opencode } });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:quick",
        prompt: "Inspect",
      }),
    ).rejects.toThrow(/provider\.quota/);
    expect(calls).toEqual([
      { cwd: "/workspace", target: "category:quick", prompt: "Inspect" },
    ]);
  });

  test("non-provider OpenCode failures do not trigger backend failover", async () => {
    const config = {
      backends: {
        opencode: { type: "opencode-v2", command: "opencode" },
        commandcode: { type: "command", command: "commandcode" },
      },
      routes: {
        "category:quick": {
          backend: "opencode",
          fallbacks: [{ backend: "commandcode" }],
        },
      },
    };
    let commandCalls = 0;
    const { tools } = makeHarness({
      config,
      backends: {
        opencode: {
          listModels: async () => {
            throw new Error("OpenCode model list must not be queried");
          },
          runForeground: async () => {
            throw new Error("OpenCode configuration rejected the request");
          },
          start: async () => ({}),
          wait: async () => ({}),
          cancel: async () => ({}),
        },
        commandcode: commandBackend({
          runForeground: async () => {
            commandCalls += 1;
            return { sessionId: "ses_command", text: "Should not run" };
          },
        }),
      },
    });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:quick",
        prompt: "Inspect",
      }),
    ).rejects.toThrow(/configuration rejected/);
    expect(commandCalls).toBe(0);
  });

  test("an OpenCode background-start failure falls back before a run ID is returned", async () => {
    const config = {
      backends: {
        opencode: { type: "opencode-v2", command: "opencode" },
        commandcode: { type: "command", command: "commandcode" },
      },
      routes: {
        "category:deep-high": {
          backend: "opencode",
          fallbacks: [{ backend: "commandcode" }],
        },
      },
    };
    const commandcode = commandBackend();
    const { tools } = makeHarness({
      config,
      backends: {
        opencode: {
          listModels: async () => {
            throw new Error("OpenCode model list must not be queried");
          },
          start: async (request) => {
            expect(request).toEqual({
              cwd: "/workspace",
              target: "category:deep-high",
              prompt: "Inspect this project",
            });
            throw new Error(providerFailure("ses_default"));
          },
          runForeground: async () => {
            throw new Error("should not run foreground");
          },
          wait: async () => ({}),
          cancel: async () => ({}),
        },
        commandcode,
      },
    });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:deep-high",
      prompt: "Inspect this project",
      mode: "background",
    });

    expect(commandcode.calls[0]).toEqual({
      cwd: "/workspace",
      target: "category:deep-high",
      prompt: "Inspect this project",
    });
    expect(result.details).toMatchObject({
      backend: "commandcode",
      fallback: true,
      fallbackIndex: 1,
    });
  });

  test("command quota errors advance to the configured backend fallback", async () => {
    const config = {
      backends: {
        commandcode: { type: "command", command: "commandcode" },
        koma: { type: "koma-sdk", command: "koma" },
      },
      routes: {
        "category:writing": {
          backend: "commandcode",
          fallbacks: [{ backend: "koma" }],
        },
      },
    };
    const commandcode = commandBackend({
      runForeground: async () => {
        throw new Error(
          "Configured command failed with exit code 1: You've reached your 5-hour usage limit",
        );
      },
    });
    const komaCalls = [];
    const koma = {
      runForeground: async (request) => {
        komaCalls.push(request);
        return { sessionId: "ses_koma", text: "Koma fallback result" };
      },
      start: async () => ({ runId: "run_koma", state: "running" }),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({ config, backends: { commandcode, koma } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Inspect this project",
    });

    expect(komaCalls).toEqual([
      { cwd: "/workspace", target: "category:writing", prompt: "Inspect this project" },
    ]);
    expect(result.content[0].text).toBe("Koma fallback result");
    expect(result.details).toMatchObject({
      backend: "koma",
      fallback: true,
    });
  });
});
