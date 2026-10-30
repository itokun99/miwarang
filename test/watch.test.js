import { describe, expect, test } from "bun:test";
import {
  createRunTracker,
  formatElapsed,
  formatRunTable,
  formatStatusLine,
  isTerminalState,
  shortId,
} from "../src/watch.js";

const RUN_ID = "run_11111111-1111-1111-1111-111111111111";
const SES_ID = "ses_22222222-2222-2222-2222-222222222222";

describe("run states", () => {
  test("recognizes terminal states", () => {
    expect(isTerminalState("completed")).toBe(true);
    expect(isTerminalState("failed")).toBe(true);
    expect(isTerminalState("cancelled")).toBe(true);
    expect(isTerminalState("running")).toBe(false);
  });
});

describe("createRunTracker", () => {
  test("refresh re-reads command runs from the store and skips the rest", async () => {
    const reads = [];
    const tracker = createRunTracker({
      readCommandState: async (id) => {
        reads.push(id);
        return "completed";
      },
    });
    tracker.track({
      id: RUN_ID,
      backendType: "command",
      backend: "cc",
      target: "category:writing",
      startedAt: 0,
    });
    tracker.track({
      id: SES_ID,
      backendType: "opencode-v2",
      backend: "oc",
      target: "category:quick",
      startedAt: 0,
    });

    await tracker.refresh();

    expect(reads).toEqual([RUN_ID]);
    const byId = Object.fromEntries(tracker.list().map((run) => [run.id, run.state]));
    expect(byId).toEqual({ [RUN_ID]: "completed", [SES_ID]: "running" });
  });

  test("resolve updates a tracked run", () => {
    const tracker = createRunTracker();
    tracker.track({
      id: SES_ID,
      backendType: "opencode-v2",
      backend: "oc",
      target: "category:quick",
      startedAt: 0,
    });

    tracker.resolve(SES_ID, "completed");

    expect(formatStatusLine(tracker.list(), 0)).toBeUndefined();
  });
});

describe("formatting", () => {
  test("formatElapsed buckets seconds, minutes and hours", () => {
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(3 * 60_000 + 5_000)).toBe("3m");
    expect(formatElapsed(2 * 3_600_000 + 4 * 60_000)).toBe("2h 04m");
  });

  test("status line counts active runs and caps the list at three", () => {
    const runs = ["run_aaaa", "run_bbbb", "run_cccc", "run_dddd"].map((id) => ({
      id,
      state: "running",
      startedAt: 0,
    }));

    expect(formatStatusLine(runs, 60_000)).toBe(
      "miwarang: 4 active · run_aaaa 1m · run_bbbb 1m · run_cccc 1m +1",
    );
    expect(
      formatStatusLine([{ id: "run_x", state: "completed", startedAt: 0 }], 0),
    ).toBeUndefined();
  });

  test("run table lists every tracked run", () => {
    const runs = [
      {
        id: RUN_ID,
        state: "completed",
        startedAt: 0,
        target: "category:quick",
        backend: "opencode",
      },
    ];

    expect(formatRunTable(runs, 5_000)).toContain(
      `- ${RUN_ID}  completed  5s  category:quick (opencode)`,
    );
    expect(formatRunTable([])).toContain("no background runs");
  });

  test("shortId truncates to twelve characters", () => {
    expect(shortId("ses_22222222-2222")).toBe("ses_22222222");
  });
});
