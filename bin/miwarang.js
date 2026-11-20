#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bun = process.env.MIWARANG_BUN ?? "bun";
const child = spawn(bun, [resolve(root, "src/installer.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`Miwarang CLI requires Bun 1.4 or newer: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code) => {
  process.exitCode = typeof code === "number" ? code : 1;
});
