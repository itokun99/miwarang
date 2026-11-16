import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CliRunOptions {
  timeoutMs?: number;
}

interface RunFn {
  (args: string[], options: { timeoutMs: number }): Promise<CliResult>;
}

export interface OpenCodeBackendOptions {
  command?: string;
  run?: RunFn;
}

interface ApiMessage {
  info?: { role?: string };
  role?: string;
  type?: string;
  time?: { completed?: number; created?: number };
  error?: unknown;
  parts?: unknown;
  content?: unknown;
  text?: unknown;
}

export function createOpenCodeBackend({
  command = "opencode",
  run = (args, options) => runOpenCodeCli(command, args, options),
}: OpenCodeBackendOptions = {}) {
  async function request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<any> {
    const args: string[] = ["api"];
    if (body !== undefined) args.push("--data", JSON.stringify(body));
    args.push(method, path);

    const response = await run(args, { timeoutMs });
    if (response.exitCode !== 0) {
      throw new Error(`OpenCode API ${method} ${path} failed (exit ${response.exitCode})`);
    }
    if (!response.stdout?.trim()) return undefined;

    try {
      return JSON.parse(response.stdout);
    } catch {
      throw new Error(`OpenCode API ${method} ${path} returned invalid JSON`);
    }
  }

  async function listModels(): Promise<any[]> {
    const payload = await request("GET", "/api/model");
    const data = payload?.data;
    if (!Array.isArray(data)) {
      throw new Error("OpenCode model catalog response has no data array");
    }
    if (data.length > 0) return data;

    // F-6 cold start: the catalog can briefly come back empty; retry once.
    const retryPayload = await request("GET", "/api/model");
    const retryData = retryPayload?.data;
    if (!Array.isArray(retryData)) {
      throw new Error("OpenCode model catalog response has no data array");
    }
    return retryData;
  }

  async function start({ cwd, target, prompt }: { cwd?: string; target: string; prompt: string }) {
    const createBody = {
      location: { directory: cwd },
      title: `Miwarang: ${target}`,
      agent: "orchestrator",
    };

    const sessionResponse = await request("POST", "/api/session", createBody);
    const sessionId = sessionResponse?.data?.id ?? sessionResponse?.id;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("OpenCode session creation returned no session ID");
    }

    await request("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      text: prompt,
    });

    return { sessionId, state: "running" };
  }

  async function wait(sessionId: string) {
    await request(
      "POST",
      `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`,
    );
    const response = await request(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/message`,
    );
    const messages = response?.data;
    if (!Array.isArray(messages)) {
      throw new Error(`OpenCode session ${sessionId} returned no messages`);
    }
    const isAssistant = (message: ApiMessage) =>
      (message.info?.role ?? message.role ?? message.type) === "assistant";
    const completedAt = (message: ApiMessage) => message.time?.completed ?? message.time?.created ?? 0;
    // Messages arrive newest-first; pick the newest assistant step that has text.
    const withText = [...(messages as ApiMessage[])]
      .filter(isAssistant)
      .sort((a, b) => completedAt(a) - completedAt(b))
      .reverse()
      .find((message) => messageText(message).length > 0);
    const text = withText ? messageText(withText) : "";
    if (!text) {
      const failed = [...(messages as ApiMessage[])]
        .filter(isAssistant)
        .sort((a, b) => completedAt(b) - completedAt(a))
        .find((message) => message.error);
      if (failed) {
        throw new Error(
          `OpenCode session ${sessionId} failed: ${describeProviderError(failed.error)}`,
        );
      }
      throw new Error(`OpenCode session ${sessionId} returned no assistant text`);
    }
    return { sessionId, text };
  }

  async function runForeground(input: { cwd?: string; target: string; prompt: string }) {
    const run = await start(input);
    return wait(run.sessionId);
  }

  async function cancel(sessionId: string) {
    const response = await request(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
    );
    return { sessionId, interrupted: response !== undefined };
  }

  return { listModels, start, wait, runForeground, cancel };
}

// Provider failures surface as an `error` object on the assistant step (for
// example provider.quota with status 402 and an empty reply). Keeping type,
// status, and message lets callers classify the failure instead of guessing
// from missing text; the delegate uses this shape to fail over to the next
// configured candidate.
function describeProviderError(error: any): string {
  const parts = [error?.type ?? "provider error"];
  if (error?.status !== undefined) parts.push(`(${error.status})`);
  if (error?.message) parts.push(String(error.message));
  return parts.join(" ");
}

function messageText(message: ApiMessage): string {
  if (!message) return "";
  const parts = message.parts ?? message.content ?? message.text ?? [];
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return (parts as { type?: string; text?: string }[])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export async function runOpenCodeCli(
  command: string,
  args: string[],
  { timeoutMs = DEFAULT_TIMEOUT_MS }: CliRunOptions = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFile(command, args, {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: timeoutMs,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string | null;
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const timedOut = err.killed === true || err.signal != null;
    const code = Number.isInteger(err.code) ? Number(err.code) : timedOut ? 124 : 1;
    return {
      stdout: err.stdout ?? "",
      stderr:
        String(err.stderr ?? "") || (timedOut ? `killed by ${err.signal ?? "timeout"}` : ""),
      exitCode: code,
    };
  }
}
