const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

export function shortId(id) {
  return id.slice(0, 12);
}

// In-memory view of the background runs this session started. Command runs are
// re-read from the run store; OpenCode sessions have no cheap state probe, so
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
