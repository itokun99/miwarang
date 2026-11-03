import { describe, expect, test } from "bun:test";
import { invoke, makeHarness, uiRecorder, wildcardOverrideConfig } from "./support/extension-harness.js";

describe("progress surfaces", () => {
  test("the status line shows a run on start and clears after wait", async () => {
    const { tools } = makeHarness();
    const { statuses, ui } = uiRecorder();
    const ctx = { cwd: "/workspace", ui };

    await invoke(
      tools.get("miwarang_delegate"),
      { target: "agent:explore", prompt: "List files", mode: "background" },
      ctx,
    );
    expect(statuses.at(-1)[0]).toBe("miwarang");
    expect(statuses.at(-1)[1]).toContain("1 active");
    expect(statuses.at(-1)[1]).toContain("ses_");

    await invoke(tools.get("miwarang_wait"), { sessionId: "ses_background" }, ctx);
    expect(statuses.at(-1)).toEqual(["miwarang", undefined]);
  });

  test("tracks and waits for five background runs without a DAG child", async () => {
    const sessions = [];
    const opencode = {
      listModels: async () => {
        throw new Error("OpenCode model catalogs are not part of delegation");
      },
      start: async () => {
        const sessionId = `ses_multi_${sessions.length + 1}`;
        sessions.push(sessionId);
        return { sessionId, state: "running" };
      },
      wait: async (sessionId) => ({
        sessionId,
        state: "completed",
        text: `completed ${sessionId}`,
      }),
      cancel: async () => ({}),
    };
    const { tools } = makeHarness({ backends: { opencode } });
    const { statuses, ui } = uiRecorder();
    const ctx = { cwd: "/workspace", ui };

    const started = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        invoke(
          tools.get("miwarang_delegate"),
          {
            target: "category:quick",
            prompt: `Background task ${index + 1}`,
            mode: "background",
          },
          ctx,
        ),
      ),
    );
    const ids = started.map((result) => result.details.sessionId);
    expect(ids).toEqual([
      "ses_multi_1",
      "ses_multi_2",
      "ses_multi_3",
      "ses_multi_4",
      "ses_multi_5",
    ]);
    const completed = await Promise.all(
      ids.map((sessionId) =>
        invoke(tools.get("miwarang_wait"), { sessionId }, ctx),
      ),
    );
    expect(completed.map((result) => result.content[0].text)).toEqual([
      "completed ses_multi_1",
      "completed ses_multi_2",
      "completed ses_multi_3",
      "completed ses_multi_4",
      "completed ses_multi_5",
    ]);
    expect(statuses.at(-1)).toEqual(["miwarang", undefined]);
  });

  test("/miwarang reports the tracked runs", async () => {
    const { tools, commands } = makeHarness();
    const { notices, ui } = uiRecorder();
    const ctx = { cwd: "/workspace", ui };

    await invoke(
      tools.get("miwarang_delegate"),
      { target: "agent:explore", prompt: "List files", mode: "background" },
      ctx,
    );
    await commands.get("miwarang").handler("", ctx);

    const [text, level] = notices.at(-1);
    expect(text).toContain("ses_background");
    expect(text).toContain("agent:explore");
    expect(level).toBe("info");
  });

  test("the command backend status line polls the run store while alive", async () => {
    const intervals = [];
    const { tools } = makeHarness({
      config: wildcardOverrideConfig,
      timers: {
        setInterval: (fn, ms) => {
          intervals.push(ms);
          return intervals.length;
        },
        clearInterval: () => {},
      },
    });
    const { ui } = uiRecorder();

    await invoke(
      tools.get("miwarang_delegate"),
      { target: "category:architect", prompt: "Do it", mode: "background" },
      { cwd: "/workspace", ui },
    );

    expect(intervals).toEqual([15000]);
  });
});
