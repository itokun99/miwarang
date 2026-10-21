import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  buildCommandInvocation,
  createCommandBackend,
  parseCommandModelList,
} from "../src/backends/command.js";

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

// Trimmed from a real `commandcode --list-models` listing: section headings and
// footers have no description column, `:free`/`-free` ids are free, and some
// entries carry no provider prefix.
const LIST_OUTPUT = `Available models  ·  96 models

Open Source

deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)
minimax/minimax-m3.1-flash:free        FREE multimodal coding with tunable thinking depth
poolside/laguna-s-2.1-free             FREE open-weight agentic coding and long-horizon work

Anthropic

claude-sonnet-5-5                      best combo of speed & intelligence (recommended)

Docs:  https://commandcode.ai/docs/reference/cli/models

Pass the full id, or just the short name after the last "/":
cmd --model moonshotai/kimi-k2.5
`;

function fakeChild({ stdout = "", stderr = "", exitCode = 0, error } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = null;
  child.pid = 4242;
  child.kill = () => {};
  queueMicrotask(() => {
    if (error) {
      child.emit("error", error);
      return;
    }
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", exitCode, null);
  });
  return child;
}

describe("parseCommandModelList", () => {
  test("parses model lines into catalogue entries with free detection", () => {
    const models = parseCommandModelList(LIST_OUTPUT);

    expect(models.map((model) => (model.providerID ? `${model.providerID}/${model.id}` : model.id))).toEqual(
      [
        "deepseek/deepseek-v4-flash",
        "minimax/minimax-m3.1-flash:free",
        "poolside/laguna-s-2.1-free",
        "claude-sonnet-5-5",
      ],
    );
    expect(models[0].cost).toEqual({ input: 1, output: 1 });
    expect(models[1].cost).toEqual({ input: 0, output: 0 });
    expect(models[2].cost).toEqual({ input: 0, output: 0 });
    expect(models[3]).toEqual({
      providerID: "",
      id: "claude-sonnet-5-5",
      cost: { input: 1, output: 1 },
    });
  });

  test("skips headers, count lines, and footers", () => {
    const models = parseCommandModelList(LIST_OUTPUT);
    const ids = models.map((model) => model.id);

    expect(models).toHaveLength(4);
    expect(ids).not.toContain("Available");
    expect(ids).not.toContain("Open");
    expect(ids.some((id) => id.includes("Docs"))).toBe(false);
    expect(ids).not.toContain("cmd");
  });

  test("returns an empty list for non-listing output", () => {
    expect(parseCommandModelList("no models here")).toEqual([]);
    expect(parseCommandModelList(undefined)).toEqual([]);
  });
});

describe("command backend model list probe", () => {
  test("listModels runs the configured probe command and parses its output", async () => {
    const spawned = [];
    const backend = createCommandBackend(
      { command: "commandcode", args: [], listModelsArgv: ["--list-models"] },
      {
        runStore: {},
        spawn: (command, args) => {
          spawned.push([command, args]);
          return fakeChild({ stdout: LIST_OUTPUT });
        },
      },
    );

    const models = await backend.listModels();

    expect(spawned).toEqual([["commandcode", ["--list-models"]]]);
    expect(models).toHaveLength(4);
    expect(models[1].cost).toEqual({ input: 0, output: 0 });
  });

  test("listModels stays undefined when no probe is configured", async () => {
    let spawned = 0;
    const backend = createCommandBackend(
      { command: "commandcode", args: [] },
      {
        runStore: {},
        spawn: () => {
          spawned += 1;
          return fakeChild();
        },
      },
    );

    expect(await backend.listModels()).toBeUndefined();
    expect(spawned).toBe(0);
  });

  test("a failing probe falls back to undefined instead of throwing", async () => {
    const spawnFor = (child) =>
      createCommandBackend(
        { command: "commandcode", args: [], listModelsArgv: ["--list-models"] },
        { runStore: {}, spawn: () => child },
      );

    expect(await spawnFor(fakeChild({ exitCode: 3, stderr: "boom" })).listModels()).toBeUndefined();
    expect(await spawnFor(fakeChild({ error: new Error("ENOENT") })).listModels()).toBeUndefined();
    expect(await spawnFor(fakeChild({ stdout: "no models here" })).listModels()).toBeUndefined();
  });

  test("rejects a malformed listModelsArgv at creation", () => {
    expect(() =>
      createCommandBackend({ command: "cc", args: [], listModelsArgv: [] }),
    ).toThrow(/listModelsArgv/);
    expect(() =>
      createCommandBackend({ command: "cc", args: [], listModelsArgv: "--list-models" }),
    ).toThrow(/listModelsArgv/);
  });
});
