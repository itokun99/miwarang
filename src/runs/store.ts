import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const RUN_ID_PATTERN = /^run_[0-9a-f-]{36}$/i;

export interface RunRecord {
  id: string;
  [key: string]: unknown;
}

export interface RunStoreOptions {
  directory?: string;
}

export class RunStore {
  readonly directory: string;

  constructor({ directory = "~/.local/state/miwarang/runs" }: RunStoreOptions = {}) {
    this.directory = expandHome(directory);
  }

  async create(values: Omit<RunRecord, "id">): Promise<RunRecord> {
    const id = `run_${randomUUID()}`;
    const record = { ...values, id };
    await this.write(record);
    return record;
  }

  async get(id: string): Promise<RunRecord | undefined> {
    const path = this.pathFor(id);
    try {
      return JSON.parse(await readFile(path, "utf8")) as RunRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async update(id: string, values: Partial<RunRecord>): Promise<RunRecord> {
    const current = await this.get(id);
    if (!current) throw new Error(`No command run found for ID ${id}`);
    const record = { ...current, ...values, id };
    await this.write(record);
    return record;
  }

  async remove(id: string): Promise<void> {
    await rm(this.pathFor(id), { force: true });
  }

  pathFor(id: string): string {
    if (!RUN_ID_PATTERN.test(id)) throw new Error("Invalid command run ID");
    return join(this.directory, `${id}.json`);
  }

  async write(record: RunRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.pathFor(record.id), `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
