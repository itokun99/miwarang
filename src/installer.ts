#!/usr/bin/env bun
// Miwarang installer.
//
//   npx miwarang init           # interactive
//   npx miwarang init --target senpi
//   npx miwarang init --target pi
//   npx miwarang init --target opencode [--global]
//   npx miwarang init --target claude-code [--global]
//   npx miwarang init --target mcp
//   npx miwarang uninstall --target <same>
//
// Every target wires the same delegation service: Senpi/OMO installs the
// extension, Pi installs its extension, OpenCode/Claude Code install the MCP
// or plugin artifacts.
import { copyFile, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export type TargetId = "senpi" | "pi" | "opencode" | "claude-code" | "mcp";

export interface InstallPaths {
  config: string;
}

export const TARGETS: Array<{ id: TargetId; label: string; hint: string }> = [
  { id: "senpi", label: "OMO / Senpi", hint: "install the Senpi extension" },
  { id: "pi", label: "Pi", hint: "install the Pi extension" },
  { id: "opencode", label: "OpenCode", hint: "install the OpenCode V2 plugin" },
  { id: "claude-code", label: "Claude Code", hint: "register the MCP server in .mcp.json" },
  { id: "mcp", label: "Other MCP host", hint: "print the MCP server snippet" },
];

const REPO_ROOT = resolve(import.meta.dir, "..");

function home(): string {
  return process.env.MIWARANG_HOME ?? homedir();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

async function copyTo(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  await copyFile(src, dest);
}

function serverEntry(): { command: string; args: string[] } {
  // Prefer the installed package layout; fall back to this checkout.
  const serverTs = join(REPO_ROOT, "src", "mcp-server.ts");
  return { command: "bun", args: [serverTs] };
}

async function installSenpi(): Promise<string[]> {
  const homeDir = home();
  const destDir = join(homeDir, ".omo", "agent", "extensions", "miwarang");
  const done: string[] = [];
  for (const rel of ["extension.ts", "config.ts", "delegate-routing.ts", "service.ts", "envelope.ts", "redact.ts", "stream.ts", "watch.ts", "run-tools.ts"]) {
    await copyTo(join(REPO_ROOT, "src", rel), join(destDir, rel));
    done.push(rel);
  }
  for (const rel of ["command.ts", "koma.ts", "types.ts"]) {
    await copyTo(join(REPO_ROOT, "src", "backends", rel), join(destDir, "backends", rel));
    done.push(`backends/${rel}`);
  }
  await copyTo(join(REPO_ROOT, "src", "runs", "store.ts"), join(destDir, "runs", "store.ts"));
  done.push("runs/store.ts");
  // Keep the legacy wrapper entrypoint working.
  await copyTo(join(REPO_ROOT, "src", "extension.js"), join(destDir, "extension.js"));
  done.push("extension.js");
  const configPath = join(homeDir, ".config", "miwarang", "config.json");
  if (!(await exists(configPath))) {
    await copyTo(join(REPO_ROOT, "config.example.json"), configPath);
    done.push("config.json (example, created because no config existed)");
  }
  return done;
}

async function installPi(): Promise<string[]> {
  const dest = join(home(), ".pi", "agent", "extensions", "miwarang.js");
  await copyTo(join(REPO_ROOT, "integrations", "pi-extension", "dist", "miwarang.js"), dest);
  return [dest];
}

async function installOpenCode(global: boolean): Promise<string[]> {
  const base = global ? join(home(), ".config", "opencode", "plugins") : join(process.cwd(), ".opencode", "plugins");
  const destDir = join(base, "miwarang");
  await copyTo(join(REPO_ROOT, "integrations", "opencode-plugin", "dist", "index.js"), join(destDir, "index.js"));
  return [join(destDir, "index.js")];
}

async function readJson(path: string): Promise<Record<string, any>> {
  if (!(await exists(path))) return {};
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

async function installClaudeCode(global: boolean): Promise<string[]> {
  const entry = serverEntry();
  const server = { command: entry.command, args: entry.args, env: { MIWARANG_CONFIG: "${MIWARANG_CONFIG}" } };
  const updated: string[] = [];
  const targets = global
    ? [join(home(), ".claude", "claude.json")]
    : [join(process.cwd(), ".mcp.json"), join(home(), ".claude", "claude.json")];
  for (const path of targets) {
    const json = await readJson(path);
    const container = path.endsWith(".mcp.json") ? json : (json.mcpServers ??= {});
    const key = path.endsWith(".mcp.json") ? "mcpServers" : null;
    const bucket = key ? (json[key] ??= {}) : container;
    bucket.miwarang = server;
    await ensureDir(path);
    await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
    updated.push(path);
  }
  return updated;
}

async function uninstall(target: TargetId, global: boolean): Promise<string[]> {
  const homeDir = home();
  const removed: string[] = [];
  const rm = async (path: string) => {
    if (await exists(path)) {
      const { unlink } = await import("node:fs/promises");
      await unlink(path);
      removed.push(path);
    }
  };
  if (target === "senpi") {
    await rm(join(homeDir, ".omo", "agent", "extensions", "miwarang", "extension.ts"));
    await rm(join(homeDir, ".omo", "agent", "extensions", "miwarang", "extension.js"));
  }
  if (target === "pi") {
    await rm(join(homeDir, ".pi", "agent", "extensions", "miwarang.js"));
  }
  if (target === "opencode") {
    const base = global ? join(homeDir, ".config", "opencode", "plugins") : join(process.cwd(), ".opencode", "plugins");
    await rm(join(base, "miwarang", "index.js"));
  }
  if (target === "claude-code") {
    const paths = global
      ? [join(homeDir, ".claude", "claude.json")]
      : [join(process.cwd(), ".mcp.json"), join(homeDir, ".claude", "claude.json")];
    for (const path of paths) {
      const json = await readJson(path);
      const bucket = (json.mcpServers ??= {});
      if (bucket?.miwarang) {
        delete bucket.miwarang;
        await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
        removed.push(path);
      }
    }
  }
  return removed;
}

function mcpSnippet(): string {
  const entry = serverEntry();
  return JSON.stringify(
    {
      mcpServers: {
        miwarang: { command: entry.command, args: entry.args },
      },
    },
    null,
    2,
  );
}

export async function runInstall(target: TargetId, options: { global?: boolean } = {}): Promise<string[]> {
  switch (target) {
    case "senpi":
      return installSenpi();
    case "pi":
      return installPi();
    case "opencode":
      return installOpenCode(options.global ?? false);
    case "claude-code":
      return installClaudeCode(options.global ?? false);
    case "mcp":
      return [mcpSnippet()];
  }
}

export { uninstall, mcpSnippet, exists as pathExists };

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const command = args[0] ?? "init";
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };

  if (command === "init" || command === "uninstall") {
    const requested = value("target") as TargetId | undefined;
    let target = requested;
    if (!target) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      console.log("Choose the Miwarang install target:");
      TARGETS.forEach((t, i) => console.log(`  ${i + 1}. ${t.label} — ${t.hint}`));
      const answer = (await rl.question("Target number [1-5]: ")).trim();
      rl.close();
      const picked = Number(answer);
      target = TARGETS[picked - 1]?.id;
      if (!target) {
        console.error("Unknown target.");
        process.exit(1);
      }
    }
    if (!TARGETS.some((t) => t.id === target)) {
      console.error(`Unknown target: ${target}`);
      process.exit(1);
    }
    if (command === "uninstall") {
      const removed = await uninstall(target, flag("global"));
      console.log(removed.length ? `Removed:\n- ${removed.join("\n- ")}` : "No matching Miwarang artifacts found.");
      return;
    }
    const written = await runInstall(target, { global: flag("global") });
    console.log(`Miwarang installed for target ${target}:`);
    for (const item of written) console.log(`- ${item}`);
    if (target === "senpi") console.log("Reload your Senpi/OMO session (/reload) so the extension picks up the config.");
    if (target === "opencode") console.log("Restart OpenCode so the plugin is loaded.");
    if (target === "claude-code") console.log("Run `claude mcp list` to confirm the server is registered, then restart Claude Code.");
    if (target === "mcp") console.log("Copy the snippet above into your host's MCP configuration.");
    return;
  }

  console.log(`Miwarang installer.

Usage:
  miwarang init [--target senpi|pi|opencode|claude-code|mcp] [--global]
  miwarang uninstall --target <same> [--global]
`);
}

if (import.meta.main) {
  await main(process.argv);
}
