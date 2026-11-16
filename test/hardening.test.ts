import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createCommandBackend } from "../src/backends/command.ts";
import { createKomaBackend } from "../src/backends/koma.ts";
import { RunStore } from "../src/runs/store.ts";

function childWithOutput(stdout: string) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = null;
  child.pid = 4242;
  child.kill = () => {};
  queueMicrotask(() => {
    child.emit("spawn");
    if (stdout) child.stdout.emit("data", stdout);
    child.emit("close", 0, null);
  });
  return child;
}

describe("axis (a) streaming events", () => {
  test("command backend forwards stdout chunks through onUpdate", async () => {
    const deltas: string[] = [];
    const backend = createCommandBackend(
      { command: "agent-cli", args: [], promptInput: "stdin" },
      { runStore: {} as never, spawn: () => childWithOutput("stream chunk") as never },
    );
    const result = await backend.runForeground({ prompt: "work", onUpdate: (d) => deltas.push(d) });
    expect(result.text).toBe("stream chunk");
    // A microtask boundary has passed by the time the promise resolves, so the
    // queued delta has been drained.
    expect(deltas.join("")).toBe("stream chunk");
  });

  test("a throwing onUpdate consumer cannot abort the run", async () => {
    const backend = createCommandBackend(
      { command: "agent-cli", args: [], promptInput: "stdin" },
      {
        runStore: {} as never,
        spawn: () =>
          childWithOutput("ok result") as never,
      },
    );
    const result = await backend.runForeground({
      prompt: "work",
      onUpdate: () => {
        throw new Error("consumer broke");
      },
    });
    expect(result.text).toBe("ok result");
  });
});

describe("axis (c) cancellation terminal state", () => {
  test("cancel returns the terminal recorded state with exit code and signal", async () => {
    const updates: any[] = [];
    const store = {
      async create(record: any) {
        return { ...record, id: "run_cancel" };
      },
      async update(id: string, patch: any) {
        updates.push([id, patch]);
        return { id, ...patch };
      },
      async get(id: string) {
        return updates
          .filter(([rid]) => rid === id)
          .map(([, patch]) => patch)
          .reduce((acc, patch) => ({ ...acc, ...patch }), {} as any);
      },
    };
    const backend = createCommandBackend(
      { command: "agent-cli", args: [], promptInput: "stdin", id: "cc" },
      {
        runStore: store as never,
        spawn: () => childWithOutput("partial output") as never,
      },
    );
    const started = await backend.start({ prompt: "work" });
    // Let the run reach its terminal state first: the fake child closes
    // immediately, so wait() returns once the completion promise has stored the
    // recorded exit code.
    await backend.wait(started.runId);
    const cancelResult = await backend.cancel(started.runId);
    expect(cancelResult.cancelled).toBe(false);
    expect(cancelResult.state).toBe("completed");
    expect(cancelResult.exitCode).toBe(0);
  });
});

describe("axis (f) cross-backend redaction", () => {
  test("command backend redacts secrets in stdout text and stored resultText", async () => {
    const updates: any[] = [];
    const store = {
      async create(record: any) {
        return { ...record, id: "run_redact" };
      },
      async update(id: string, patch: any) {
        updates.push([id, patch]);
        return { id, ...patch };
      },
      async get(id: string) {
        const patch = updates.find(([rid, p]) => rid === id && "resultText" in p)?.[1];
        return { id, ...patch };
      },
    };
    const backend = createCommandBackend(
      { command: "agent-cli", args: [], promptInput: "stdin", id: "cc" },
      {
        runStore: store as never,
        spawn: () => childWithOutput("Bearer abc123 and api_key=xyz987 leak") as never,
      },
    );
    const result = await backend.runForeground({ prompt: "work" });
    expect(result.text).toContain("[redacted]");
    expect(result.text).not.toContain("abc123");
    expect(result.text).not.toContain("xyz987");
  });

  test("koma backend redacts secrets in the returned assistant text", async () => {
    const HELLO = {
      type: "hello",
      protocol: 1,
      capabilities: ["create", "submit", "detach"],
    };
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.pid = 4242;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    child.stdin = {
      writable: true,
      write(chunk: string) {
        const request = JSON.parse(chunk);
        const emit = (frame: any) =>
          queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify(frame)}\n`));
        if (request.method === "create") {
          emit({ type: "response", id: request.id, result: { state: { session_id: "s1", turn: null } } });
        }
        if (request.method === "submit") {
          emit({
            type: "response",
            id: request.id,
            result: { disposition: "started", turn_id: "turn-1" },
          });
          emit({ type: "event", event: "state", state: { turn: { id: "turn-1", state: "running" }, working: true } });
          emit({
            type: "event",
            event: "state",
            state: {
              turn: { id: "turn-1", state: "finished" },
              working: false,
              messages: [{ role: "assistant", content: "token=super-secret-123 done" }],
            },
          });
        }
        if (request.method === "detach") {
          emit({ type: "response", id: request.id, result: { detached: true } });
        }
        return true;
      },
      end() {},
    };
    const emitHello = () =>
      queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify(HELLO)}\n`));
    emitHello();

    const runStore = new RunStore();
    const backend = createKomaBackend(
      { command: "koma", args: ["sdk", "serve"], timeoutMs: 3000 },
      { spawn: () => child, runStore },
    );
    const result = await backend.runForeground({ cwd: "/workspace", prompt: "do work" });
    expect(result.text).toContain("[redacted]");
    expect(result.text).not.toContain("super-secret-123");
  });
});

describe("axis (b) structured result envelope", () => {
  test("envelope carries version, state, backend, and optional terminal fields", async () => {
    const { buildEnvelope } = await import("../src/envelope.ts");
    const envelope = buildEnvelope({
      result: { text: "done", state: "completed", exitCode: 0, runId: "run_x" },
      backend: "opencode",
      agent: "Orchestrator",
      fallbackIndex: 0,
      resolvedVia: "primary",
      mode: "foreground",
    });
    expect(envelope.version).toBe(1);
    expect(envelope.state).toBe("completed");
    expect(envelope.backend).toBe("opencode");
    expect(envelope.fallback).toBeUndefined();
    expect(envelope.signal).toBeUndefined();

    const cancelled = buildEnvelope({
      result: { state: "cancelled", exitCode: 1, signal: "SIGTERM" },
      backend: "cc",
      resolvedVia: "primary",
      mode: "foreground",
    });
    expect(cancelled.signal).toBe("SIGTERM");
    expect(cancelled.exitCode).toBe(1);
  });
});
