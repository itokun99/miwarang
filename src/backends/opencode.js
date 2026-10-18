import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export function createOpenCodeBackend({
  command = "opencode",
  run = (args, options) => runOpenCodeCli(command, args, options),
} = {}) {
  async function request(method, path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const args = ["api"];
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

  async function listModels() {
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

  async function start({ cwd, target, model, agent, prompt }) {
    const createBody = {
      model: modelReference(model),
      location: { directory: cwd },
      title: `Miwarang: ${target}`,
    };
    if (agent) createBody.agent = agent;

    const sessionResponse = await request("POST", "/api/session", createBody);
    const sessionId = sessionResponse?.data?.id ?? sessionResponse?.id;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("OpenCode session creation returned no session ID");
    }

    await request(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      { text: prompt },
    );

    return { sessionId, state: "running" };
  }

  async function wait(sessionId) {
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
    const isAssistant = (message) =>
      (message.info?.role ?? message.role ?? message.type) === "assistant";
    const completedAt = (message) => message.time?.completed ?? message.time?.created ?? 0;
    // Messages arrive newest-first; pick the newest assistant step that has text.
    const withText = [...messages]
      .filter(isAssistant)
      .sort((a, b) => completedAt(a) - completedAt(b))
      .reverse()
      .find((message) => messageText(message).length > 0);
    const text = withText ? messageText(withText) : "";
    if (!text) {
      throw new Error(`OpenCode session ${sessionId} returned no assistant text`);
    }
    return { sessionId, text };
  }

  async function runForeground(input) {
    const run = await start(input);
    return wait(run.sessionId);
  }

  async function cancel(sessionId) {
    const response = await request(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
    );
    return {
      sessionId,
      interrupted: response?.interrupted === true,
    };
  }

  return { listModels, start, wait, runForeground, cancel };
}

function modelReference(modelId) {
  const slash = modelId.indexOf("/");
  if (slash < 1 || slash === modelId.length - 1) {
    throw new Error(`Model must use provider/model format: ${modelId}`);
  }
  return {
    providerID: modelId.slice(0, slash),
    id: modelId.slice(slash + 1),
  };
}

function messageText(message) {
  if (!message) return "";
  const parts = message.parts ?? message.content ?? message.text ?? [];
  if (typeof parts === "string") return parts;
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export async function runOpenCodeCli(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const { stdout, stderr } = await execFile(command, args, {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: timeoutMs,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const timedOut = error.killed === true || error.signal != null;
    const code = Number.isInteger(error.code) ? error.code : timedOut ? 124 : 1;
    return {
      stdout: error.stdout ?? "",
      stderr:
        String(error.stderr ?? "") || (timedOut ? `killed by ${error.signal ?? "timeout"}` : ""),
      exitCode: code,
    };
  }
}
