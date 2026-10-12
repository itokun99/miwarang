import { describe, expect, test } from "bun:test";
import { buildCommandInvocation } from "../src/backends/command.js";

describe("buildCommandInvocation", () => {
  test("expands configured arguments without building a shell command", () => {
    expect(
      buildCommandInvocation(
        {
          command: "agent-cli",
          args: ["--model", "{{model}}", "--agent", "{{agent}}"],
          promptInput: "argument",
          timeoutMs: 120000,
        },
        {
          model: "provider/model-a",
          agent: "explore",
          prompt: "inspect $(touch /tmp/should-not-run)",
          cwd: "/workspace",
        },
      ),
    ).toEqual({
      command: "agent-cli",
      args: [
        "--model",
        "provider/model-a",
        "--agent",
        "explore",
        "inspect $(touch /tmp/should-not-run)",
      ],
      cwd: "/workspace",
      input: undefined,
      timeoutMs: 120000,
    });
  });

  test("sends prompts through stdin when configured", () => {
    expect(
      buildCommandInvocation(
        {
          command: "agent-cli",
          args: ["--model", "{{model}}"],
          promptInput: "stdin",
        },
        {
          model: "provider/model-a",
          prompt: "inspect this project",
          cwd: "/workspace",
        },
      ),
    ).toEqual({
      command: "agent-cli",
      args: ["--model", "provider/model-a"],
      cwd: "/workspace",
      input: "inspect this project",
      timeoutMs: undefined,
    });
  });

  test("rejects unknown prompt transports", () => {
    expect(() =>
      buildCommandInvocation(
        { command: "agent-cli", args: [], promptInput: "shell" },
        { model: "provider/model-a", prompt: "work", cwd: "/workspace" },
      ),
    ).toThrow(/promptInput/i);
  });
});
