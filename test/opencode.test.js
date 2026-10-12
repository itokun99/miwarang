import { describe, expect, test } from "bun:test";
import { createOpenCodeBackend } from "../src/backends/opencode.js";

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
const assistantMessages = {
  data: [
    {
      id: "msg_user",
      type: "user",
      text: "Inspect this project",
    },
    {
      id: "msg_assistant",
      type: "assistant",
      content: [{ type: "text", text: "The project has three modules." }],
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
