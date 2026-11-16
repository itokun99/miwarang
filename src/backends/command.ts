import { spawn as spawnProcess } from "node:child_process";
import { RunStore } from "../runs/store.ts";
import { redactSecrets } from "../redact.ts";
import { emitDelta } from "../stream.ts";

const MAX_CAPTURE_BYTES = 1024 * 1024;
// Bounded escalation after SIGTERM: if the process group ignores SIGTERM this
// long, SIGKILL ends it so cancel() can return a terminal state.
const CANCEL_GRACE_MS = 3000;
const CANCEL_ESCALATION_SIGNAL = "SIGKILL";

export interface CommandConfig {
  command: string;
  args: string[];
  promptInput?: string;
  timeoutMs?: number;
  id?: string;
  agent?: string;
  [key: string]: unknown;
}

export interface CommandRequest {
  prompt: string;
  agent?: string;
  cwd?: string;
  onUpdate?: (delta: string) => void;
}

export interface Invocation {
  command: string;
  args: string[];
  cwd?: string;
  input: string | undefined;
  timeoutMs?: number;
}

interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
}

export function buildCommandInvocation(config: CommandConfig, request: CommandRequest): Invocation {
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

  const values: Record<string, unknown> = {
    agent: request.agent ?? config.agent,
    cwd: request.cwd,
  };
  const args = config.args.map((arg) =>
    arg.replace(/\{\{(agent|cwd)\}\}/g, (_match: string, key: string) => {
      const value = values[key];
      if (typeof value !== "string") {
        throw new Error(`Command argument requires the ${key} value`);
      }
      return value;
    }),
  );

  if (promptInput === "argument") args.push(request.prompt);

  return {
    command: config.command,
    args,
    cwd: request.cwd,
    input: promptInput === "stdin" ? request.prompt : undefined,
    timeoutMs: config.timeoutMs,
  };
}

interface CommandDependencies {
  spawn?: typeof spawnProcess;
  runStore?: RunStore;
}

interface ActiveRun {
  child: ReturnType<typeof spawnProcess>;
  cancelRequested: boolean;
  completion: Promise<Record<string, unknown>>;
}

export function createCommandBackend(
  config: CommandConfig,
  dependencies: CommandDependencies = {},
) {
  const spawn = dependencies.spawn ?? spawnProcess;
  const runStore = dependencies.runStore ?? new RunStore();
  const active = new Map<string, ActiveRun>();

  async function runForeground(request: CommandRequest) {
    const invocation = buildCommandInvocation(config, request);
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const result = captureChild(child, invocation.input, request.onUpdate);
    const completed = await withTimeout(result, invocation.timeoutMs, () => child.kill("SIGTERM"));
    if (completed.exitCode !== 0) {
      throw new Error(commandFailure(completed));
    }
    return { text: redactSecrets(completed.stdout), exitCode: 0, signal: completed.signal };
  }

  async function start(request: CommandRequest) {
    const invocation = buildCommandInvocation(config, request);
    const record = await runStore.create({
      backend: config.id ?? "command",
      state: "starting",
      cwd: invocation.cwd,
      command: invocation.command,
      startedAt: new Date().toISOString(),
    });
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const completed = captureChild(child, invocation.input, request.onUpdate);
    const run = { child, cancelRequested: false } as ActiveRun;
    active.set(record.id, run);

    run.completion = completed
      .then(async (result) => {
        const state = run.cancelRequested
          ? "cancelled"
          : result.exitCode === 0
            ? "completed"
            : "failed";
        const updated = await runStore.update(record.id, {
          state,
          exitCode: result.exitCode,
          signal: result.signal,
          resultText: redactSecrets(result.stdout),
          errorText: redactSecrets(result.stderr),
          finishedAt: new Date().toISOString(),
        });
        active.delete(record.id);
        return updated as Record<string, any>;
      })
      .catch(async (error: NodeJS.ErrnoException) => {
        active.delete(record.id);
        await runStore.update(record.id, {
          state: "failed",
          errorText: redactSecrets(error.message),
          finishedAt: new Date().toISOString(),
        });
        throw error;
      });

    try {
      await waitForSpawn(child);
      await runStore.update(record.id, { state: "running", pid: child.pid });
      if (child.unref) child.unref();
      return { runId: record.id, state: "running" };
    } catch (error) {
      run.cancelRequested = true;
      await run.completion.catch(() => {});
      throw new Error(`Could not start configured command: ${redactSecrets((error as Error).message)}`);
    }
  }

  async function wait(runId: string) {
    const run = active.get(runId);
    if (run) {
      const record = await run.completion;
      return runResult(record as Record<string, any>);
    }
    const record = await runStore.get(runId);
    if (!record) throw new Error(`No command run found for ID ${runId}`);
    return runResult(record as Record<string, any>);
  }

  async function cancel(runId: string) {
    const run = active.get(runId);
    if (!run) {
      const record = await runStore.get(runId);
      if (!record) throw new Error(`No command run found for ID ${runId}`);
      return {
        runId,
        state: record.state as string,
        exitCode: typeof record.exitCode === "number" ? record.exitCode : undefined,
        signal: typeof record.signal === "string" ? record.signal : null,
        cancelled: false,
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
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    // Wait for a terminal child close, escalating to SIGKILL after the grace
    // window so the stored state and wait() reach terminal without polling.
    const closed = await Promise.race([
      run.completion.then(() => true).catch(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), CANCEL_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (!closed) {
      try {
        if (process.platform !== "win32" && run.child.pid) {
          process.kill(-run.child.pid, CANCEL_ESCALATION_SIGNAL);
        } else {
          run.child.kill(CANCEL_ESCALATION_SIGNAL);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await run.completion.catch(() => {});
    }
    const record = await runStore.get(runId);
    return {
      runId,
      state: (record?.state as string) ?? "cancelled",
      exitCode: typeof record?.exitCode === "number" ? record.exitCode : undefined,
      signal: typeof record?.signal === "string" ? record.signal : null,
      cancelled: true,
    };
  }

  return { runForeground, start, wait, cancel };
}

function captureChild(
  child: ReturnType<typeof spawnProcess>,
  input?: string | undefined,
  onUpdate?: (delta: string) => void,
) {
  return new Promise<CaptureResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
      if (onUpdate) emitDelta(onUpdate, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      resolve({
        stdout: stdout.trim(),
        stderr: redactSecrets(stderr.trim()),
        exitCode: Number.isInteger(code) ? (code as number) : signal ? 1 : 0,
        signal: signal ?? null,
      });
    });

    if (child.stdin) {
      child.stdin.end(input);
    }
  });
}

function appendCapped(current: string, chunk: string): string {
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  const bytes = Buffer.from(chunk, "utf8");
  if (bytes.length <= remaining) return current + bytes.toString("utf8");
  return `${current}${bytes.subarray(0, remaining).toString("utf8")}\n[output truncated]`;
}

function waitForSpawn(child: ReturnType<typeof spawnProcess>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error: NodeJS.ErrnoException) => reject(error));
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: unknown, onTimeout: () => void): Promise<T> {
  if (!Number.isFinite(timeoutMs as number) || (timeoutMs as number) <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Command exceeded timeout of ${timeoutMs} ms`));
    }, timeoutMs as number);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function commandFailure(result: CaptureResult): string {
  const detail = result.stderr ? `: ${result.stderr}` : "";
  return `Configured command failed with exit code ${result.exitCode}${detail}`;
}

function runResult(record: Record<string, any>) {
  return {
    runId: record.id,
    state: record.state,
    text: redactSecrets(record.resultText ?? ""),
    error: redactSecrets(record.errorText ?? ""),
    exitCode: record.exitCode,
    signal: record.signal ?? null,
  };
}

