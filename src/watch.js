import { join } from "node:path";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

const DAG_WATCH_DEFAULTS = { category: "quick", pollSeconds: 30, timeoutMinutes: 60 };

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

export function normalizeDagWatch(value) {
  if (value === false) return { enabled: false, ...DAG_WATCH_DEFAULTS };
  const overrides = value && typeof value === "object" ? value : {};
  return {
    enabled: true,
    category: overrides.category ?? DAG_WATCH_DEFAULTS.category,
    pollSeconds: overrides.pollSeconds ?? DAG_WATCH_DEFAULTS.pollSeconds,
    timeoutMinutes: overrides.timeoutMinutes ?? DAG_WATCH_DEFAULTS.timeoutMinutes,
  };
}

export function shortId(id) {
  return id.slice(0, 12);
}

// A watch node is an ordinary category-routed senpi child - dag children load
// no extensions, so they cannot call miwarang tools - and its only job is to
// poll the delegated run, which lives outside senpi, until it settles.
export function buildWatchDefinition({ id, backendType, target, runsDirectory, watch }) {
  return {
    key: `miwarang-${id}`,
    name: `miwarang ${target} ${shortId(id)}`,
    nodes: [
      {
        id: "watch",
        label: `Watch ${shortId(id)}`,
        task_summary: `Watch miwarang ${shortId(id)}`,
        category: watch.category,
        prompt: buildWatchPrompt({ id, backendType, runsDirectory, watch }),
      },
    ],
  };
}

function buildWatchPrompt({ id, backendType, runsDirectory, watch }) {
  const bound = `Stop after ${watch.timeoutMinutes} minutes even if the state is not terminal.`;
  if (backendType === "command") {
    return [
      `The background run ${id} executes outside this session. Watch it until it reaches a terminal state; do not read or modify anything else.`,
      `Poll every ${watch.pollSeconds} seconds with one bash call that prints the "state" field of the JSON file ${join(runsDirectory, `${id}.json`)} (for example: cat that file).`,
      `Non-terminal states: "starting", "running", "cancelling". Terminal states: "completed", "failed", "cancelled".`,
      `${bound} Then reply with exactly one line: "${id} <state>".`,
    ].join("\n");
  }
  return [
    `The background opencode session ${id} is running under the local opencode daemon. Watch it until it finishes; do not read or modify anything else.`,
    `Run this with a bash timeout of 300000 ms: opencode api POST /api/experimental/session/${id}/wait`,
    `Exit 0 means the session finished. Exit 124 means it is still running: sleep ${watch.pollSeconds} seconds and run it again. Any other exit code is an error.`,
    `${bound} Then reply with exactly one line: "${id} finished", "${id} still-running", or "${id} error <exit code>".`,
  ].join("\n");
}

// The dag `workflow` tool is exposure-hidden from model calls, and a plain
// ctx.executeTool("workflow", ...) cannot reach it ("Tool workflow not found",
// verified 2026-10-20); the eval kernel's `tool` proxy can, so the bridge goes
// through one eval cell and reads the run ID back from its output.
export function buildEvalCode(definition) {
  return [
    `const definition = ${JSON.stringify(definition)};`,
    `try {`,
    `  const response = await tool.workflow({ action: "start", definition });`,
    `  const runId = response?.details?.run_id ?? response?.run_id;`,
    `  return JSON.stringify(runId ? { ok: true, run_id: runId } : { ok: false, error: "the dag tool returned no run id" });`,
    `} catch (error) {`,
    `  return JSON.stringify({ ok: false, error: String(error?.message ?? error) });`,
    `}`,
  ].join("\n");
}

export function parseWatchRunId(text) {
  const scan = (value) => /dag_[0-9a-f-]{36}/.exec(typeof value === "string" ? value : "")?.[0];
  const raw = typeof text === "string" ? text : "";
  const nested = tryParse(raw)?.result?.content?.[0]?.text;
  const inner = typeof nested === "string" ? nested : raw;
  const parsed = tryParse(inner);
  if (typeof parsed?.run_id === "string") return parsed.run_id;
  return scan(inner) ?? scan(raw);
}

function tryParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// In-memory view of the background runs this session started. Command runs are
// re-read from the run store; opencode sessions have no cheap state probe, so
// their state changes only when wait or cancel reports one.
export function createRunTracker({ readCommandState = async () => undefined } = {}) {
  const runs = new Map();
  return {
    track(run) {
      runs.set(run.id, { state: "running", ...run });
    },
    resolve(id, state) {
      const run = runs.get(id);
      if (run && state) run.state = state;
    },
    list() {
      return [...runs.values()];
    },
    async refresh() {
      for (const run of runs.values()) {
        if (run.backendType !== "command" || isTerminalState(run.state)) continue;
        const state = await readCommandState(run.id);
        if (state) run.state = state;
      }
      return this.list();
    },
  };
}

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatStatusLine(runs, now = Date.now()) {
  const active = runs.filter((run) => !isTerminalState(run.state));
  if (!active.length) return undefined;
  const shown = active
    .slice(0, 3)
    .map((run) => `${shortId(run.id)} ${formatElapsed(now - run.startedAt)}`);
  const extra = active.length > shown.length ? ` +${active.length - shown.length}` : "";
  return `miwarang: ${active.length} active · ${shown.join(" · ")}${extra}`;
}

export function formatRunTable(runs, now = Date.now()) {
  if (!runs.length) return "miwarang: no background runs tracked in this session.";
  const lines = runs.map(
    (run) =>
      `${run.id}  ${run.state}  ${formatElapsed(now - run.startedAt)}  ${run.target} (${run.backend})`,
  );
  return ["miwarang background runs:", ...lines.map((line) => `- ${line}`)].join("\n");
}
