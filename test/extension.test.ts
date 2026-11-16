import { describe, expect, test } from "bun:test";
import { invoke, makeHarness } from "./support/extension-harness.ts";

describe("Senpi extension registration", () => {
  test("registers the delegation lifecycle tools", () => {
    const { tools } = makeHarness();

    expect([...tools.keys()]).toEqual([
      "miwarang_delegate",
      "miwarang_wait",
      "miwarang_cancel",
    ]);
    expect(tools.get("miwarang_delegate").parameters.required).toEqual(["prompt"]);
  });

  test("delegates by prompt through the primary backend with its configured agent", async () => {
    const { tools, calls } = makeHarness();

    const result = await invoke(tools.get("miwarang_delegate"), {
      prompt: "List relevant files",
      mode: "background",
    });

    expect(calls[0]).toEqual([
      "start",
      {
        cwd: "/workspace",
        prompt: "List relevant files",
        agent: "Orchestrator",
      },
    ]);
    expect(result.details).toMatchObject({
      sessionId: "ses_background",
      resolvedVia: "primary",
      backend: "opencode",
      agent: "Orchestrator",
    });
    expect(result.details).not.toHaveProperty("model");
  });

  test("waits for and cancels a background session by ID", async () => {
    const { tools, calls } = makeHarness();

    const waited = await invoke(tools.get("miwarang_wait"), {
      sessionId: "ses_background",
    });
    const cancelled = await invoke(tools.get("miwarang_cancel"), {
      sessionId: "ses_background",
    });

    expect(calls).toEqual([
      ["wait", "ses_background"],
      ["cancel", "ses_background"],
    ]);
    expect(waited.content[0].text).toContain("Background result");
    expect(cancelled.details).toMatchObject({
      sessionId: "ses_background",
      interrupted: true,
    });
  });

  test("background runs carry the OMO thread identity for main-orchestrator validation", async () => {
    const { tools, calls } = makeHarness();
    const ctx = { cwd: "/workspace", sessionId: "thread_abc123" };

    const result = await invoke(tools.get("miwarang_delegate"), {
      prompt: "List relevant files",
      mode: "background",
    }, ctx);

    expect(result.details).toMatchObject({
      sessionId: "ses_background",
      omoThreadId: "thread_abc123",
      backend: "opencode",
    });
    expect(calls[0]).toEqual([
      "start",
      { cwd: "/workspace", prompt: "List relevant files", agent: "Orchestrator" },
    ]);
  });

  test("wait and cancel return the stable OMO thread and run identifiers", async () => {
    const { tools } = makeHarness();
    const ctx = { cwd: "/workspace", sessionId: "thread_abc123" };

    const waited = await invoke(tools.get("miwarang_wait"), {
      sessionId: "ses_background",
    }, ctx);
    const cancelled = await invoke(tools.get("miwarang_cancel"), {
      sessionId: "ses_background",
    }, ctx);

    expect(waited.details).toMatchObject({
      sessionId: "ses_background",
      omoThreadId: "thread_abc123",
      text: "Background result",
    });
    expect(cancelled.details).toMatchObject({
      sessionId: "ses_background",
      omoThreadId: "thread_abc123",
      interrupted: true,
    });
  });

  test("a backend override delegates to that backend only", async () => {
    const { tools, calls } = makeHarness();

    const result = await invoke(tools.get("miwarang_delegate"), {
      prompt: "Write the docs",
      backend: "commandcode",
    });

    expect(calls).toHaveLength(1);
    expect(result.details).toMatchObject({
      backend: "commandcode",
      resolvedVia: "override",
      agent: "General",
    });
  });

  test("unknown backend overrides fail closed", async () => {
    const { tools } = makeHarness();

    await expect(
      invoke(tools.get("miwarang_delegate"), {
        prompt: "Write the docs",
        backend: "missing",
      }),
    ).rejects.toThrow(/Backend missing is not configured/);
  });

  test("an empty prompt is rejected before any backend runs", async () => {
    const { tools, calls } = makeHarness();

    await expect(
      invoke(tools.get("miwarang_delegate"), { prompt: "" }),
    ).rejects.toThrow(/prompt must be a non-empty string/);
    expect(calls).toEqual([]);
  });
});
