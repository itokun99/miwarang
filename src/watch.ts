const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

export type RunState = string;

export interface TrackedRun {
  id: string;
  state: RunState;
  startedAt: number;
  backend: string;
  backendType?: string;
  target?: string;
  [key: string]: unknown;
}

export interface RunTrackerOptions {
  readCommandState?: (id: string) => Promise<string | undefined>;
}

export interface RunTracker {
  track(run: TrackedRun): void;
  resolve(id: string, state?: string): void;
  list(): TrackedRun[];
  refresh(): Promise<TrackedRun[]>;
}

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

export function shortId(id: string): string {
  return id.slice(0, 12);
}

// In-memory view of the background runs this session started. Command runs are
// re-read from the run store; OpenCode sessions have no cheap state probe, so
// their state changes only when wait or cancel reports one.
export function createRunTracker({
  readCommandState = async () => undefined,
}: RunTrackerOptions = {}): RunTracker {
  const runs = new Map<string, TrackedRun>();
  return {
    track(run: TrackedRun) {
      const tracked: TrackedRun = { ...run, state: "running" };
      runs.set(run.id, tracked);
    },
    resolve(id: string, state?: string) {
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

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatStatusLine(runs: TrackedRun[], now = Date.now()): string | undefined {
  const active = runs.filter((run) => !isTerminalState(run.state));
  if (!active.length) return undefined;
  const shown = active
    .slice(0, 3)
    .map((run) => `${shortId(run.id)} ${formatElapsed(now - run.startedAt)}`);
  const extra = active.length > shown.length ? ` +${active.length - shown.length}` : "";
  return `miwarang: ${active.length} active · ${shown.join(" · ")}${extra}`;
}

export function formatRunTable(runs: TrackedRun[], now = Date.now()): string {
  if (!runs.length) return "miwarang: no background runs tracked in this session.";
  const lines = runs.map(
    (run) =>
      `${run.id}  ${run.state}  ${formatElapsed(now - run.startedAt)}  ${run.target} (${run.backend})`,
  );
  return ["miwarang background runs:", ...lines.map((line) => `- ${line}`)].join("\n");
}
