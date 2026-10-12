import { describe, expect, test } from "bun:test";
import { resolveRoute } from "../src/config.js";

const liveModels = [
  {
    providerID: "opencode",
    id: "space-bunny-free",
    cost: { input: 0, output: 0 },
  },
  {
    providerID: "opencode-go",
    id: "step-5-preview-free",
    cost: { input: 0, output: 0 },
  },
  {
    providerID: "opencode",
    id: "claude-sonnet-5",
    cost: { input: 3, output: 15 },
  },
];

const config = {
  backends: {
    opencode: { type: "opencode-v2", command: "opencode" },
  },
  routes: {
    "category:quick": {
      backend: "opencode",
      models: [
        "opencode/not-in-catalog",
        "opencode/claude-sonnet-5",
        "opencode/space-bunny-free",
      ],
      freeOnly: true,
    },
    "agent:explore": {
      backend: "opencode",
      models: ["opencode-go/step-5-preview-free"],
      freeOnly: true,
      agent: "explore",
    },
  },
};

describe("resolveRoute", () => {
  test("selects the first available free model from a category route", () => {
    expect(resolveRoute(config, "category:quick", liveModels)).toEqual({
      backend: { type: "opencode-v2", command: "opencode" },
      target: "category:quick",
      model: "opencode/space-bunny-free",
      freeOnly: true,
    });
  });

  test("preserves the configured agent for an agent route", () => {
    expect(resolveRoute(config, "agent:explore", liveModels)).toEqual({
      backend: { type: "opencode-v2", command: "opencode" },
      target: "agent:explore",
      model: "opencode-go/step-5-preview-free",
      agent: "explore",
      freeOnly: true,
    });
  });

  test("recognizes OpenCode array-shaped zero-cost tiers as free", () => {
    const model = {
      providerID: "opencode",
      id: "space-bunny-free",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    };

    expect(resolveRoute(config, "category:quick", [model]).model).toBe(
      "opencode/space-bunny-free",
    );
  });

  test("rejects array-shaped pricing when any tier is paid", () => {
    const model = {
      providerID: "opencode",
      id: "space-bunny-free",
      cost: [
        { input: 0, output: 0, cache: { read: 0, write: 0 } },
        { input: 1, output: 2, cache: { read: 0, write: 0 } },
      ],
    };

    expect(() => resolveRoute(config, "category:quick", [model])).toThrow(
      /no available free model/i,
    );
  });

  test("accepts an explicit available model override", () => {
    expect(
      resolveRoute(config, "category:quick", liveModels, {
        model: "opencode-go/step-5-preview-free",
      }).model,
    ).toBe("opencode-go/step-5-preview-free");
  });

  test("rejects an explicit paid model on a free-only route", () => {
    expect(() =>
      resolveRoute(config, "category:quick", liveModels, {
        model: "opencode/claude-sonnet-5",
      }),
    ).toThrow(/free/i);
  });

  test("fails when no configured free candidate is available", () => {
    expect(() =>
      resolveRoute(config, "category:quick", [liveModels[2]]),
    ).toThrow(/no available free model/i);
  });

  test("fails clearly for an unconfigured target", () => {
    expect(() =>
      resolveRoute(config, "category:unknown", liveModels),
    ).toThrow(/no route configured/i);
  });
});
