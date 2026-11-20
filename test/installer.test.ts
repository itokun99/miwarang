import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { runInstall, uninstall, mcpSnippet } from "../src/installer.ts";

const REPO = new URL("..", import.meta.url).pathname;

describe("miwarang installer", () => {
  test("senpi target copies the extension into the OMO extensions dir", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "miwarang-senpi-"));
    const realHome = process.env.MIWARANG_HOME;
    process.env.MIWARANG_HOME = fakeHome;
    try {
      const written = await runInstall("senpi");
      const extDir = join(fakeHome, ".omo/agent/extensions/miwarang");
      expect(await readFile(join(extDir, "extension.ts"), "utf8")).toContain("registerTool");
      expect(await readFile(join(extDir, "extension.js"), "utf8")).toBeDefined();
      expect(written.some((p) => p.startsWith("config.json"))).toBe(true);
      const config = JSON.parse(await readFile(join(fakeHome, ".config/miwarang/config.json"), "utf8"));
      expect(config.delegation).toEqual(["opencode", "commandcode", "koma"]);
    } finally {
      process.env.MIWARANG_HOME = realHome;
    }
  }, 15000);

  test("pi target copies the bundled extension", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "miwarang-pi-"));
    const realHome = process.env.HOME;
    process.env.MIWARANG_HOME = fakeHome;
    try {
      const written = await runInstall("pi");
      expect(realpathSync(written[0])).toBe(realpathSync(join(fakeHome, ".pi/agent/extensions/miwarang.js")));
      const content = await readFile(written[0], "utf8");
      expect(content).toContain("registerTool");
    } finally {
      process.env.MIWARANG_HOME = realHome;
    }
  }, 15000);

  test("opencode target honors project vs global placement", async () => {
    const project = await mkdtemp(join(tmpdir(), "miwarang-oc-"));
    const realCwd = process.cwd();
    process.chdir(project);
    try {
      const local = await runInstall("opencode");
      expect(realpathSync(local[0])).toBe(realpathSync(join(project, ".opencode/plugins/miwarang/index.js")));
      const fakeHome = await mkdtemp(join(tmpdir(), "miwarang-ocg-"));
      const realHome = process.env.HOME;
      process.env.MIWARANG_HOME = fakeHome;
      try {
        const global = await runInstall("opencode", { global: true });
        expect(realpathSync(global[0])).toBe(realpathSync(join(fakeHome, ".config/opencode/plugins/miwarang/index.js")));
      } finally {
        process.env.MIWARANG_HOME = realHome;
      }
    } finally {
      process.chdir(realCwd);
    }
  }, 15000);

  test("claude-code writes mcpServers config and uninstall removes it", async () => {
    const project = await mkdtemp(join(tmpdir(), "miwarang-cc-"));
    const fakeHome = await mkdtemp(join(tmpdir(), "miwarang-cch-"));
    const realCwd = process.cwd();
    const realHome = process.env.HOME;
    process.chdir(project);
    process.env.MIWARANG_HOME = fakeHome;
    try {
      await runInstall("claude-code");
      const projectMcp = JSON.parse(await readFile(join(project, ".mcp.json"), "utf8"));
      expect(projectMcp.mcpServers.miwarang.command).toBe("bun");
      const homeConfig = JSON.parse(await readFile(join(fakeHome, ".claude/claude.json"), "utf8"));
      expect(homeConfig.mcpServers.miwarang.args[0]).toContain("mcp-server.ts");

      const removed = await uninstall("claude-code", false);
      expect(removed.map((p) => realpathSync(p))).toContain(realpathSync(join(project, ".mcp.json")));
      const after = JSON.parse(await readFile(join(project, ".mcp.json"), "utf8"));
      expect(after.mcpServers.miwarang).toBeUndefined();
    } finally {
      process.env.MIWARANG_HOME = realHome;
      process.chdir(realCwd);
    }
  }, 15000);

  test("mcp target prints a ready-to-paste snippet", async () => {
    const [snippet] = await runInstall("mcp");
    const parsed = JSON.parse(snippet);
    expect(parsed.mcpServers.miwarang.command).toBe("bun");
    expect(mcpSnippet()).toContain("miwarang");
  });

  test("npm bin launcher uses Node to run the Bun installer", async () => {
    const project = await mkdtemp(join(tmpdir(), "miwarang-bin-"));

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        "node",
        [join(REPO, "bin/miwarang.js"), "init", "--target", "mcp"],
        { cwd: project, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"mcpServers"');
    expect(result.stdout).toContain('"miwarang"');
    expect(result.stdout).toContain("src/mcp-server.ts");
    expect(result.stderr).toBe("");
  }, 15000);

  test("uninstall removes senpi extension artifacts", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "miwarang-un-"));
    const realHome = process.env.HOME;
    process.env.MIWARANG_HOME = fakeHome;
    try {
      await runInstall("senpi");
      const removed = await uninstall("senpi", false);
      expect(removed.some((p) => p.endsWith("extensions/miwarang/extension.ts"))).toBe(true);
      expect(removed.some((p) => p.endsWith("extensions/miwarang/extension.js"))).toBe(true);
    } finally {
      process.env.MIWARANG_HOME = realHome;
    }
  }, 15000);
});
