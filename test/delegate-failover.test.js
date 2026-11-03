import { describe, expect, test } from "bun:test";
import { invoke, makeHarness } from "./support/extension-harness.js";

const providerFailure = (id) =>
  `OpenCode session ${id} failed: provider.quota (402) Upstream request failed: Endpoint is unavailable.`;

function commandBackend(catalog, behavior = {}) {
  const calls = [];
  return {
    calls,
    listModels: async () => catalog,
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
  test("an OpenCode provider error falls back without trying Miwarang model candidates", async () => {
    const config = {
      backends: {
        opencode: { type: "opencode-v2", command: "opencode" },
        commandcode: { type: "command", command: "commandcode" },
      },
      routes: {
        "category:quick": {
          backend: "opencode",
          models: ["opencode/model-a", "opencode/model-b"],
          fallbacks: [{ backend: "commandcode", models: ["qwen/qwen3.8-flash"] }],
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
    const commandcode = commandBackend(undefined);
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
    expect(commandcode.calls[0].model).toBe("qwen/qwen3.8-flash");
    expect(result.content[0].text).toBe("Command fallback result");
    expect(result.details).toMatchObject({
      backend: "commandcode",
      model: "qwen/qwen3.8-flash",
      fallback: true,
      fallbackIndex: 1,
    });
  });

  test("an OpenCode failure surfaces when no backend fallback exists", async () => {
    const config = {
      backends: { opencode: { type: "opencode-v2", command: "opencode" } },
      routes: {
        "category:quick": { backend: "opencode", models: ["opencode/model-a", "opencode/model-b"] },
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
          fallbacks: [{ backend: "commandcode", models: ["qwen/qwen3.8-flash"] }],
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
        commandcode: commandBackend(undefined, {
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
          fallbacks: [{ backend: "commandcode", models: ["reflection/beam:free"] }],
        },
      },
    };
    const commandcode = commandBackend(undefined);
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

    expect(commandcode.calls[0].model).toBe("reflection/beam:free");
    expect(result.details).toMatchObject({
      backend: "commandcode",
      model: "reflection/beam:free",
      fallback: true,
      fallbackIndex: 1,
    });
  });

  test("CommandCode quota errors advance through ordered candidates", async () => {
    const config = {
      backends: { commandcode: { type: "command", command: "commandcode" } },
      routes: {
        "category:writing": {
          backend: "commandcode",
          models: ["reflection/beam:free", "deepseek/deepseek-v4-flash"],
          freeOnly: true,
        },
      },
    };
    const commandcode = commandBackend([
      { providerID: "reflection", id: "beam:free", cost: { input: 0, output: 0 } },
      { providerID: "deepseek", id: "deepseek-v4-flash", cost: { input: 1, output: 1 } },
    ], {
      runForeground: async (request, calls) => {
        if (calls.length === 1) {
          throw new Error(
            "Configured command failed with exit code 1: You've reached your 5-hour usage limit",
          );
        }
        return { sessionId: "ses_command", text: "Cheap model result" };
      },
    });
    const { tools } = makeHarness({ config, backends: { commandcode } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Inspect this project",
    });

    expect(commandcode.calls.map((request) => request.model)).toEqual([
      "reflection/beam:free",
      "deepseek/deepseek-v4-flash",
    ]);
    expect(result.content[0].text).toBe("Cheap model result");
    expect(result.details).toMatchObject({
      backend: "commandcode",
      model: "deepseek/deepseek-v4-flash",
    });
  });
});
