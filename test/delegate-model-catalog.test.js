import { describe, expect, test } from "bun:test";
import { configuredCommandModels } from "../src/delegate-routing.js";
import { invoke, makeHarness } from "./support/extension-harness.js";

const probeConfig = {
  backends: {
    commandcode: { type: "command", command: "commandcode", listModelsArgv: ["--list-models"] },
  },
  routes: {
    "category:writing": {
      backend: "commandcode",
      models: ["qwen/qwen3.8-max", "moonshotai/kimi-k3"],
    },
  },
};

const qwen = { providerID: "qwen", id: "qwen3.8-max", cost: { input: 1, output: 1 } };
const kimi = { providerID: "moonshotai", id: "kimi-k3", cost: { input: 5, output: 15 } };

function probeBackend(catalog) {
  const calls = [];
  return {
    calls,
    listModels: async () => catalog,
    runForeground: async (request) => {
      calls.push(["foreground", request]);
      return { sessionId: "ses_probe", text: `probe ran ${request.model}` };
    },
    start: async (request) => {
      calls.push(["start", request]);
      return { sessionId: "ses_probe_bg", state: "running" };
    },
    wait: async (sessionId) => ({ sessionId, text: "probe wait" }),
    cancel: async (sessionId) => ({ sessionId, interrupted: true }),
  };
}

describe("Command Code model candidates", () => {
  test("skips unavailable candidates and keeps the configured order", async () => {
    const backend = probeBackend([kimi]);
    const { tools } = makeHarness({ config: probeConfig, backends: { commandcode: backend } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
    });

    expect(backend.calls[0][1].model).toBe("moonshotai/kimi-k3");
    expect(result.details.model).toBe("moonshotai/kimi-k3");
  });

  test("rejects an explicit model that is absent from the live catalog", async () => {
    const backend = probeBackend([kimi]);
    const { tools } = makeHarness({ config: probeConfig, backends: { commandcode: backend } });

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        target: "category:writing",
        prompt: "Write the docs",
        model: "cloviela/glm-5.3-flash",
      }),
    ).rejects.toThrow(
      "Requested model cloviela/glm-5.3-flash is not in the live model catalog (catalog: 1 models)",
    );
    expect(backend.calls).toHaveLength(0);
  });

  test("honors an explicit available Command Code model override", async () => {
    const backend = probeBackend([qwen, kimi]);
    const { tools } = makeHarness({ config: probeConfig, backends: { commandcode: backend } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
      model: "moonshotai/kimi-k3",
    });

    expect(backend.calls[0][1].model).toBe("moonshotai/kimi-k3");
    expect(result.details.model).toBe("moonshotai/kimi-k3");
  });

  test("uses defaultModels for command routes without a per-route list", async () => {
    const config = {
      backends: { commandcode: { type: "command", command: "commandcode" } },
      defaultModels: ["qwen/qwen3.8-max", "moonshotai/kimi-k3"],
      routes: { "category:writing": { backend: "commandcode" } },
    };
    const backend = probeBackend([qwen, kimi]);
    const { tools } = makeHarness({ config, backends: { commandcode: backend } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
    });

    expect(backend.calls[0][1].model).toBe("qwen/qwen3.8-max");
    expect(result.details.model).toBe("qwen/qwen3.8-max");
  });

  test("configured command catalogs keep candidates regardless of cost", () => {
    expect(
      configuredCommandModels({
        models: ["qwen/qwen3.8-max"],
        freeOnly: true,
        pricePolicy: "free-only",
      }),
    ).toEqual([{ providerID: "qwen", id: "qwen3.8-max", cost: { input: 1, output: 1 } }]);
  });

  test("does not filter a paid live candidate for a legacy freeOnly route", async () => {
    const config = {
      backends: { commandcode: { type: "command", command: "commandcode" } },
      routes: {
        "category:writing": {
          backend: "commandcode",
          models: ["qwen/qwen3.8-max", "reflection/beam:free"],
          freeOnly: true,
          pricePolicy: "free-only",
        },
      },
    };
    const backend = probeBackend([qwen]);
    const { tools } = makeHarness({ config, backends: { commandcode: backend } });

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "category:writing",
      prompt: "Write the docs",
    });

    expect(backend.calls[0][1].model).toBe("qwen/qwen3.8-max");
    expect(result.details.model).toBe("qwen/qwen3.8-max");
  });
});
