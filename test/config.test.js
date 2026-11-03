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
  test("selects the first available configured model even if paid", () => {
    expect(resolveRoute(config, "category:quick", liveModels)).toEqual({
      backend: { type: "opencode-v2", command: "opencode" },
      target: "category:quick",
      model: "opencode/claude-sonnet-5",
    });
  });

  test("preserves route agent metadata for command adapters", () => {
    expect(resolveRoute(config, "agent:explore", liveModels)).toEqual({
      backend: { type: "opencode-v2", command: "opencode" },
      target: "agent:explore",
      model: "opencode-go/step-5-preview-free",
      agent: "explore",
    });
  });

  test("does not filter a configured candidate by mixed catalog cost tiers", () => {
    const mixedCost = {
      providerID: "opencode",
      id: "space-bunny-free",
      cost: [{ input: 0, output: 0 }, { input: 1, output: 2 }],
    };

    expect(resolveRoute(config, "category:quick", [mixedCost]).model).toBe(
      "opencode/space-bunny-free",
    );
  });

  test("honors an explicit paid model override on a legacy freeOnly route", () => {
    expect(
      resolveRoute(config, "category:quick", liveModels, {
        model: "opencode/claude-sonnet-5",
      }),
    ).toMatchObject({ model: "opencode/claude-sonnet-5" });
  });

  test("fails when no configured candidate is available", () => {
    expect(() =>
      resolveRoute(config, "category:quick", [{ providerID: "other", id: "model" }]),
    ).toThrow("No configured model is available for category:quick");
  });

  test("an unavailable override reports the catalog size", () => {
    expect(() =>
      resolveRoute(config, "category:quick", liveModels, { model: "cloviela/glm-5.3-flash" }),
    ).toThrow(
      "Requested model cloviela/glm-5.3-flash is not in the live model catalog (catalog: 3 models). " +
        "Omit the model override",
    );
  });

  test("matches a bare candidate ID when the catalog has no provider prefix", () => {
    const bare = {
      backends: { opencode: { type: "opencode-v2", command: "opencode" } },
      routes: {
        "category:quick": { backend: "opencode", models: ["claude-sonnet-5-5"] },
      },
    };

    expect(
      resolveRoute(bare, "category:quick", [
        { providerID: "", id: "claude-sonnet-5-5", cost: { input: 1, output: 1 } },
      ]).model,
    ).toBe("claude-sonnet-5-5");
  });

  test("fails clearly for an unconfigured target", () => {
    expect(() => resolveRoute(config, "category:unknown", liveModels)).toThrow(
      /no route configured/i,
    );
  });
});
