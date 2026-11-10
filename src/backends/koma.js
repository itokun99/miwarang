import { spawn as spawnProcess } from "node:child_process";
import { RunStore } from "../runs/store.js";

// koma's headless one-shot (`koma run --prompt …`) prints only session
// metadata; the assistant reply never reaches its stdout, so koma cannot back a
// command backend. The reply is served by koma's public SDK stdio adapter
// (`koma sdk serve`) under the JSON Lines protocol documented in the koma
// repository at src-core-sdk/protocol/CONTRACT.md, which this adapter speaks.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 30 * 1000;
const DEFAULT_ARGS = ["sdk", "serve"];
const DEFAULT_POLICY = { plan: "forbid", approval: "reject" };
const PROTOCOL_VERSION = 1;
const REQUIRED_CAPABILITIES = ["create", "submit", "detach"];
const TERMINAL_TURN_STATES = new Set(["finished", "interrupted", "failed"]);
const MAX_STDERR_BYTES = 64 * 1024;
const SECRET_PATTERNS = [
  [/(Bearer\s+)[^\s"'`]+/gi, "$1[redacted]"],
  [/((?:api[-_]?key|token|secret)\s*[:=]\s*)[^\s"'`]+/gi, "$1[redacted]"],
];

export function createKomaBackend(config = {}, dependencies = {}) {
  const command = config.command ?? "koma";
  const args = Array.isArray(config.args) && config.args.length ? config.args : DEFAULT_ARGS;
  const timeoutMs =
    Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const policy = config.policy ?? DEFAULT_POLICY;
  const spawn = dependencies.spawn ?? spawnProcess;
  const runStore = dependencies.runStore ?? new RunStore();
  const sessions = new Map();

  async function openSession({ cwd, prompt, model }) {
    const workdir = typeof cwd === "string" && cwd ? cwd : process.cwd();
    const child = spawn(command, args, {
      cwd: workdir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const connection = connect(child, { timeoutMs });
    try {
      assertHello(await connection.hello());
      const created = await connection.request("create", {
        cwd: workdir,
        ...(typeof model === "string" && model ? { model_id: model } : {}),
        policy,
      });
      const submitted = await connection.request("submit", { text: prompt });
      if (submitted?.disposition !== "started") {
        throw new Error(
          `koma declined the prompt (disposition: ${submitted?.disposition ?? "none"})`,
        );
      }
      return {
        child,
        connection,
        workdir,
        daemonSessionId: created?.state?.session_id,
        turnId: submitted.turn_id,
        closed: false,
        cancelled: false,
      };
    } catch (error) {
      connection.dispose();
      throw error;
    }
  }

  // Releases the adapter: an explicit detach, then stdin EOF and SIGTERM. Never
  // throws, so teardown cannot mask the result it is cleaning up after.
  function closeSession(session) {
    if (session.closed) return;
    session.closed = true;
    session.connection.detach();
    session.connection.dispose();
  }

  async function runForeground(request) {
    const session = await openSession(request);
    try {
      const state = await session.connection.waitForTurn();
      return { sessionId: session.daemonSessionId, text: assistantText(state, "koma run") };
    } finally {
      await closeSession(session);
    }
  }

  async function start(request) {
    const record = await runStore.create({
      backend: config.id ?? "koma",
      state: "starting",
      cwd: request.cwd,
      command,
      startedAt: new Date().toISOString(),
    });
    let session;
    try {
      session = await openSession(request);
    } catch (error) {
      await runStore.update(record.id, {
        state: "failed",
        errorText: redact(error.message),
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }

    sessions.set(record.id, session);
    await runStore.update(record.id, {
      state: "running",
      pid: session.child.pid,
      sessionId: session.daemonSessionId,
    });

    session.completion = (async () => {
      try {
        const state = await session.connection.waitForTurn();
        const text = assistantText(state, `koma run ${record.id}`);
        await runStore.update(record.id, {
          state: "completed",
          exitCode: 0,
          resultText: text,
          finishedAt: new Date().toISOString(),
        });
        return { state: "completed", text };
      } catch (error) {
        const cancelled = session.cancelled;
        const state = cancelled ? "cancelled" : "failed";
        await runStore
          .update(record.id, {
            state,
            finishedAt: new Date().toISOString(),
            ...(cancelled ? {} : { errorText: redact(error.message) }),
          })
          .catch(() => {});
        return { state, text: "", ...(cancelled ? {} : { error: redact(error.message) }) };
      } finally {
        sessions.delete(record.id);
        await closeSession(session);
      }
    })();

    return { runId: record.id, state: "running" };
  }

  async function wait(runId) {
    const session = sessions.get(runId);
    if (session) {
      const result = await session.completion;
      return { runId, ...result };
    }
    const record = await runStore.get(runId);
    if (!record) throw new Error(`No koma run found for ID ${runId}`);
    return {
      runId,
      state: record.state,
      text: record.resultText ?? "",
      error: record.errorText ?? "",
    };
  }

  async function cancel(runId) {
    const session = sessions.get(runId);
    if (!session) {
      const record = await runStore.get(runId);
      if (!record) throw new Error(`No koma run found for ID ${runId}`);
      return { runId, state: record.state, cancelled: false };
    }

    session.cancelled = true;
    if (session.turnId) {
      // Best effort: a stale turn target is rejected by the adapter, which
      // must not stop the teardown that follows.
      await session.connection
        .request("interrupt", { turn_id: session.turnId })
        .catch(() => undefined);
    }
    await closeSession(session);
    // Settle the completion before returning: koma runs have no status poll, so
    // the recorded state and the session tracker must reach a terminal value here.
    await session.completion.catch(() => undefined);
    return { runId, state: "cancelled", cancelled: true };
  }

  return { start, wait, cancel, runForeground };
}

function assertHello(hello) {
  if (hello?.protocol !== PROTOCOL_VERSION) {
    throw new Error(
      `koma sdk speaks protocol ${hello?.protocol ?? "unknown"}; this backend needs ${PROTOCOL_VERSION}`,
    );
  }
  const capabilities = Array.isArray(hello.capabilities) ? hello.capabilities : [];
  const missing = REQUIRED_CAPABILITIES.filter((name) => !capabilities.includes(name));
  if (missing.length) {
    throw new Error(`koma sdk is missing required capabilities: ${missing.join(", ")}`);
  }
}

// The reply is the newest assistant message carrying text; tool-use steps
// commit empty or absent assistant messages before the final answer.
function assistantText(state, label) {
  const turn = state?.turn;
  if (turn?.state === "failed") {
    throw new Error(`koma turn failed${turn.error ? `: ${turn.error}` : ""}`);
  }
  if (turn?.state === "interrupted") throw new Error("koma turn was interrupted");

  const messages = Array.isArray(state?.messages) ? state.messages : [];
  const final = [...messages]
    .reverse()
    .find((message) => message?.role === "assistant" && typeof message.content === "string" && message.content.trim());
  const text = final?.content.trim() ?? (typeof state?.streaming === "string" ? state.streaming.trim() : "");
  if (!text) throw new Error(`${label} returned no assistant text`);
  return text;
}

function connect(child, { timeoutMs }) {
  let buffer = "";
  let stderr = "";
  let closed = false;
  let latest;
  let sawRunningTurn = false;
  let nextId = 0;
  let helloFrame;
  const helloWaiters = [];
  const turnWaiters = [];
  const pending = new Map();

  function settle(target, outcome) {
    const waiters = target === "hello" ? helloWaiters.splice(0) : turnWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      outcome.error ? waiter.reject(outcome.error) : waiter.resolve(outcome.value);
    }
  }

  function failTransport(error) {
    if (closed) return;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    settle("hello", { error });
    settle("turn", { error });
  }

  function dispatch(frame) {
    if (frame?.type === "hello") {
      helloFrame = frame;
      return settle("hello", { value: frame });
    }
    if (frame?.type === "response") {
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.error) waiter.reject(new Error(describeProtocolError(frame.error)));
      else waiter.resolve(frame.result);
      return;
    }
    if (frame?.type === "event" && frame.event === "state") {
      latest = frame.state;
      if (frame.state?.turn?.state === "running") sawRunningTurn = true;
      if (isTerminalState(latest)) settle("turn", { value: latest });
    }
  }

  // The daemon can clear the turn once the work is done; a turn that ran and
  // then vanished with a settled session is finished, not in flight.
  function isTerminalState(state) {
    if (!state) return false;
    if (state.turn && TERMINAL_TURN_STATES.has(state.turn.state)) return true;
    return !state.turn && sawRunningTurn && state.working === false;
  }

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = appendCapped(stderr, chunk, MAX_STDERR_BYTES);
  });
  child.stdout?.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      dispatch(frame);
    }
  });
  child.once("error", (error) => failTransport(error));
  child.once("close", (code, signal) =>
    failTransport(
      new Error(
        `koma sdk exited (${code ?? signal ?? "unknown"})${stderr ? `: ${tail(stderr)}` : ""}`,
      ),
    ),
  );

  function write(payload) {
    if (closed || !child.stdin?.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  return {
    hello() {
      if (helloFrame) return Promise.resolve(helloFrame);
      if (closed) return Promise.reject(new Error("koma sdk connection is closed"));
      const budget = Math.min(timeoutMs, HANDSHAKE_TIMEOUT_MS);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`koma sdk handshake timed out after ${budget} ms`)),
          budget,
        );
        timer.unref?.();
        helloWaiters.push({ resolve, reject, timer });
      });
    },

    request(method, params) {
      if (closed) return Promise.reject(new Error("koma sdk connection is closed"));
      const id = `m${++nextId}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`koma sdk ${method} timed out after ${timeoutMs} ms`));
          }
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        if (!write({ id, method, params })) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`koma sdk ${method} could not be sent`));
        }
      });
    },

    waitForTurn() {
      if (isTerminalState(latest)) return Promise.resolve(latest);
      if (closed) return Promise.reject(new Error("koma sdk connection is closed"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`koma turn timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
        timer.unref?.();
        turnWaiters.push({ resolve, reject, timer });
      });
    },

    write,

    detach() {
      if (closed) return;
      write({ id: `m${++nextId}`, method: "detach", params: {} });
    },

    dispose() {
      if (closed) return;
      closed = true;
      const released = new Error("koma sdk connection is closed");
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(released);
      }
      pending.clear();
      settle("hello", { error: released });
      settle("turn", { error: released });
      try {
        child.stdin?.end();
        child.kill("SIGTERM");
      } catch {
        // The adapter may already have exited.
      }
    },
  };
}

function describeProtocolError(error) {
  const code = error?.code ? `${error.code}: ` : "";
  const delivery = error?.delivery ? ` (delivery: ${error.delivery})` : "";
  return `${code}${error?.message ?? "unknown error"}${delivery}`;
}

function appendCapped(current, chunk, limit) {
  const remaining = limit - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  const bytes = Buffer.from(String(chunk), "utf8");
  if (bytes.length <= remaining) return current + bytes.toString("utf8");
  return `${current}${bytes.subarray(0, remaining).toString("utf8")}\n[stderr truncated]`;
}

function tail(text) {
  const lines = text.trim().split("\n");
  return lines.slice(-3).join(" | ");
}

function redact(text) {
  return SECRET_PATTERNS.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    String(text ?? ""),
  );
}
