// Streaming delta events: bounded per-chunk emission so a slow consumer cannot
// stall the backend. A queue holds deltas when a consumer is busy.
const MAX_PENDING_DELTAS = 32;

export type StreamSink = (delta: string) => void;

export function emitDelta(onUpdate: StreamSink, chunk: string): void {
  if (pending.length >= MAX_PENDING_DELTAS) return;
  pending.push([onUpdate, chunk]);
  if (draining) return;
  draining = true;
  queueMicrotask(drain);
}

const pending: Array<[(delta: string) => void, string]> = [];
let draining = false;

function drain(): void {
  try {
    while (pending.length) {
      const [update, delta] = pending.shift()!;
      try {
        update(delta);
      } catch {
        // A broken consumer cannot abort the run it is streaming from.
      }
    }
  } finally {
    draining = false;
  }
}
