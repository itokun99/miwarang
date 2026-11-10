import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKomaBackend } from "../src/backends/koma.js";
import { RunStore } from "../src/runs/store.js";

const HELLO = {
  type: "hello",
  protocol: 1,
  binary: { path: "/usr/local/bin/koma", version: "0.4.14" },
  diagnostics: [],
  capabilities: [
    "create",
    "resume",
    "state",
    "submit",
    "enqueue",
    "interrupt",
    "interrupt_and_submit",
    "approve",
    "configure",
    "detach",
  ],
};

// Shapes taken from the published protocol fixtures: the state frame carries the
// transcript, and tool-use steps commit empty assistant messages before the
// final answer.
function state(overrides) {
  return {
    session_id: "session-1",
    cwd: "/workspace",
    model_id: "koma/apple",
    policy: { plan: "forbid", approval: "reject" },
    turn: null,
    working: false,
    awaiting_approval: false,
    approval_reason: null,
    pending_count: 0,
    messages: [],
    streaming: null,
    revision: 1,
    external_approvals: false,
    pending_approval: null,
    gate: null,
    ...overrides,
  };
}

const TRANSCRIPT = [
  { role: "system", content: "You are koma" },
  { role: "user", content: "do the work" },
  { role: "assistant", content: "" },
  { role: "tool", content: "Wrote 13 bytes to /workspace/out.txt." },
  { role: "assistant", content: "DONE_KOMA" },
];

function fakeChild({ bootstrap = [HELLO], respond = () => [] } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.pid = 4242;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  const emit = (frame) =>
    queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify(frame)}\n`));
  child.stdin = {
    writable: true,
    write(chunk) {
      const request = JSON.parse(chunk);
      for (const frame of respond(request) ?? []) emit(frame);
      return true;
    },
    end() {},
  };
  for (const frame of bootstrap) emit(frame);
  return child;
}

// A scripted stand-in for `koma sdk serve`: it answers each request with the
// frames the real adapter would emit for it.
function scriptedAdapter({ finish = true, failure = null, messages = TRANSCRIPT } = {}) {
  const requests = [];
  const respond = (request) => {
    requests.push(request);
    if (request.method === "create") {
      return [{ type: "response", id: request.id, result: { state: state({}) } }];
    }
    if (request.method === "submit") {
      const frames = [
        {
          type: "response",
          id: request.id,
          result: { disposition: "started", turn_id: "turn-1", reason: null },
        },
        {
          type: "event",
          event: "state",
          seq: 1,
          state: state({ turn: { id: "turn-1", state: "running", error: null }, working: true }),
          resynced: false,
        },
      ];
      if (finish) {
        frames.push({
          type: "event",
          event: "state",
          seq: 2,
          state: state({
            turn: { id: "turn-1", state: failure ? "failed" : "finished", error: failure },
            working: false,
            messages,
            revision: 3,
          }),
          resynced: false,
        });
      }
      return frames;
    }
    if (request.method === "interrupt") {
      return [
        {
          type: "response",
          id: request.id,
          result: { disposition: "interrupted", turn_id: "turn-1", reason: null },
        },
      ];
    }
    if (request.method === "detach") {
      return [{ type: "response", id: request.id, result: { detached: true } }];
    }
    return [];
  };
  return { respond, requests };
}

async function makeBackend(childFactory, config = {}) {
  const runStore = new RunStore({ directory: await mkdtemp(join(tmpdir(), "miwarang-koma-")) });
  const backend = createKomaBackend(
    { command: "koma", args: ["sdk", "serve"], timeoutMs: 5000, ...config },
    { spawn: childFactory, runStore },
  );
  return { backend, runStore };
}

describe("koma sdk backend", () => {
  test("foreground execution creates a session with the routed model and returns the final answer", async () => {
    const adapter = scriptedAdapter();
    const { backend } = await makeBackend(() => fakeChild({ respond: adapter.respond }));

    await expect(
      backend.runForeground({ cwd: "/workspace", target: "category:quick", model: "koma/apple", prompt: "do the work" }),
    ).resolves.toEqual({ sessionId: "session-1", text: "DONE_KOMA" });

    expect(adapter.requests.find((r) => r.method === "create")).toEqual({
      id: expect.any(String),
      method: "create",
      params: { cwd: "/workspace", model_id: "koma/apple", policy: { plan: "forbid", approval: "reject" } },
    });
    expect(adapter.requests.find((r) => r.method === "submit").params).toEqual({ text: "do the work" });
    expect(adapter.requests.at(-1).method).toBe("detach");
  });

  test("foreground picks the newest assistant message that carries text", async () => {
    const messages = [
      { role: "user", content: "do the work" },
      { role: "assistant", content: "I will start by reading the files." },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Final report." },
    ];
    const adapter = scriptedAdapter({ messages });
    const { backend } = await makeBackend(() => fakeChild({ respond: adapter.respond }));

    const result = await backend.runForeground({ cwd: "/workspace", prompt: "do the work" });
    expect(result.text).toBe("Final report.");
  });

  test("foreground surfaces a failed turn and its error", async () => {
    const adapter = scriptedAdapter({ failure: "provider quota exhausted" });
    const { backend } = await makeBackend(() => fakeChild({ respond: adapter.respond }));

    await expect(
      backend.runForeground({ cwd: "/workspace", prompt: "do the work" }),
    ).rejects.toThrow("koma turn failed: provider quota exhausted");
  });

  test("foreground fails when the turn produced no assistant text", async () => {
    const adapter = scriptedAdapter({ messages: [{ role: "assistant", content: "   " }] });
    const { backend } = await makeBackend(() => fakeChild({ respond: adapter.respond }));

    await expect(
      backend.runForeground({ cwd: "/workspace", prompt: "do the work" }),
    ).rejects.toThrow("koma run returned no assistant text");
  });

  test("rejects an adapter that speaks a different protocol version", async () => {
    const adapter = scriptedAdapter();
    const { backend } = await makeBackend(() =>
      fakeChild({ bootstrap: [{ ...HELLO, protocol: 2 }], respond: adapter.respond }),
    );

    await expect(
      backend.runForeground({ cwd: "/workspace", prompt: "do the work" }),
    ).rejects.toThrow(/protocol 2/);
  });

  test("rejects an adapter missing a required capability", async () => {
    const adapter = scriptedAdapter();
    const { backend } = await makeBackend(() =>
      fakeChild({ bootstrap: [{ ...HELLO, capabilities: ["create", "detach"] }], respond: adapter.respond }),
    );

    await expect(
      backend.runForeground({ cwd: "/workspace", prompt: "do the work" }),
    ).rejects.toThrow(/missing required capabilities: submit/);
  });

  test("background start records a run and wait returns the assistant text", async () => {
    const adapter = scriptedAdapter();
    const { backend, runStore } = await makeBackend(() => fakeChild({ respond: adapter.respond }));

    const started = await backend.start({
      cwd: "/workspace",
      target: "category:quick",
      model: "koma/apple",
      prompt: "do the work",
    });
    expect(started).toEqual({ runId: expect.stringMatching(/^run_/), state: "running" });
    expect((await runStore.get(started.runId)).state).toBe("running");

    await expect(backend.wait(started.runId)).resolves.toEqual({
      runId: started.runId,
      state: "completed",
      text: "DONE_KOMA",
    });

    const record = await runStore.get(started.runId);
    expect(record.state).toBe("completed");
    expect(record.resultText).toBe("DONE_KOMA");
  });

  test("wait still returns the stored result after the session has been released", async () => {
    const adapter = scriptedAdapter();
    const { backend, runStore } = await makeBackend(() => fakeChild({ respond: adapter.respond }));

    const started = await backend.start({ cwd: "/workspace", prompt: "do the work" });
    await backend.wait(started.runId);

    expect((await runStore.get(started.runId)).resultText).toBe("DONE_KOMA");
    await expect(backend.wait(started.runId)).resolves.toMatchObject({ state: "completed" });
  });

  test("cancel interrupts the active turn and reports the cancellation", async () => {
    const adapter = scriptedAdapter({ finish: false });
    const { backend, runStore } = await makeBackend(() => fakeChild({ respond: adapter.respond }));

    const started = await backend.start({ cwd: "/workspace", prompt: "do the work" });
    await expect(backend.cancel(started.runId)).resolves.toEqual({
      runId: started.runId,
      state: "cancelled",
      cancelled: true,
    });
    expect(adapter.requests.find((r) => r.method === "interrupt").params).toEqual({
      turn_id: "turn-1",
    });
    expect(adapter.requests.at(-1).method).toBe("detach");

    expect((await runStore.get(started.runId)).state).toBe("cancelled");
    await expect(backend.wait(started.runId)).resolves.toMatchObject({ state: "cancelled" });
  });

  test("start fails when the configured executable cannot be spawned", async () => {
    const { backend, runStore } = await makeBackend(() => {
      const child = fakeChild({ bootstrap: [] });
      queueMicrotask(() =>
        child.emit("error", Object.assign(new Error("spawn koma ENOENT"), { code: "ENOENT" })),
      );
      return child;
    });

    await expect(
      backend.start({ cwd: "/workspace", prompt: "do the work" }),
    ).rejects.toThrow("spawn koma ENOENT");
  });

  test("wait rejects an unknown run ID", async () => {
    const { backend } = await makeBackend(() => fakeChild());
    await expect(backend.wait("run_00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      "No koma run found for ID",
    );
  });
});
