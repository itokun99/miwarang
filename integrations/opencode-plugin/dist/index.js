// @bun
// integrations/opencode-plugin/index.ts
import { Plugin } from "@opencode/plugin";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";

// src/config.ts
import { readFile } from "fs/promises";
var BACKEND_TYPES = ["opencode-cli", "command", "koma-sdk"];
var REMOVED_KEYS = [
  ["routes", "delegate by prompt instead; the delegation chain order lives in `delegation`"],
  ["defaultRoute", "put the preferred backend first in `delegation`"],
  ["defaultModels", "each harness owns its model; configure the backend `agent` instead"],
  ["pricePolicy", "model selection is owned by each harness"],
  ["defaultBackend", "put the preferred backend first in `delegation`"],
  ["blockNativeTask", "Miwarang is a prompt-driven delegation tool; there are no targets to block"]
];
var LEGACY_BACKEND_TYPES = {
  "opencode-v2": "opencode-cli (OpenCode now runs through its CLI; the SDK backend was removed)"
};
async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, "utf8"));
  validateConfig(config);
  return config;
}
function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Miwarang config must be a JSON object");
  }
  for (const [key, guidance] of REMOVED_KEYS) {
    if (config[key] !== undefined) {
      throw new Error(`Miwarang config key "${key}" was removed in v0.9.0: ${guidance}. ` + "See docs/releases/v0.9.0.md for the migration example.");
    }
  }
  if (!config.backends || typeof config.backends !== "object" || Array.isArray(config.backends)) {
    throw new Error("Miwarang config must define a backends object");
  }
  const backendIds = Object.keys(config.backends);
  if (!backendIds.length) {
    throw new Error("Miwarang config must define at least one backend");
  }
  for (const [id, backend] of Object.entries(config.backends)) {
    validateBackend(id, backend);
  }
  if (!Array.isArray(config.delegation) || config.delegation.length === 0 || config.delegation.some((id) => typeof id !== "string")) {
    throw new Error("Miwarang config must define a delegation array of backend ids");
  }
  const seen = new Set;
  for (const id of config.delegation) {
    if (!config.backends[id]) {
      throw new Error(`Delegation chain references unknown backend ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`Delegation chain lists backend ${id} more than once`);
    }
    seen.add(id);
  }
}
function validateBackend(id, backend) {
  if (!backend || typeof backend !== "object" || Array.isArray(backend)) {
    throw new Error(`Backend ${id} must be an object`);
  }
  const legacy = LEGACY_BACKEND_TYPES[backend.type];
  if (legacy) {
    throw new Error(`Backend ${id} uses removed type "${backend.type}"; use ${legacy}.`);
  }
  if (!BACKEND_TYPES.includes(backend.type)) {
    throw new Error(`Backend ${id} has unknown type ${String(backend.type)}; expected one of ${BACKEND_TYPES.join(", ")}`);
  }
  if (backend.agent !== undefined && typeof backend.agent !== "string") {
    throw new Error(`Backend ${id} agent must be a string`);
  }
  if (backend.type === "koma-sdk")
    return;
  if (typeof backend.command !== "string" || !backend.command) {
    throw new Error(`Backend ${id} must define a command`);
  }
  if (!Array.isArray(backend.args) || backend.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Backend ${id} args must be a string array`);
  }
  if (backend.promptInput !== undefined && backend.promptInput !== "stdin" && backend.promptInput !== "argument") {
    throw new Error(`Backend ${id} promptInput must be stdin or argument`);
  }
}

// src/backends/command.ts
import { spawn as spawnProcess } from "child_process";

// src/runs/store.ts
import { randomUUID } from "crypto";
import { mkdir, readFile as readFile2, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
var RUN_ID_PATTERN = /^run_[0-9a-f-]{36}$/i;

class RunStore {
  directory;
  constructor({ directory = "~/.local/state/miwarang/runs" } = {}) {
    this.directory = expandHome(directory);
  }
  async create(values) {
    const id = `run_${randomUUID()}`;
    const record = { ...values, id };
    await this.write(record);
    return record;
  }
  async get(id) {
    const path = this.pathFor(id);
    try {
      return JSON.parse(await readFile2(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT")
        return;
      throw error;
    }
  }
  async update(id, values) {
    const current = await this.get(id);
    if (!current)
      throw new Error(`No command run found for ID ${id}`);
    const record = { ...current, ...values, id };
    await this.write(record);
    return record;
  }
  async remove(id) {
    await rm(this.pathFor(id), { force: true });
  }
  pathFor(id) {
    if (!RUN_ID_PATTERN.test(id))
      throw new Error("Invalid command run ID");
    return join(this.directory, `${id}.json`);
  }
  async write(record) {
    await mkdir(this.directory, { recursive: true, mode: 448 });
    await writeFile(this.pathFor(record.id), `${JSON.stringify(record)}
`, {
      encoding: "utf8",
      mode: 384
    });
  }
}
function expandHome(path) {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

// src/redact.ts
var SECRET_PATTERNS = [
  /(Bearer\s+)[^\s"'`]+/gi,
  /((?:api[-_]?key|token|secret)\s*[:=]\s*)[^\s"'`]+/gi
];
function redactSecrets(text) {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, "$1[redacted]"), String(text ?? ""));
}

// src/stream.ts
var MAX_PENDING_DELTAS = 32;
function emitDelta(onUpdate, chunk) {
  if (pending.length >= MAX_PENDING_DELTAS)
    return;
  pending.push([onUpdate, chunk]);
  if (draining)
    return;
  draining = true;
  queueMicrotask(drain);
}
var pending = [];
var draining = false;
function drain() {
  try {
    while (pending.length) {
      const [update, delta] = pending.shift();
      try {
        update(delta);
      } catch {}
    }
  } finally {
    draining = false;
  }
}

// src/backends/command.ts
var MAX_CAPTURE_BYTES = 1024 * 1024;
var CANCEL_GRACE_MS = 3000;
var CANCEL_ESCALATION_SIGNAL = "SIGKILL";
function buildCommandInvocation(config, request) {
  if (typeof config.command !== "string" || !config.command) {
    throw new Error("Command backend must define a command");
  }
  if (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string")) {
    throw new Error("Command backend args must be a string array");
  }
  if (typeof request.prompt !== "string" || !request.prompt) {
    throw new Error("Delegated task prompt must be a non-empty string");
  }
  const promptInput = config.promptInput ?? "stdin";
  if (promptInput !== "stdin" && promptInput !== "argument") {
    throw new Error("Command backend promptInput must be stdin or argument");
  }
  const values = {
    agent: request.agent ?? config.agent,
    cwd: request.cwd
  };
  const args = config.args.map((arg) => arg.replace(/\{\{(agent|cwd)\}\}/g, (_match, key) => {
    const value = values[key];
    if (typeof value !== "string") {
      throw new Error(`Command argument requires the ${key} value`);
    }
    return value;
  }));
  if (promptInput === "argument")
    args.push(request.prompt);
  return {
    command: config.command,
    args,
    cwd: request.cwd,
    input: promptInput === "stdin" ? request.prompt : undefined,
    timeoutMs: config.timeoutMs
  };
}
function createCommandBackend(config, dependencies = {}) {
  const spawn = dependencies.spawn ?? spawnProcess;
  const runStore = dependencies.runStore ?? new RunStore;
  const active = new Map;
  async function runForeground(request) {
    const invocation = buildCommandInvocation(config, request);
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const result = captureChild(child, invocation.input, request.onUpdate);
    const completed = await withTimeout(result, invocation.timeoutMs, () => child.kill("SIGTERM"));
    if (completed.exitCode !== 0) {
      throw new Error(commandFailure(completed));
    }
    return { text: redactSecrets(completed.stdout), exitCode: 0, signal: completed.signal };
  }
  async function start(request) {
    const invocation = buildCommandInvocation(config, request);
    const record = await runStore.create({
      backend: config.id ?? "command",
      state: "starting",
      cwd: invocation.cwd,
      command: invocation.command,
      startedAt: new Date().toISOString()
    });
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const completed = captureChild(child, invocation.input, request.onUpdate);
    const run = { child, cancelRequested: false };
    active.set(record.id, run);
    run.completion = completed.then(async (result) => {
      const state = run.cancelRequested ? "cancelled" : result.exitCode === 0 ? "completed" : "failed";
      const updated = await runStore.update(record.id, {
        state,
        exitCode: result.exitCode,
        signal: result.signal,
        resultText: redactSecrets(result.stdout),
        errorText: redactSecrets(result.stderr),
        finishedAt: new Date().toISOString()
      });
      active.delete(record.id);
      return updated;
    }).catch(async (error) => {
      active.delete(record.id);
      await runStore.update(record.id, {
        state: "failed",
        errorText: redactSecrets(error.message),
        finishedAt: new Date().toISOString()
      });
      throw error;
    });
    try {
      await waitForSpawn(child);
      await runStore.update(record.id, { state: "running", pid: child.pid });
      if (child.unref)
        child.unref();
      return { runId: record.id, state: "running" };
    } catch (error) {
      run.cancelRequested = true;
      await run.completion.catch(() => {});
      throw new Error(`Could not start configured command: ${redactSecrets(error.message)}`);
    }
  }
  async function wait(runId) {
    const run = active.get(runId);
    if (run) {
      const record = await run.completion;
      return runResult(record);
    }
    const record = await runStore.get(runId);
    if (!record)
      throw new Error(`No command run found for ID ${runId}`);
    return runResult(record);
  }
  async function cancel(runId) {
    const run = active.get(runId);
    if (!run) {
      const record = await runStore.get(runId);
      if (!record)
        throw new Error(`No command run found for ID ${runId}`);
      return {
        runId,
        state: record.state,
        exitCode: typeof record.exitCode === "number" ? record.exitCode : undefined,
        signal: typeof record.signal === "string" ? record.signal : null,
        cancelled: false
      };
    }
    run.cancelRequested = true;
    try {
      if (process.platform !== "win32" && run.child.pid) {
        process.kill(-run.child.pid, "SIGTERM");
      } else {
        run.child.kill("SIGTERM");
      }
    } catch (error) {
      if (error.code !== "ESRCH")
        throw error;
    }
    const closed = await Promise.race([
      run.completion.then(() => true).catch(() => true),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), CANCEL_GRACE_MS);
        timer.unref?.();
      })
    ]);
    if (!closed) {
      try {
        if (process.platform !== "win32" && run.child.pid) {
          process.kill(-run.child.pid, CANCEL_ESCALATION_SIGNAL);
        } else {
          run.child.kill(CANCEL_ESCALATION_SIGNAL);
        }
      } catch (error) {
        if (error.code !== "ESRCH")
          throw error;
      }
      await run.completion.catch(() => {});
    }
    const record = await runStore.get(runId);
    return {
      runId,
      state: record?.state ?? "cancelled",
      exitCode: typeof record?.exitCode === "number" ? record.exitCode : undefined,
      signal: typeof record?.signal === "string" ? record.signal : null,
      cancelled: true
    };
  }
  return { runForeground, start, wait, cancel };
}
function captureChild(child, input, onUpdate) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = appendCapped(stdout, chunk);
      if (onUpdate)
        emitDelta(onUpdate, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled)
        return;
      settled = true;
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled)
        return;
      settled = true;
      resolve({
        stdout: stdout.trim(),
        stderr: redactSecrets(stderr.trim()),
        exitCode: Number.isInteger(code) ? code : signal ? 1 : 0,
        signal: signal ?? null
      });
    });
    if (child.stdin) {
      child.stdin.end(input);
    }
  });
}
function appendCapped(current, chunk) {
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current, "utf8");
  if (remaining <= 0)
    return current;
  const bytes = Buffer.from(chunk, "utf8");
  if (bytes.length <= remaining)
    return current + bytes.toString("utf8");
  return `${current}${bytes.subarray(0, remaining).toString("utf8")}
[output truncated]`;
}
function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) => reject(error));
  });
}
function withTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Command exceeded timeout of ${timeoutMs} ms`));
    }, timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
function commandFailure(result) {
  const detail = result.stderr ? `: ${result.stderr}` : "";
  return `Configured command failed with exit code ${result.exitCode}${detail}`;
}
function runResult(record) {
  return {
    runId: record.id,
    state: record.state,
    text: redactSecrets(record.resultText ?? ""),
    error: redactSecrets(record.errorText ?? ""),
    exitCode: record.exitCode,
    signal: record.signal ?? null
  };
}

// src/backends/koma.ts
import { spawn as spawnProcess2 } from "child_process";
var DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
var HANDSHAKE_TIMEOUT_MS = 30 * 1000;
var DEFAULT_ARGS = ["sdk", "serve"];
var DEFAULT_POLICY = { plan: "forbid", approval: "reject" };
var PROTOCOL_VERSION = 1;
var REQUIRED_CAPABILITIES = ["create", "submit", "detach"];
var TERMINAL_TURN_STATES = new Set(["finished", "interrupted", "failed"]);
var MAX_STDERR_BYTES = 64 * 1024;
function createKomaBackend(config = {}, dependencies = {}) {
  const command = config.command ?? "koma";
  const args = Array.isArray(config.args) && config.args.length ? config.args : DEFAULT_ARGS;
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const policy = config.policy ?? DEFAULT_POLICY;
  const spawn = dependencies.spawn ?? spawnProcess2;
  const runStore = dependencies.runStore ?? new RunStore;
  const sessions = new Map;
  async function openSession({ cwd, prompt }) {
    const workdir = typeof cwd === "string" && cwd ? cwd : process.cwd();
    const child = spawn(command, args, {
      cwd: workdir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const connection = connect(child, { timeoutMs });
    try {
      assertHello(await connection.hello());
      const created = await connection.request("create", {
        cwd: workdir,
        policy
      });
      const submitted = await connection.request("submit", { text: prompt });
      if (submitted?.disposition !== "started") {
        throw new Error(`koma declined the prompt (disposition: ${submitted?.disposition ?? "none"})`);
      }
      return {
        child,
        connection,
        workdir,
        daemonSessionId: created?.state?.session_id,
        turnId: submitted.turn_id,
        closed: false,
        cancelled: false
      };
    } catch (error) {
      connection.dispose();
      throw error;
    }
  }
  function closeSession(session) {
    if (session.closed)
      return;
    session.closed = true;
    session.connection.detach();
    session.connection.dispose();
  }
  async function runForeground(request) {
    const session = await openSession(request);
    try {
      const state = await session.connection.waitForTurn();
      return { sessionId: session.daemonSessionId, text: redactSecrets(assistantText(state, "koma run")) };
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
      startedAt: new Date().toISOString()
    });
    let session;
    try {
      session = await openSession(request);
    } catch (error) {
      await runStore.update(record.id, {
        state: "failed",
        errorText: redact(error.message),
        finishedAt: new Date().toISOString()
      });
      throw error;
    }
    sessions.set(record.id, session);
    await runStore.update(record.id, {
      state: "running",
      pid: session.child.pid,
      sessionId: session.daemonSessionId
    });
    session.completion = (async () => {
      try {
        const state = await session.connection.waitForTurn();
        const text = assistantText(state, `koma run ${record.id}`);
        await runStore.update(record.id, {
          state: "completed",
          exitCode: 0,
          signal: null,
          resultText: text,
          finishedAt: new Date().toISOString()
        });
        return { state: "completed", text, exitCode: 0, signal: null };
      } catch (error) {
        const cancelled = session.cancelled;
        const state = cancelled ? "cancelled" : "failed";
        await runStore.update(record.id, {
          state,
          exitCode: 1,
          signal: cancelled ? "SIGTERM" : null,
          finishedAt: new Date().toISOString(),
          ...cancelled ? {} : { errorText: redact(error.message) }
        }).catch(() => {});
        return {
          state,
          text: "",
          exitCode: 1,
          signal: cancelled ? "SIGTERM" : null,
          ...cancelled ? {} : { error: redact(error.message) }
        };
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
      return { runId, ...result, signal: result.signal ?? null };
    }
    const record = await runStore.get(runId);
    if (!record)
      throw new Error(`No koma run found for ID ${runId}`);
    return {
      runId,
      state: record.state,
      text: record.resultText ?? "",
      error: record.errorText ?? "",
      exitCode: record.exitCode,
      signal: record.signal ?? null
    };
  }
  async function cancel(runId) {
    const session = sessions.get(runId);
    if (!session) {
      const record = await runStore.get(runId);
      if (!record)
        throw new Error(`No koma run found for ID ${runId}`);
      return { runId, state: record.state, cancelled: false };
    }
    session.cancelled = true;
    if (session.turnId) {
      await session.connection.request("interrupt", { turn_id: session.turnId }).catch(() => {
        return;
      });
    }
    await closeSession(session);
    await session.completion.catch(() => {
      return;
    });
    const record = await runStore.get(runId);
    return {
      runId,
      state: record?.state ?? "cancelled",
      exitCode: typeof record?.exitCode === "number" ? record.exitCode : undefined,
      signal: typeof record?.signal === "string" ? record.signal : "SIGTERM",
      cancelled: true
    };
  }
  return { start, wait, cancel, runForeground };
}
function assertHello(hello) {
  if (hello?.protocol !== PROTOCOL_VERSION) {
    throw new Error(`koma sdk speaks protocol ${hello?.protocol ?? "unknown"}; this backend needs ${PROTOCOL_VERSION}`);
  }
  const capabilities = Array.isArray(hello.capabilities) ? hello.capabilities : [];
  const missing = REQUIRED_CAPABILITIES.filter((name) => !capabilities.includes(name));
  if (missing.length) {
    throw new Error(`koma sdk is missing required capabilities: ${missing.join(", ")}`);
  }
}
function assistantText(state, label) {
  const turn = state?.turn;
  if (turn?.state === "failed") {
    throw new Error(`koma turn failed${turn.error ? `: ${turn.error}` : ""}`);
  }
  if (turn?.state === "interrupted")
    throw new Error("koma turn was interrupted");
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  const final = [...messages].reverse().find((message) => message?.role === "assistant" && typeof message.content === "string" && message.content.trim());
  const text = final?.content.trim() ?? (typeof state?.streaming === "string" ? state.streaming.trim() : "");
  if (!text)
    throw new Error(`${label} returned no assistant text`);
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
  const pending = new Map;
  function settle(target, outcome) {
    const waiters = target === "hello" ? helloWaiters.splice(0) : turnWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      outcome.error ? waiter.reject(outcome.error) : waiter.resolve(outcome.value);
    }
  }
  function failTransport(error) {
    if (closed)
      return;
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
      if (!waiter)
        return;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.error)
        waiter.reject(new Error(describeProtocolError(frame.error)));
      else
        waiter.resolve(frame.result);
      return;
    }
    if (frame?.type === "event" && frame.event === "state") {
      latest = frame.state;
      if (frame.state?.turn?.state === "running")
        sawRunningTurn = true;
      if (isTerminalState(latest))
        settle("turn", { value: latest });
    }
  }
  function isTerminalState(state) {
    if (!state)
      return false;
    if (state.turn && TERMINAL_TURN_STATES.has(state.turn.state))
      return true;
    return !state.turn && sawRunningTurn && state.working === false;
  }
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = appendCapped2(stderr, chunk, MAX_STDERR_BYTES);
  });
  child.stdout?.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf(`
`)) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line)
        continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      dispatch(frame);
    }
  });
  child.once("error", (error) => failTransport(new Error(String(error.message))));
  child.once("close", (code, signal) => failTransport(new Error(`koma sdk exited (${code ?? signal ?? "unknown"})${stderr ? `: ${tail(stderr)}` : ""}`)));
  function write(payload) {
    if (closed || !child.stdin?.writable)
      return false;
    try {
      child.stdin.write(`${JSON.stringify(payload)}
`);
      return true;
    } catch {
      return false;
    }
  }
  return {
    hello() {
      if (helloFrame)
        return Promise.resolve(helloFrame);
      if (closed)
        return Promise.reject(new Error("koma sdk connection is closed"));
      const budget = Math.min(timeoutMs, HANDSHAKE_TIMEOUT_MS);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`koma sdk handshake timed out after ${budget} ms`)), budget);
        timer.unref?.();
        helloWaiters.push({ resolve, reject, timer });
      });
    },
    request(method, params) {
      if (closed)
        return Promise.reject(new Error("koma sdk connection is closed"));
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
      if (isTerminalState(latest))
        return Promise.resolve(latest);
      if (closed)
        return Promise.reject(new Error("koma sdk connection is closed"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`koma turn timed out after ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
        turnWaiters.push({ resolve, reject, timer });
      });
    },
    write,
    detach() {
      if (closed)
        return;
      write({ id: `m${++nextId}`, method: "detach", params: {} });
    },
    dispose() {
      if (closed)
        return;
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
      } catch {}
    }
  };
}
function describeProtocolError(error) {
  const code = error?.code ? `${error.code}: ` : "";
  const delivery = error?.delivery ? ` (delivery: ${error.delivery})` : "";
  return `${code}${error?.message ?? "unknown error"}${delivery}`;
}
function appendCapped2(current, chunk, limit) {
  const remaining = limit - Buffer.byteLength(current, "utf8");
  if (remaining <= 0)
    return current;
  const bytes = Buffer.from(String(chunk), "utf8");
  if (bytes.length <= remaining)
    return current + bytes.toString("utf8");
  return `${current}${bytes.subarray(0, remaining).toString("utf8")}
[stderr truncated]`;
}
function tail(text) {
  const lines = text.trim().split(`
`);
  return lines.slice(-3).join(" | ");
}
function redact(text) {
  return redactSecrets(text);
}

// src/delegate-routing.ts
async function executeDelegate(config, backends, request) {
  const { prompt, backend: backendOverride, mode, cwd } = request;
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("Delegated task prompt must be a non-empty string");
  }
  const chain = backendOverride !== undefined ? [backendOverride] : config.delegation;
  if (backendOverride !== undefined && !config.backends?.[backendOverride]) {
    throw new Error(`Backend ${backendOverride} is not configured`);
  }
  if (!chain.length)
    throw new Error("No backends configured for delegation");
  let selected;
  let lastError;
  for (let index = 0;index < chain.length; index += 1) {
    const backendId = chain[index];
    const backend = config.backends[backendId];
    const adapter = backends[backendId];
    if (!backend || !adapter) {
      throw new Error(`Backend ${backendId} is not configured`);
    }
    selected = {
      backendId,
      backend,
      index,
      ...backend.agent !== undefined ? { agent: backend.agent } : {}
    };
    const backendRequest = {
      cwd,
      prompt,
      onUpdate: request.onUpdate,
      ...backend.agent !== undefined ? { agent: backend.agent } : {}
    };
    try {
      const result = mode === "background" ? await adapter.start(backendRequest) : await adapter.runForeground(backendRequest);
      return {
        result,
        selected,
        resolvedVia: backendOverride !== undefined ? "override" : index === 0 ? "primary" : "fallback",
        mode
      };
    } catch (error) {
      lastError = error;
      if (!isProviderFailure(backend, error))
        throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`All delegated backends failed${lastError ? `: ${String(lastError)}` : ""}`);
}
function isProviderFailure(backend, error) {
  const message = String(error?.message ?? error);
  if (backend.type === "opencode-cli") {
    return /OpenCode session \S+ (?:failed|returned no assistant text)/i.test(message) || /OpenCode API \S+ \S+ failed \(exit \d+\)/i.test(message) || /(?:quota|rate limit|usage limit|5-hour|weekly limit|credits exhausted|429)/i.test(message);
  }
  if (backend.type === "command") {
    return /(?:quota|rate limit|usage limit|5-hour|weekly limit|credits exhausted|429)/i.test(message);
  }
  return false;
}

// src/envelope.ts
var ENVELOPE_VERSION = 1;
function buildEnvelope({
  result,
  backend,
  agent,
  fallbackIndex,
  resolvedVia,
  mode,
  omoThreadId
}) {
  const state = result.state ?? (mode === "background" ? "running" : "completed");
  return {
    version: ENVELOPE_VERSION,
    state,
    backend,
    resolvedVia,
    mode,
    ...result.runId !== undefined ? { runId: result.runId } : {},
    ...result.sessionId !== undefined ? { sessionId: result.sessionId } : {},
    ...result.exitCode !== undefined ? { exitCode: result.exitCode } : {},
    ...result.signal ? { signal: result.signal } : {},
    ...agent !== undefined ? { agent } : {},
    ...fallbackIndex !== undefined && fallbackIndex > 0 ? { fallback: true, fallbackIndex } : {},
    ...omoThreadId !== undefined ? { omoThreadId } : {}
  };
}
// node_modules/typebox/build/system/hashing/hash.mjs
var ByteMarker;
(function(ByteMarker) {
  ByteMarker[ByteMarker["Array"] = 0] = "Array";
  ByteMarker[ByteMarker["BigInt"] = 1] = "BigInt";
  ByteMarker[ByteMarker["Boolean"] = 2] = "Boolean";
  ByteMarker[ByteMarker["Date"] = 3] = "Date";
  ByteMarker[ByteMarker["Constructor"] = 4] = "Constructor";
  ByteMarker[ByteMarker["Function"] = 5] = "Function";
  ByteMarker[ByteMarker["Null"] = 6] = "Null";
  ByteMarker[ByteMarker["Number"] = 7] = "Number";
  ByteMarker[ByteMarker["Object"] = 8] = "Object";
  ByteMarker[ByteMarker["RegExp"] = 9] = "RegExp";
  ByteMarker[ByteMarker["String"] = 10] = "String";
  ByteMarker[ByteMarker["Symbol"] = 11] = "Symbol";
  ByteMarker[ByteMarker["TypeArray"] = 12] = "TypeArray";
  ByteMarker[ByteMarker["Undefined"] = 13] = "Undefined";
})(ByteMarker || (ByteMarker = {}));
var Accumulator = BigInt("14695981039346656037");
var [Prime, Size] = [BigInt("1099511628211"), BigInt("18446744073709551616")];
var Bytes = Array.from({ length: 256 }).map((_, i) => BigInt(i));
var F64 = new Float64Array(1);
var F64In = new DataView(F64.buffer);
var F64Out = new Uint8Array(F64.buffer);
var encoder = new TextEncoder;
// node_modules/typebox/build/type/types/integer.mjs
var IntegerPattern = "-?(?:0|[1-9][0-9]*)";
// node_modules/typebox/build/type/types/number.mjs
var NumberPattern = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?";
// node_modules/typebox/build/type/types/string.mjs
var StringPattern = ".*";

// node_modules/typebox/build/type/types/record.mjs
var IntegerKey = `^${IntegerPattern}$`;
var NumberKey = `^${NumberPattern}$`;
var StringKey = `^${StringPattern}$`;
// node_modules/typebox/build/type/script/token/internal/char.mjs
function Range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, i) => String.fromCharCode(start + i));
}
var Alpha = [
  ...Range(97, 122),
  ...Range(65, 90)
];
var Zero = "0";
var NonZero = Range(49, 57);
var Digit = [Zero, ...NonZero];
var UnderScore = "_";
var DollarSign = "$";

// node_modules/typebox/build/type/script/token/unsigned_integer.mjs
var AllowedDigits = [...Digit, UnderScore];
// node_modules/typebox/build/type/script/token/ident.mjs
var Initial = [...Alpha, UnderScore, DollarSign];
var Remaining = [...Initial, ...Digit];
// node_modules/typebox/build/type/script/token/unsigned_number.mjs
var AllowedDigits2 = [...Digit, UnderScore];
// node_modules/typebox/build/type/engine/helpers/keys.mjs
var integerKeyPattern = new RegExp("^(?:0|[1-9][0-9]*)$");

// node_modules/typebox/build/type/engine/indexed/from_object.mjs
var NumericKeyPattern = new RegExp(IntegerKey);
// src/watch.ts
var TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}
function createRunTracker({
  readCommandState = async () => {
    return;
  }
} = {}) {
  const runs = new Map;
  return {
    track(run) {
      const tracked = { ...run, state: "running" };
      runs.set(run.id, tracked);
    },
    resolve(id, state) {
      const run = runs.get(id);
      if (run && state)
        run.state = state;
    },
    list() {
      return [...runs.values()];
    },
    async refresh() {
      for (const run of runs.values()) {
        if (run.backendType !== "command" || isTerminalState(run.state))
          continue;
        const state = await readCommandState(run.id);
        if (state)
          run.state = state;
      }
      return this.list();
    }
  };
}

// src/run-tools.ts
async function backendForRun(config, runId, requestedBackend, store) {
  if (requestedBackend) {
    if (!config.backends[requestedBackend]) {
      throw new Error(`Backend ${requestedBackend} is not configured`);
    }
    return requestedBackend;
  }
  if (runId.startsWith("run_")) {
    const record = store ? await store.get(runId).catch(() => {
      return;
    }) : undefined;
    if (record && typeof record.backend === "string" && config.backends[record.backend]) {
      return record.backend;
    }
  }
  const order = Array.isArray(config.delegation) ? config.delegation : Object.keys(config.backends);
  if (!runId) {
    throw new Error(`Cannot determine backend for run ID ${runId}`);
  }
  const candidate = order.find((id) => config.backends[id]);
  if (candidate)
    return candidate;
  throw new Error(`Cannot determine backend for run ID ${runId}`);
}

// src/service.ts
function serviceId(input) {
  const id = input.sessionId ?? input.runId;
  if (typeof id !== "string" || !id) {
    throw new Error("Provide a sessionId or runId returned by miwarang_delegate");
  }
  return id;
}
function createMiwarangService({
  config,
  backends,
  tracker,
  store,
  onRunTracked
}) {
  return {
    async delegate(input, ctx = {}) {
      const execution = await executeDelegate(config, backends, {
        prompt: input.prompt,
        mode: input.mode ?? "foreground",
        backend: input.backend,
        cwd: input.cwd ?? ctx.cwd ?? process.cwd(),
        onUpdate: input.onUpdate
      });
      const { result, selected, mode, resolvedVia } = execution;
      const envelope = buildEnvelope({
        result,
        backend: selected.backendId,
        agent: selected.agent,
        fallbackIndex: selected.index,
        resolvedVia,
        mode
      });
      if (mode === "background") {
        const id = result.sessionId ?? result.runId;
        const run = {
          id,
          backend: selected.backendId,
          backendType: selected.backend.type,
          startedAt: Date.now(),
          ...ctx.sessionId !== undefined ? { omoThreadId: ctx.sessionId } : {}
        };
        tracker.track(run);
        onRunTracked?.(run);
        return {
          text: `Started background delegation (${id}).`,
          details: {
            ...envelope,
            ...ctx.sessionId !== undefined ? { omoThreadId: ctx.sessionId } : {}
          }
        };
      }
      return { text: result.text ?? "", details: envelope };
    },
    async wait(input, ctx = {}) {
      const id = serviceId(input);
      const backendId = await backendForRun(config, id, input.backend, store);
      const backend = backends[backendId];
      if (!backend?.wait)
        throw new Error(`Backend ${backendId} does not support wait`);
      const result = await backend.wait(id);
      tracker.resolve(id, result.state ?? "completed");
      return {
        text: result.text || `Task state: ${result.state}.`,
        details: { ...result, backend: backendId, omoThreadId: ctx.sessionId }
      };
    },
    async cancel(input, ctx = {}) {
      const id = serviceId(input);
      const backendId = await backendForRun(config, id, input.backend, store);
      const backend = backends[backendId];
      if (!backend?.cancel)
        throw new Error(`Backend ${backendId} does not support cancel`);
      const result = await backend.cancel(id);
      tracker.resolve(id, result.state ?? "cancelled");
      return {
        text: `Cancellation state: ${result.state ?? result.interrupted}.`,
        details: { ...result, backend: backendId, omoThreadId: ctx.sessionId }
      };
    }
  };
}

// integrations/opencode-plugin/index.ts
var OPENCODE_DEFAULTS = {
  command: "opencode",
  args: ["run", "--agent", "{{agent}}"],
  promptInput: "argument"
};
function createBackends(config, store) {
  const backends = {};
  for (const [id, backend] of Object.entries(config.backends)) {
    if (backend.type === "opencode-cli") {
      backends[id] = createCommandBackend({ ...OPENCODE_DEFAULTS, ...backend, id }, { runStore: store });
    } else if (backend.type === "command") {
      backends[id] = createCommandBackend({ ...backend, id }, { runStore: store });
    } else if (backend.type === "koma-sdk") {
      backends[id] = createKomaBackend({ ...backend, id }, { runStore: store });
    }
  }
  return backends;
}
var INPUT_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Required. Complete delegated task, preserving the original constraints and acceptance criteria." },
    mode: { type: "string", enum: ["foreground", "background"], description: "Optional. Defaults to foreground. Use background only for async work." },
    backend: { type: "string", description: "Optional harness override. Omit to follow the configured delegation chain." },
    cwd: { type: "string", description: "Optional absolute project directory." }
  },
  required: ["prompt"],
  additionalProperties: false
};
var RUN_ID_SCHEMA = {
  type: "object",
  properties: {
    runId: { type: "string", description: "Run or session ID returned by miwarang_delegate." },
    backend: { type: "string", description: "Optional backend override." }
  },
  required: ["runId"],
  additionalProperties: false
};
var opencode_plugin_default = Plugin.define({
  id: "miwarang",
  async setup(ctx) {
    const configPath = ctx.options?.configPath ?? process.env.MIWARANG_CONFIG ?? join2(homedir2(), ".config/miwarang/config.json");
    const config = await loadConfig(configPath);
    const store = new RunStore({ directory: config.runsDirectory });
    const tracker = createRunTracker({
      readCommandState: async (id) => (await store.get(id))?.state
    });
    const service = createMiwarangService({
      config,
      backends: createBackends(config, store),
      tracker,
      store
    });
    const workdir = ctx.location?.directory ?? process.cwd();
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "miwarang_delegate",
        description: "Delegate a task to the configured second-orchestrator harnesses (OpenCode CLI, Command Code, Koma) by prompt. Each harness owns its model and agent; Miwarang never selects a model.",
        input: INPUT_SCHEMA,
        execute: async (input, context) => {
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "miwarang_delegate",
            resources: [input.backend ?? "chain"]
          });
          const { text, details } = await service.delegate({ prompt: input.prompt, mode: input.mode, backend: input.backend }, { cwd: input.cwd ?? workdir, sessionId: context.sessionID });
          return { content: `${text}

${JSON.stringify(details, null, 2)}` };
        }
      });
      editor.add({
        name: "miwarang_wait",
        description: "Wait for delegated background work and return its final result.",
        input: RUN_ID_SCHEMA,
        execute: async (input, context) => {
          const { text, details } = await service.wait(input, { sessionId: context.sessionID });
          return { content: `${text}

${JSON.stringify(details, null, 2)}` };
        }
      });
      editor.add({
        name: "miwarang_cancel",
        description: "Interrupt delegated background work by its returned ID.",
        input: RUN_ID_SCHEMA,
        execute: async (input, context) => {
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "miwarang_cancel",
            resources: [input.backend ?? "chain"]
          });
          const { text, details } = await service.cancel(input, { sessionId: context.sessionID });
          return { content: `${text}

${JSON.stringify(details, null, 2)}` };
        }
      });
    });
  }
});
export {
  opencode_plugin_default as default
};
