import { describe, expect, test } from "bun:test";
import {
  buildEvalCode,
  buildWatchDefinition,
  createRunTracker,
  formatElapsed,
  formatRunTable,
  formatStatusLine,
  normalizeDagWatch,
  parseWatchRunId,
  shortId,
} from "../src/watch.js";

const RUN_ID = "run_11111111-1111-1111-1111-111111111111";
const SES_ID = "ses_22222222-2222-2222-2222-222222222222";
const DAG_ID = "dag_33333333-4444-5555-6666-777777777777";

describe("normalizeDagWatch", () => {
  test("defaults when unset or true", () => {
    expect(normalizeDagWatch(undefined)).toEqual({
      enabled: true,
      category: "quick",
      pollSeconds: 30,
      timeoutMinutes: 60,
    });
    expect(normalizeDagWatch(true).enabled).toBe(true);
  });

  test("false disables the bridge", () => {
    expect(normalizeDagWatch(false).enabled).toBe(false);
  });

  test("an object overrides individual knobs", () => {
    expect(normalizeDagWatch({ category: "unspecified-low", pollSeconds: 5 })).toEqual({
      enabled: true,
      category: "unspecified-low",
      pollSeconds: 5,
      timeoutMinutes: 60,
    });
  });
});

describe("buildWatchDefinition", () => {
  test("command backend: the node polls the run record file", () => {
    const definition = buildWatchDefinition({
      id: RUN_ID,
      backendType: "command",
      target: "category:quick",
      runsDirectory: "/state/runs",
      watch: normalizeDagWatch(undefined),
    });

    expect(definition.key).toBe(`miwarang-${RUN_ID}`);
    expect(definition.name).toContain("category:quick");
    const node = definition.nodes[0];
    expect(node.id).toBe("watch");
    expect(node.category).toBe("quick");
    expect(node.prompt).toContain(`/state/runs/${RUN_ID}.json`);
    expect(node.prompt).toContain("30 seconds");
    expect(node.prompt).toContain("60 minutes");
    expect(node.prompt).toContain("completed");
  });

  test("opencode backend: the node waits through the opencode CLI", () => {
    const node = buildWatchDefinition({
      id: SES_ID,
      backendType: "opencode-v2",
      target: "agent:explore",
      runsDirectory: "/state/runs",
      watch: normalizeDagWatch({ category: "unspecified-low" }),
    }).nodes[0];

    expect(node.category).toBe("unspecified-low");
    expect(node.prompt).toContain(
      `opencode api POST /api/experimental/session/${SES_ID}/wait`,
    );
    expect(node.prompt).toContain("300000");
  });
});

describe("buildEvalCode", () => {
  test("embeds the definition and returns the run id as JSON", () => {
    const definition = { key: "k", nodes: [{ id: "watch", category: "quick", prompt: "p" }] };
    const code = buildEvalCode(definition);

    expect(code).toContain(JSON.stringify(definition));
    expect(code).toContain(`tool.workflow({ action: "start", definition })`);
    expect(code).toContain("run_id: runId");
  });
});

describe("parseWatchRunId", () => {
  test("parses the wrapped eval tool result", () => {
    const inner = JSON.stringify({ ok: true, run_id: DAG_ID });
    const text = JSON.stringify({
      toolCall: { name: "eval" },
      result: { content: [{ type: "text", text: inner }] },
      isError: false,
    });

    expect(parseWatchRunId(text)).toBe(DAG_ID);
  });

  test("falls back to scanning raw text", () => {
    expect(parseWatchRunId(`prefix ${DAG_ID} suffix`)).toBe(DAG_ID);
  });

  test("returns undefined when the bridge failed", () => {
    const inner = JSON.stringify({ ok: false, error: "Tool workflow not found" });
    const text = JSON.stringify({ result: { content: [{ type: "text", text: inner }] } });

    expect(parseWatchRunId(text)).toBeUndefined();
    expect(parseWatchRunId("")).toBeUndefined();
  });

  test("ignores run_ and ses_ ids echoed back from the definition", () => {
    const echoed = JSON.stringify({ key: `miwarang-${RUN_ID}` });
    expect(parseWatchRunId(`echo ${echoed}`)).toBeUndefined();
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
