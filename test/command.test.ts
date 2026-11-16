import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import {
  buildCommandInvocation,
  createCommandBackend,
} from "../src/backends/command.ts";

describe("Command Code agent tool configuration", () => {
  test("keeps the harness agent tools enabled for the headless backend", async () => {
    const config = JSON.parse(
      await readFile(new URL("../config.example.json", import.meta.url), "utf8"),
    );
    const args = config.backends.commandcode.args;
    const flag = args.indexOf("--tools-enable");

    expect(args[flag + 1]).toBe("agent,agent_output");
    expect(args).not.toContain("--model");
  });

  test("the example config delegates through a chain and owns agents per backend", async () => {
    const config = JSON.parse(
      await readFile(new URL("../config.example.json", import.meta.url), "utf8"),
    );
    expect(config.delegation).toEqual(["opencode", "commandcode", "koma"]);
    expect(config.backends.opencode.agent).toBeUndefined();
    expect(config.backends.opencode.args).toEqual(["run"]);
    expect(config.backends.commandcode.agent).toBe("General");
    expect(config.routes).toBeUndefined();
  });
});

describe("buildCommandInvocation", () => {
  test("expands the configured agent without selecting a model", () => {
    expect(
      buildCommandInvocation(
        {
          command: "agent-cli",
          args: ["--agent", "{{agent}}"],
          promptInput: "argument",
          timeoutMs: 120000,
        },
        {
          agent: "explore",
          prompt: "inspect $(touch /tmp/should-not-run)",
          cwd: "/workspace",
        },
      ),
    ).toEqual({
      command: "agent-cli",
      args: ["--agent", "explore", "inspect $(touch /tmp/should-not-run)"],
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
          args: ["--agent", "{{agent}}"],
          promptInput: "stdin",
        },
        {
          agent: "Orchestrator",
          prompt: "inspect this project",
          cwd: "/workspace",
        },
      ),
    ).toEqual({
      command: "agent-cli",
      args: ["--agent", "Orchestrator"],
      cwd: "/workspace",
      input: "inspect this project",
      timeoutMs: undefined,
    });
  });

  test("rejects unknown prompt transports", () => {
    expect(() =>
      buildCommandInvocation(
        { command: "agent-cli", args: [], promptInput: "shell" },
        { prompt: "work", cwd: "/workspace" },
      ),
    ).toThrow(/promptInput/i);
  });

  test("fails when an agent placeholder has no agent value", () => {
    expect(() =>
      buildCommandInvocation(
        { command: "agent-cli", args: ["--agent", "{{agent}}"] },
        { prompt: "work" },
      ),
    ).toThrow(/requires the agent value/);
  });

  test("rejects an empty prompt", () => {
    expect(() =>
      buildCommandInvocation(
        { command: "agent-cli", args: [], promptInput: "argument" },
        { prompt: "" },
      ),
    ).toThrow(/non-empty string/);
  });
});

function fakeChild({ stdout = "", stderr = "", exitCode = 0, error }: any = {}) {
  const child: any = new EventEmitter();
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
    child.emit("spawn");
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", exitCode, null);
  });
  return child;
}

describe("command backend lifecycle", () => {
  test("foreground execution returns trimmed stdout and fails closed on errors", async () => {
    const ok = createCommandBackend(
      { command: "agent-cli", args: [], promptInput: "stdin" },
      { runStore: {} as never, spawn: () => fakeChild({ stdout: "  result text\n" }) as never },
    );
    expect(await ok.runForeground({ prompt: "work" })).toEqual({ text: "result text", exitCode: 0, signal: null });

    const bad = createCommandBackend(
      { command: "agent-cli", args: [], promptInput: "stdin" },
      { runStore: {} as never, spawn: () => fakeChild({ exitCode: 2, stderr: "boom" }) as never },
    );
    await expect(bad.runForeground({ prompt: "work" })).rejects.toThrow(
      /exit code 2: boom/,
    );
  });

  test("background runs record their backend and wait returns the stored result", async () => {
    const updates: any[] = [];
    const store = {
      async create(record: any) {
        return { ...record, id: "run_new" };
      },
      async update(id: string, patch: any) {
        updates.push([id, patch]);
        return { id, ...patch };
      },
      async get(id: string) {
        return { id, state: "completed", resultText: "stored result", exitCode: 0 };
      },
    };
    const backend = createCommandBackend(
      { command: "agent-cli", args: [], promptInput: "stdin", id: "cc" },
      { runStore: store as never, spawn: () => fakeChild({ stdout: "ignored" }) as never },
    );
    const started = await backend.start({ prompt: "work" });
    expect(started).toMatchObject({ runId: "run_new", state: "running" });
    const result = await backend.wait("run_new");
    expect(result).toMatchObject({ runId: "run_new", text: "stored result" });
    expect(updates.some(([, patch]) => patch.state === "running")).toBe(true);
  });

  test("spawn failures surface as configuration errors", async () => {
    const backend = createCommandBackend(
      { command: "agent-cli", args: [], promptInput: "stdin" },
      {
        runStore: {
          async create(record: any) {
            return { ...record, id: "run_new" };
          },
          async update() {},
        } as never,
        spawn: () => fakeChild({ error: new Error("ENOENT") }) as never,
      },
    );
    await expect(backend.start({ prompt: "work" })).rejects.toThrow(
      /Could not start configured command/,
    );
  });

  test("stderr diagnostics are redacted before they reach the error message", async () => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = null;
    child.pid = 4242;
    child.kill = () => {};
    queueMicrotask(() => {
      child.emit("spawn");
      child.stderr.emit("data", "api_key=abc123 secret");
      child.emit("close", 1, null);
    });
    const backend = createCommandBackend(
      { command: "agent-cli", args: [], promptInput: "stdin" },
      { runStore: {} as never, spawn: () => child },
    );
    await expect(backend.runForeground({ prompt: "work" })).rejects.toThrow(
      /[redacted]/,
    );
  });
});
