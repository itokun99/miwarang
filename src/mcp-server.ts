#!/usr/bin/env bun
// Miwarang MCP stdio server: exposes miwarang_delegate, miwarang_wait, and
// miwarang_cancel over the Model Context Protocol so any MCP-speaking host
// (Claude Code, Cursor, OpenCode, ...) can reach the configured delegation
// chain without the Senpi extension host.
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createCommandBackend } from "./backends/command.ts";
import { createKomaBackend } from "./backends/koma.ts";
import { RunStore } from "./runs/store.ts";
import { createMiwarangService } from "./service.ts";
import { createRunTracker } from "./watch.ts";
import type { MiwarangConfig, BackendConfig } from "./config.ts";
import type { BackendAdapter } from "./delegate-routing.ts";

const OPENCODE_DEFAULTS = {
  command: "opencode",
  args: ["run", "--agent", "{{agent}}"],
  promptInput: "argument" as const,
};

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "miwarang", version: "0.9.2" };

function createBackends(config: MiwarangConfig, store: RunStore): Record<string, BackendAdapter> {
  const backends: Record<string, BackendAdapter> = {};
  for (const [id, backend] of Object.entries(config.backends)) {
    backends[id] = createBackend(id, backend, store);
  }
  return backends;
}

function createBackend(id: string, backend: BackendConfig, store: RunStore): BackendAdapter {
  if (backend.type === "opencode-cli") {
    return createCommandBackend({ ...OPENCODE_DEFAULTS, ...backend, id } as never, { runStore: store });
  }
  if (backend.type === "command") {
    return createCommandBackend({ ...backend, id } as never, { runStore: store });
  }
  if (backend.type === "koma-sdk") {
    return createKomaBackend({ ...backend, id }, { runStore: store });
  }
  throw new Error(`Unknown backend type ${backend.type} for ${id}`);
}

const TOOLS = [
  {
    name: "miwarang_delegate",
    description:
      "Delegate a task to the configured second-orchestrator harnesses (OpenCode CLI, Command Code, Koma) by prompt. Each harness owns its model and agent; Miwarang never selects a model.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Required. Complete delegated task, preserving the original constraints and acceptance criteria." },
        mode: { type: "string", enum: ["foreground", "background"], description: "Optional. Defaults to foreground. Use background only for asynchronous work." },
        backend: { type: "string", description: "Optional harness override. Omit to follow the configured delegation chain." },
        cwd: { type: "string", description: "Optional absolute project directory. Omit to inherit the server's working directory." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "miwarang_wait",
    description: "Wait for delegated background work and return its final result.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run ID returned by miwarang_delegate." },
        backend: { type: "string", description: "Optional backend override." },
      },
      required: ["runId"],
    },
  },
  {
    name: "miwarang_cancel",
    description: "Interrupt delegated background work by its returned ID.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run ID returned by miwarang_delegate." },
        backend: { type: "string", description: "Optional backend override." },
      },
      required: ["runId"],
    },
  },
] as const;

function toolResult(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: `${text}\n\n${JSON.stringify(details, null, 2)}` }],
  };
}

async function main() {
  const configPath = process.env.MIWARANG_CONFIG ?? join(homedir(), ".config/miwarang/config.json");
  const config = await loadConfig(configPath);
  const store = new RunStore({ directory: config.runsDirectory });
  const tracker = createRunTracker({
    readCommandState: async (id) => (await store.get(id))?.state as string | undefined,
  });
  const service = createMiwarangService({ config, backends: createBackends(config, store), tracker, store });

  interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;

  function reply(id: number | null, message: Record<string, unknown>) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...message })}\n`);
  }

  async function handleRequest(method: string, params: any): Promise<unknown> {
    if (method === "initialize") {
      return {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    }
    if (method === "tools/list") {
      return { tools: TOOLS };
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const ctx = { cwd: process.cwd() };
      if (name === "miwarang_delegate") {
        const { text, details } = await service.delegate(args, ctx);
        return toolResult(text, details);
      }
      if (name === "miwarang_wait") {
        const { text, details } = await service.wait(args, ctx);
        return toolResult(text, details);
      }
      if (name === "miwarang_cancel") {
        const { text, details } = await service.cancel(args, ctx);
        return toolResult(text, details);
      }
      throw new Error(`Unknown tool ${name}`);
    }
    throw new Error(`Method not supported: ${method}`);
  }

  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      const { id, method, params } = frame ?? {};
      if (method === "notifications/initialized" || method?.startsWith("notifications/")) continue;
      if (method === "ping") {
        if (id !== undefined) reply(id, { result: {} });
        continue;
      }
      const request = handleRequest(method, params);
      if (id === undefined || id === null) continue;
      const pendingEntry = { resolve: () => {}, reject: () => {} } as PendingRequest;
      pending.set(id, pendingEntry);
      request.then(
        (result) => {
          pending.delete(id);
          reply(id, { result });
        },
        (error: Error) => {
          pending.delete(id);
          reply(id, { error: { code: -32603, message: error.message } });
        },
      );
    }
  });
  process.stdin.resume();
}

main().catch((error) => {
  console.error(String((error as Error).stack ?? error));
  process.exit(1);
});
