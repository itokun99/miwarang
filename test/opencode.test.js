import { describe, expect, test } from "bun:test";
import { createOpenCodeBackend, runOpenCodeCli } from "../src/backends/opencode.js";

function jsonResponse(value) {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}

function makeBackend(responses) {
  const calls = [];
  const backend = createOpenCodeBackend({
    command: "opencode",
    run: async (args) => {
      calls.push(args);
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected API call: ${args.join(" ")}`);
      return response;
    },
  });
  return { backend, calls };
}

const session = { data: { id: "ses_test123", title: "Delegated work" } };
// Live payload shape: `data` arrives newest-first, roles live in `type`, parts in
// `content`, and message order is tracked with `time.completed`.
const assistantMessages = {
  data: [
    { id: "msg_idle", type: "idle", time: { created: 4 } },
    {
      id: "msg_assistant_final",
      type: "assistant",
      time: { created: 3, streamed: 3, completed: 4 },
      content: [{ type: "text", text: "The project has three modules." }],
    },
    {
      id: "msg_assistant_opening",
      type: "assistant",
      time: { created: 1, streamed: 2, completed: 2 },
      content: [{ type: "text", text: "I'll start by reading the key files in parallel." }],
    },
    {
      id: "msg_user",
      type: "user",
      time: { created: 0 },
      content: [{ type: "text", text: "Inspect this project" }],
    },
  ],
};

describe("OpenCode v2 backend", () => {
  test("lists the authenticated local model catalog", async () => {
    const { backend, calls } = makeBackend([
      jsonResponse({
        data: [
          {
            providerID: "opencode",
            id: "space-bunny-free",
            cost: { input: 0, output: 0 },
          },
        ],
      }),
    ]);

    expect(await backend.listModels()).toEqual([
      {
        providerID: "opencode",
        id: "space-bunny-free",
        cost: { input: 0, output: 0 },
      },
    ]);
    expect(calls).toEqual([["api", "GET", "/api/model"]]);
  });

  test("starts background work and returns the OpenCode session ID", async () => {
    const { backend, calls } = makeBackend([
      jsonResponse(session),
      jsonResponse({ data: { id: "msg_user" } }),
    ]);

    await expect(
      backend.start({
        cwd: "/workspace",
        target: "agent:explore",
        model: "opencode/space-bunny-free",
        agent: "build",
        prompt: "Inspect this project",
      }),
    ).resolves.toEqual({ sessionId: "ses_test123", state: "running" });
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, 2)).toEqual(["api", "--data"]);
    expect(JSON.parse(calls[0][2])).toEqual({
      model: { providerID: "opencode", id: "space-bunny-free" },
      location: { directory: "/workspace" },
      title: "Miwarang: agent:explore",
      agent: "build",
    });
    expect(calls[0].slice(3)).toEqual(["POST", "/api/session"]);
    expect(calls[1]).toEqual([
      "api",
      "--data",
      JSON.stringify({ text: "Inspect this project" }),
      "POST",
      "/api/session/ses_test123/prompt",
    ]);
  });

  test("foreground execution waits and returns assistant text", async () => {
    const { backend, calls } = makeBackend([
      jsonResponse(session),
      jsonResponse({ data: { id: "msg_user" } }),
      { stdout: "", stderr: "", exitCode: 0 },
      jsonResponse(assistantMessages),
    ]);

    await expect(
      backend.runForeground({
        cwd: "/workspace",
        target: "category:quick",
        model: "opencode/space-bunny-free",
        prompt: "Inspect this project",
      }),
    ).resolves.toEqual({
      sessionId: "ses_test123",
      text: "The project has three modules.",
    });
    expect(calls[2]).toEqual([
      "api",
      "POST",
      "/api/experimental/session/ses_test123/wait",
    ]);
    expect(calls[3]).toEqual([
      "api",
      "GET",
      "/api/session/ses_test123/message",
    ]);
  });

  test("wait retrieves final assistant output for a session ID", async () => {
    const { backend, calls } = makeBackend([
      { stdout: "", stderr: "", exitCode: 0 },
      jsonResponse(assistantMessages),
    ]);

    await expect(backend.wait("ses_test123")).resolves.toEqual({
      sessionId: "ses_test123",
      text: "The project has three modules.",
    });
    expect(calls[0]).toEqual([
      "api",
      "POST",
      "/api/experimental/session/ses_test123/wait",
    ]);
    expect(calls[1]).toEqual([
      "api",
      "GET",
      "/api/session/ses_test123/message",
    ]);
  });

  test("wait skips assistant steps without text and returns the newest one with text", async () => {
    const { backend } = makeBackend([
      { stdout: "", stderr: "", exitCode: 0 },
      jsonResponse({
        data: [
          { id: "msg_idle", type: "idle", time: { created: 4 } },
          {
            id: "msg_assistant_tools",
            type: "assistant",
            time: { created: 3, completed: 4 },
            content: [{ type: "reasoning", text: "Checking the module graph." }],
          },
          {
            id: "msg_assistant_text",
            type: "assistant",
            time: { created: 1, streamed: 2, completed: 3 },
            content: [{ type: "text", text: "Intermediate report." }],
          },
        ],
      }),
    ]);

    await expect(backend.wait("ses_test123")).resolves.toEqual({
      sessionId: "ses_test123",
      text: "Intermediate report.",
    });
  });

  test("wait does not fail when older assistant steps carry no text", async () => {
    const { backend } = makeBackend([
      { stdout: "", stderr: "", exitCode: 0 },
      jsonResponse({
        data: [
          { id: "msg_idle", type: "idle", time: { created: 4 } },
          {
            id: "msg_assistant_final",
            type: "assistant",
            time: { created: 3, streamed: 3, completed: 4 },
            content: [{ type: "text", text: "Final report." }],
          },
          {
            id: "msg_assistant_tools",
            type: "assistant",
            time: { created: 1, completed: 2 },
            content: [{ type: "reasoning", text: "Checking the module graph." }],
          },
        ],
      }),
    ]);

    await expect(backend.wait("ses_test123")).resolves.toEqual({
      sessionId: "ses_test123",
      text: "Final report.",
    });
  });

  test("wait fails when no assistant step has text", async () => {
    const { backend } = makeBackend([
      { stdout: "", stderr: "", exitCode: 0 },
      jsonResponse({
        data: [
          { id: "msg_idle", type: "idle", time: { created: 2 } },
          {
            id: "msg_assistant_tools",
            type: "assistant",
            time: { created: 1, completed: 2 },
            content: [{ type: "reasoning", text: "Checking the module graph." }],
          },
        ],
      }),
    ]);

    await expect(backend.wait("ses_test123")).rejects.toThrow(
      "OpenCode session ses_test123 returned no assistant text",
    );
  });

  test("reports a timed-out CLI run as exit 124 and keeps stderr", async () => {
    const result = await runOpenCodeCli("sh", ["-c", "printf 'boom' >&2; exec sleep 5"], {
      timeoutMs: 50,
    });

    expect(result).toEqual({ stdout: "", stderr: "boom", exitCode: 124 });
  });

  test("keeps the real exit code and stderr of a failing CLI run", async () => {
    const result = await runOpenCodeCli("sh", ["-c", "printf 'nope' >&2; exit 7"]);

    expect(result).toEqual({ stdout: "", stderr: "nope", exitCode: 7 });
  });

  test("surfaces a timed-out backend request as exit 124", async () => {
    const backend = createOpenCodeBackend({
      run: () => runOpenCodeCli("sh", ["-c", "exec sleep 5"], { timeoutMs: 50 }),
    });

    await expect(backend.listModels()).rejects.toThrow(
      "OpenCode API GET /api/model failed (exit 124)",
    );
  });

  test("interrupts background work by OpenCode session ID", async () => {
    const { backend, calls } = makeBackend([
      jsonResponse({ interrupted: true }),
    ]);

    await expect(backend.cancel("ses_test123")).resolves.toEqual({
      sessionId: "ses_test123",
      interrupted: true,
    });
    expect(calls).toEqual([
      ["api", "POST", "/api/session/ses_test123/interrupt"],
    ]);
  });
});
