import { describe, expect, test } from "bun:test";
import { createMiwarangService } from "../src/service.ts";
import { createRunTracker } from "../src/watch.ts";
import type { MiwarangConfig } from "../src/config.ts";

const config: MiwarangConfig = {
  backends: {
    opencode: { type: "opencode-cli", command: "opencode", args: ["run"], promptInput: "argument" },
    commandcode: { type: "command", command: "commandcode", args: ["-p"], agent: "General" },
  },
  delegation: ["opencode", "commandcode"],
};

function makeService(overrides: Record<string, any> = {}) {
  const calls: string[] = [];
  const opencode = {
    runForeground: async (request: any) => {
      calls.push(`opencode.foreground:${request.prompt}`);
      return { sessionId: "ses_fg", text: "Foreground result" };
    },
    start: async (request: any) => {
      calls.push(`opencode.start:${request.prompt}`);
      return { sessionId: "ses_bg", state: "running" };
    },
    wait: async (id: string) => {
      calls.push(`opencode.wait:${id}`);
      return { sessionId: id, state: "completed", text: "Background result" };
    },
    cancel: async (id: string) => {
      calls.push(`opencode.cancel:${id}`);
      return { sessionId: id, state: "cancelled", cancelled: true };
    },
  };
  const service = createMiwarangService({
    config,
    backends: { opencode, commandcode: {} as never },
    tracker: createRunTracker({ readCommandState: async () => undefined }),
    store: { get: async () => undefined } as never,
    ...overrides,
  });
  return { service, calls };
}

describe("host-neutral service", () => {
  test("delegate foreground returns the versioned envelope and result text", async () => {
    const { service } = makeService();
    const { text, details } = await service.delegate({ prompt: "Do the work" }, { cwd: "/workspace" });
    expect(text).toBe("Foreground result");
    expect(details).toMatchObject({
      version: 1,
      state: "completed",
      backend: "opencode",
      resolvedVia: "primary",
      mode: "foreground",
    });
  });

  test("delegate background tracks the run and reports the run id", async () => {
    const tracked: any[] = [];
    const { service } = makeService({
      onRunTracked: (run: any) => tracked.push(run),
    });
    const { text, details } = await service.delegate(
      { prompt: "Long work", mode: "background" },
      { cwd: "/workspace", sessionId: "omo_thread_1" },
    );
    expect(text).toContain("ses_bg");
    expect(details.omoThreadId).toBe("omo_thread_1");
    expect(tracked).toHaveLength(1);
    expect(tracked[0].id).toBe("ses_bg");
  });

  test("wait and cancel resolve through the configured backend", async () => {
    const { service, calls } = makeService();
    const waited = await service.wait({ runId: "ses_bg" }, { sessionId: "thread_2" });
    expect(waited.text).toBe("Background result");
    expect(waited.details.omoThreadId).toBe("thread_2");
    const cancelled = await service.cancel({ sessionId: "ses_bg" });
    expect(cancelled.details.cancelled).toBe(true);
    expect(calls.some((c) => c.startsWith("opencode.wait:"))).toBe(true);
    expect(calls.some((c) => c.startsWith("opencode.cancel:"))).toBe(true);
  });

  test("wait rejects a missing run id", async () => {
    const { service } = makeService();
    await expect(service.wait({}, {})).rejects.toThrow(/sessionId or runId/);
  });
});
