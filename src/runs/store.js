import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const RUN_ID_PATTERN = /^run_[0-9a-f-]{36}$/i;

export class RunStore {
  constructor({ directory = "~/.local/state/miwarang/runs" } = {}) {
    this.directory = expandHome(directory);
  }

  async create(values) {
    const id = `run_${randomUUID()}`;
    const record = { ...values, id };
    await this.write(record);
    return record;
  }

  async get(id) {
    const path = this.pathFor(id);
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async update(id, values) {
    const current = await this.get(id);
    if (!current) throw new Error(`No command run found for ID ${id}`);
    const record = { ...current, ...values, id };
    await this.write(record);
    return record;
  }

  async remove(id) {
    await rm(this.pathFor(id), { force: true });
  }

  pathFor(id) {
    if (!RUN_ID_PATTERN.test(id)) throw new Error("Invalid command run ID");
    return join(this.directory, `${id}.json`);
  }

  async write(record) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.pathFor(record.id), `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function expandHome(path) {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
