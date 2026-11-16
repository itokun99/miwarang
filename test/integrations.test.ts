import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;

async function makeConfig(dir: string) {
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      backends: {
        echo: { type: "command", command: "echo", args: ["WRAP_OK"], promptInput: "argument", timeoutMs: 5000 },
      },
      delegation: ["echo"],
    }),
  );
  return configPath;
}

// A stub @opencode/plugin module so the plugin part can be imported without
// installing OpenCode in this repo: the integration is host-resolved at
// runtime, and the stub captures the registered tools for assertions.
async function loadOpencodePlugin(configPath: string) {
  const dir = await mkdtemp(join(tmpdir(), "miwarang-oc-"));
  await writeFile(join(dir, "plugin.ts"), "export const Plugin = { define: (def: unknown) => def };\n");
  const { build } = await import("bun");
  const out = join(dir, "plugin.js");
  await Bun.write(out, "export const Plugin = { define: (def) => def };\n");
  const stubDir = join(dir, "node_modules", "@opencode", "plugin");
  await Bun.write(join(stubDir, "package.json"), JSON.stringify({ name: "@opencode/plugin", type: "module", main: "index.js" }));
  await Bun.write(join(stubDir, "index.js"), "export const Plugin = { define: (def) => def };\n");
  const loaded = await import(`${stubDir}/index.js`);
  const mod = await import(join(REPO, "integrations/opencode-plugin/index.ts"));
  return { mod, loaded };
}

describe("host integrations (phase 3)", () => {
  test("OpenCode plugin registers three tools and gates delegate behind permission.assert", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miwarang-phase3-"));
    const configPath = await makeConfig(dir);
    process.env.MIWARANG_CONFIG = configPath;
    const assertCalls: any[] = [];
    const registered: any[] = [];
    const fakeCtx: any = {
      options: {},
      location: { directory: dir },
      permission: {
        assert: async (input: any) => {
          assertCalls.push(input);
          if (assertCalls.length === 1) {
            throw Object.assign(new Error("denied by rule"), { name: "ToolError" });
          }
        },
      },
      tool: {
        transform: async (cb: (editor: any) => void) => {
          const added: any[] = [];
          cb({
            add: (tool: any) => added.push(tool),
          });
          registered.push(...added);
        },
      },
    };
    // Import the plugin source with @opencode/plugin mapped to a stub through
    // Bun's module override.
    const stubPath = join(dir, "stub-opencode-plugin.ts");
    await Bun.write(stubPath, "export const Plugin = { define: (def: any) => def };\n");
    // Rewrite the plugin's relative imports to absolute repo paths so the copy
    // in the temp dir resolves the real service modules.
    const srcRoot = join(REPO, "src");
    const source = await Bun.file(join(REPO, "integrations/opencode-plugin/index.ts")).text();
    const patched = source
      .replaceAll("../../src/", srcRoot + "/")
      .replace('from "@opencode/plugin"', `from ${JSON.stringify(stubPath)}`);
    const pluginPath = join(dir, "miwarang-opencode-plugin.ts");
    await Bun.write(pluginPath, patched);
    const pluginModule = await import(pluginPath);
    const definition = pluginModule.default;
    expect(definition.id).toBe("miwarang");
    await definition.setup(fakeCtx);
    expect(registered.map((tool) => tool.name)).toEqual([
      "miwarang_delegate",
      "miwarang_wait",
      "miwarang_cancel",
    ]);
    const delegate = registered[0];
    await expect(
      delegate.execute({ prompt: "hi" }, { sessionID: "s1", agent: "build", messageID: "m1", id: "t1" }),
    ).rejects.toThrow("denied by rule");
    expect(assertCalls[0].action).toBe("miwarang_delegate");
    const allowed = await delegate.execute({ prompt: "hi", cwd: dir }, { sessionID: "s1", agent: "build", messageID: "m2", id: "t2" });
    expect(allowed.content).toContain("WRAP_OK");
    expect(allowed.content).toContain('"version": 1');
  }, 15000);

  test("Pi extension registers one miwarang tool handling delegate, wait, and cancel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miwarang-pi-"));
    const configPath = await makeConfig(dir);
    process.env.MIWARANG_CONFIG = configPath;
    const registered: any[] = [];
    const pi = { registerTool: (tool: any) => registered.push(tool) };
    const extension = await import(join(REPO, "integrations/pi-extension/miwarang.ts"));
    await extension.default(pi);
    expect(registered).toHaveLength(1);
    const tool = registered[0];
    expect(tool.name).toBe("miwarang");
    const started = await tool.execute("call1", { prompt: "hi", cwd: dir }, undefined, undefined, { session: { id: "pi_session" } });
    expect(started.content[0].text).toContain("WRAP_OK");
    expect(started.details.version).toBe(1);

    expect(started.details.mode).toBe("foreground");

    const waitResult = await tool.execute("call2", { prompt: "hi again", cwd: dir, mode: "background" }, undefined, undefined, { session: { id: "pi_session" } });
    const runId = waitResult.details.runId ?? waitResult.details.sessionId;
    expect(typeof runId).toBe("string");
    const cancelResult = await tool.execute("call3", { runId, action: "cancel" }, undefined, undefined, {});
    expect(["cancelled", "failed", "cancelling"]).toContain(cancelResult.details.state ?? cancelResult.details.state);
  }, 15000);

  test("OMP extension confirms exec-tier actions and can skip via env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miwarang-omp-"));
    const configPath = await makeConfig(dir);
    process.env.MIWARANG_CONFIG = configPath;
    process.env.MIWARANG_OMP_CONFIRM = "1";
    const registered: any[] = [];
    const confirms: string[] = [];
    const pi = { registerTool: (tool: any) => registered.push(tool) };
    const extension = await import(join(REPO, "integrations/omp-extension/miwarang.ts"));
    await extension.default(pi);
    const tool = registered[0];
    const rejected = await tool.execute("c1", { prompt: "hi", cwd: dir }, undefined, undefined, {
      ui: { confirm: async (title: string, message: string) => { confirms.push(`${title}:${message}`); return false; } },
    });
    expect(rejected.details.state).toBe("rejected");
    const approved = await tool.execute("c2", { prompt: "hi", cwd: dir }, undefined, undefined, {
      ui: { confirm: async () => true },
    });
    expect(approved.content[0].text).toContain("WRAP_OK");
    process.env.MIWARANG_OMP_CONFIRM = "0";
    const noConfirm = await tool.execute("c3", { prompt: "hi", cwd: dir }, undefined, undefined, { ui: undefined });
    expect(noConfirm.content[0].text).toContain("WRAP_OK");
  }, 15000);
});
