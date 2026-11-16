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
    expect(tools.get("miwarang_delegate").parameters.required).toEqual(["target", "prompt"]);
  });

  test("delegates an OMO agent route without forwarding it as a harness agent", async () => {
    const { tools, calls } = makeHarness();

    const result = await invoke(tools.get("miwarang_delegate"), {
      target: "agent:explore",
      prompt: "List relevant files",
      mode: "background",
    });

    expect(calls[0]).toEqual([
      "start",
      {
        cwd: "/workspace",
        target: "agent:explore",
        prompt: "List relevant files",
      },
    ]);
    expect(result.details).toMatchObject({
      sessionId: "ses_background",
      resolvedVia: "exact",
      backend: "opencode",
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
      target: "agent:explore",
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
      { cwd: "/workspace", target: "agent:explore", prompt: "List relevant files" },
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

  test("redirects routed native tasks and leaves unrelated tasks alone", async () => {
    const { handlers } = makeHarness();
    const handler = handlers.get("tool_call")[0];

    const redirected = await handler({
      toolName: "task",
      input: {
        category: "quick",
        prompt: "Inspect this project",
        run_in_background: true,
      },
    });
    const unchanged = await handler({
      toolName: "task",
      input: { category: "architect", prompt: "Design the system" },
    });

    expect(redirected).toMatchObject({ block: true });
    expect(unchanged).toBeUndefined();
  });
});
