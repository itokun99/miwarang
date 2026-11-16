import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = new URL("../src/mcp-server.ts", import.meta.url).pathname;

interface Frame {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

function startServer(configPath: string) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MIWARANG_CONFIG: configPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  const frames: Frame[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) frames.push(JSON.parse(line));
    }
  });
  const send = (frame: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  return { child, frames, send };
}

async function until(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for MCP frame");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeConfig() {
  const dir = await mkdtemp(join(tmpdir(), "miwarang-mcp-"));
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      backends: {
        echo: { type: "command", command: "echo", args: ["MCP_OK"], promptInput: "argument", timeoutMs: 5000 },
      },
      delegation: ["echo"],
    }),
  );
  return configPath;
}

describe("miwarang MCP stdio server", () => {
  test("answers initialize, tools/list, and a delegate call through the configured chain", async () => {
    const configPath = await makeConfig();
    const { child, frames, send } = startServer(configPath);

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await until(() => frames.some((f) => f.id === 1));
    expect(frames.find((f) => f.id === 1).result.serverInfo.name).toBe("miwarang");

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await until(() => frames.some((f) => f.id === 2));
    const names = frames.find((f) => f.id === 2).result.tools.map((tool: any) => tool.name);
    expect(names).toEqual(["miwarang_delegate", "miwarang_wait", "miwarang_cancel"]);

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "miwarang_delegate", arguments: { prompt: "Say hi", cwd: process.cwd() } },
    });
    await until(() => frames.some((f) => f.id === 3));
    const payload = frames.find((f) => f.id === 3).result;
    expect(payload.content[0].text).toContain("MCP_OK");
    expect(payload.content[0].text).toContain('"version": 1');

    child.kill("SIGTERM");
  }, 10000);

  test("reports tool errors as JSON-RPC errors", async () => {
    const configPath = await makeConfig();
    const { child, frames, send } = startServer(configPath);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await until(() => frames.some((f) => f.id === 1));
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "miwarang_wait", arguments: { runId: "" } } });
    await until(() => frames.some((f) => f.id === 2));
    expect(frames.find((f) => f.id === 2).error.message).toMatch(/sessionId or runId/);
    child.kill("SIGTERM");
  }, 10000);
});
