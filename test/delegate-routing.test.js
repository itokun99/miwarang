import { describe, expect, test } from "bun:test";
import {
  config,
  invoke,
  legacyConfig,
  makeHarness,
  wildcardConfig,
  wildcardOverrideConfig,
} from "./support/extension-harness.js";

describe("delegate routing", () => {
  test("OpenCode uses its configured session defaults without querying its catalog", async () => {
    let catalogReads = 0;
    const calls = [];
    const opencode = {
      listModels: async () => {
        catalogReads += 1;
        throw new Error("OpenCode catalog must not select the session model");
      },
      runForeground: async (request) => {
        calls.push(request);
        return { sessionId: "ses_default", text: "Harness result" };
      },
      start: async (request) => {
        calls.push(request);
        return { sessionId: "ses_default_bg", state: "running" };
      },
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({ backends: { opencode } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:quick",
      prompt: "Inspect this project",
    });

    expect(catalogReads).toBe(0);
    expect(calls).toEqual([
      {
        cwd: "/workspace",
        target: "category:quick",
        prompt: "Inspect this project",
      },
    ]);
    expect(result.details).not.toHaveProperty("model");
  });

  test("OpenCode rejects explicit model and agent overrides", async () => {
    const { tools, calls } = makeHarness();

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:quick",
        prompt: "Inspect this project",
        model: "provider/model",
      }),
    ).rejects.toThrow(/OpenCode uses its configured default model/);
    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:quick",
        prompt: "Inspect this project",
        agent: "explore",
      }),
    ).rejects.toThrow(/OpenCode uses its configured default model/);
    expect(calls).toEqual([]);
  });

  test("CommandCode selects the first available configured model without a freeOnly filter", async () => {
    const calls = [];
    const commandcode = {
      listModels: async () => [
        { providerID: "moonshotai", id: "kimi-k3", cost: { input: 5, output: 15 } },
      ],
      runForeground: async (request) => {
        calls.push(request);
        return { sessionId: "ses_command", text: "Command result" };
      },
      start: async () => ({ runId: "run_command", state: "running" }),
      wait: async () => ({}),
      cancel: async () => ({}),
    };
    const commandConfig = {
      backends: { commandcode: { type: "command", command: "commandcode" } },
      routes: {
        "category:writing": {
          backend: "commandcode",
          models: ["qwen/qwen3.8-max", "moonshotai/kimi-k3"],
          freeOnly: true,
        },
      },
    };
    const { tools } = makeHarness({ config: commandConfig, backends: { commandcode } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
    });

    expect(calls[0].model).toBe("moonshotai/kimi-k3");
    expect(result.details.model).toBe("moonshotai/kimi-k3");
  });

  test("a command backend without a catalog uses its configured model candidates", async () => {
    const commandConfig = {
      backends: { commandcode: { type: "command", command: "commandcode" } },
      routes: {
        "category:writing": {
          backend: "commandcode",
          models: ["qwen/qwen3.8-max"],
          freeOnly: true,
        },
      },
    };
    const { tools, calls } = makeHarness({ config: commandConfig });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
    });

    expect(calls[0][1].model).toBe("qwen/qwen3.8-max");
    expect(result.details.model).toBe("qwen/qwen3.8-max");
  });

  test("a wildcard OpenCode target reports route provenance without a model", async () => {
    const { tools, calls } = makeHarness({ config: wildcardConfig });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
    });

    expect(calls[0][1]).toEqual({
      cwd: "/workspace",
      target: "category:writing",
      prompt: "Write the docs",
    });
    expect(result.details).toMatchObject({
      backend: "opencode",
      resolvedVia: "wildcard",
      target: "category:writing",
    });
    expect(result.details).not.toHaveProperty("model");
  });

  test("a backend override uses the matching CommandCode fallback candidates", async () => {
    const { tools, calls } = makeHarness({ config: wildcardOverrideConfig });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
      backend: "commandcode",
    });

    expect(calls[0][1]).toMatchObject({
      target: "category:writing",
      model: "qwen/qwen3.8-max",
    });
    expect(result.details).toMatchObject({
      backend: "commandcode",
      resolvedVia: "wildcard",
      model: "qwen/qwen3.8-max",
    });
  });

  test("OpenCode ignores an OMO route agent name and keeps the configured orchestrator", async () => {
    const { tools, calls } = makeHarness({ config: legacyConfig });

    await invoke(tools.get("miwarang_delegate"), {
      target: "agent:explore",
      prompt: "List relevant files",
      mode: "background",
    });

    expect(calls[0][1]).toEqual({
      cwd: "/workspace",
      target: "agent:explore",
      prompt: "List relevant files",
    });
  });

  test("a default OpenCode route runs without a Miwarang model candidate", async () => {
    const config = {
      backends: { opencode: { type: "opencode-v2", command: "opencode" } },
      routes: {},
      defaultRoute: { backend: "opencode" },
    };
    const { tools, calls } = makeHarness({ config });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:brand-new",
      prompt: "Hello",
    });

    expect(calls[0][1]).toEqual({
      cwd: "/workspace",
      target: "category:brand-new",
      prompt: "Hello",
    });
    expect(result.details).toMatchObject({ backend: "opencode", resolvedVia: "default" });
    expect(result.details).not.toHaveProperty("model");
  });

  test("rejects an override to an unknown backend", async () => {
    const { tools } = makeHarness({ config: wildcardConfig });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:writing",
        prompt: "Write the docs",
        backend: "missing",
      }),
    ).rejects.toThrow("Backend missing is not configured");
  });

  test("an unconfigured target still fails closed", async () => {
    const bare = {
      backends: { opencode: { type: "opencode-v2", command: "opencode" } },
      routes: {},
    };
    const { tools } = makeHarness({ config: bare });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:unknown",
        prompt: "Do the thing",
      }),
    ).rejects.toThrow("No route configured for category:unknown");
  });
});
