import { describe, expect, test } from "bun:test";
import { makeHarness } from "./support/extension-harness.js";

const policyBackends = { opencode: { type: "opencode-v2", command: "opencode" } };

function route(blockNativeTask) {
  const entry = { backend: "opencode", models: ["opencode/space-bunny-free"] };
  if (blockNativeTask !== undefined) entry.blockNativeTask = blockNativeTask;
  return entry;
}

async function taskResult(activeConfig, input) {
  const { handlers } = makeHarness({ config: activeConfig });
  return handlers.get("tool_call")[0]({ toolName: "task", input });
}

describe("native task blocking policy", () => {
  test("blocks an exact route that opts in with blockNativeTask true", async () => {
    const activeConfig = { backends: policyBackends, routes: { "category:writing": route(true) } };

    const result = await taskResult(activeConfig, { category: "writing", prompt: "Write the docs" });

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("miwarang_delegate");
    expect(result.reason).toContain("category:writing");
  });

  test("passes through an exact route with blockNativeTask false", async () => {
    const activeConfig = { backends: policyBackends, routes: { "category:deep-high": route(false) } };

    expect(await taskResult(activeConfig, { category: "deep-high", prompt: "Think" })).toBeUndefined();
  });

  test("passes through a target that only matches defaultRoute", async () => {
    const activeConfig = {
      backends: policyBackends,
      routes: { "category:writing": route(true) },
      defaultRoute: route(true),
    };

    expect(await taskResult(activeConfig, { category: "brand-new", prompt: "Hello" })).toBeUndefined();
  });

  test("passes through an unresolvable target without throwing", async () => {
    const activeConfig = { backends: policyBackends, routes: {} };

    expect(await taskResult(activeConfig, { category: "unknown", prompt: "Hi" })).toBeUndefined();
  });

  test("treats an absent policy as configured: exact and wildcard block, defaultRoute does not", async () => {
    const activeConfig = {
      backends: policyBackends,
      routes: { "category:writing": route(undefined), "category:*": route(undefined) },
      defaultRoute: route(undefined),
    };

    expect(await taskResult(activeConfig, { category: "writing" })).toMatchObject({ block: true });
    expect(await taskResult(activeConfig, { category: "other" })).toMatchObject({ block: true });
    expect(await taskResult(activeConfig, { agent: "thing" })).toBeUndefined();
  });

  test('top-level "all" blocks configured targets that carry no per-route flag', async () => {
    const activeConfig = {
      backends: policyBackends,
      blockNativeTask: "all",
      routes: { "category:writing": route(undefined), "category:*": route(undefined) },
    };

    expect(await taskResult(activeConfig, { category: "writing" })).toMatchObject({ block: true });
    expect(await taskResult(activeConfig, { category: "other" })).toMatchObject({ block: true });
  });

  test('top-level "none" passes configured targets unless the route opts in', async () => {
    const activeConfig = {
      backends: policyBackends,
      blockNativeTask: "none",
      routes: { "category:writing": route(undefined), "category:architect": route(true) },
    };

    expect(await taskResult(activeConfig, { category: "writing" })).toBeUndefined();
    expect(await taskResult(activeConfig, { category: "architect" })).toMatchObject({ block: true });
  });

  test("per-route false overrides a top-level blocking policy", async () => {
    const activeConfig = {
      backends: policyBackends,
      blockNativeTask: "all",
      routes: { "category:deep-high": route(false) },
    };

    expect(await taskResult(activeConfig, { category: "deep-high" })).toBeUndefined();
  });

  test("array flag blocks only the listed targets", async () => {
    const activeConfig = {
      backends: policyBackends,
      routes: {
        "category:writing": route(["category:writing"]),
        "category:*": route(["category:writing"]),
      },
    };

    expect(await taskResult(activeConfig, { category: "writing" })).toMatchObject({ block: true });
    expect(await taskResult(activeConfig, { category: "other" })).toBeUndefined();
  });

  test("array flag with a namespace wildcard covers every target in that namespace", async () => {
    const activeConfig = {
      backends: policyBackends,
      routes: { "category:*": route(["category:*"]) },
    };

    expect(await taskResult(activeConfig, { category: "anything" })).toMatchObject({ block: true });
    expect(await taskResult(activeConfig, { agent: "explore" })).toBeUndefined();
  });

  test("blocks a batched task when any target is policy-blocked", async () => {
    const activeConfig = {
      backends: policyBackends,
      routes: { "category:writing": route(true), "category:deep-high": route(false) },
    };

    const result = await taskResult(activeConfig, {
      tasks: [{ category: "deep-high" }, { category: "writing" }],
    });

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("category:writing");
    expect(result.reason).not.toContain("category:deep-high");
  });

  const matrixKinds = ["exact", "wildcard", "default", "no-match"];
  const matrixFlags = [false, true, undefined];
  const matrixTop = ["configured", "all", "none"];

  function matrixConfig(kind, flag, top) {
    const routes = {};
    if (kind === "exact") {
      routes["category:writing"] = route(flag);
      routes["category:*"] = route(undefined);
    } else if (kind === "wildcard") {
      routes["category:*"] = route(flag);
    } else if (kind === "default") {
      routes["category:unrelated"] = route(undefined);
    } else {
      routes["category:unrelated"] = route(flag);
    }
    const activeConfig = { backends: policyBackends, routes, blockNativeTask: top };
    if (kind === "default") activeConfig.defaultRoute = route(flag);
    return activeConfig;
  }

  const matrixTarget = {
    exact: { category: "writing" },
    wildcard: { category: "other" },
    default: { agent: "thing" },
    "no-match": { category: "writing" },
  };

  function matrixExpected(kind, flag, top) {
    if (kind === "default" || kind === "no-match") return false;
    if (flag === false) return false;
    if (flag === true) return true;
    return top !== "none";
  }

  for (const kind of matrixKinds) {
    for (const flag of matrixFlags) {
      for (const top of matrixTop) {
        const label =
          `matrix ${kind} / route flag ${flag === undefined ? "none" : flag} / top ${top}`;
        test(label, async () => {
          const result = await taskResult(matrixConfig(kind, flag, top), matrixTarget[kind]);

          if (matrixExpected(kind, flag, top)) {
            expect(result).toMatchObject({ block: true });
            expect(result.reason).toContain("miwarang_delegate");
          } else {
            expect(result).toBeUndefined();
          }
        });
      }
    }
  }
});
