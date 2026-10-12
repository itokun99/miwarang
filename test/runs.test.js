import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/runs/store.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "miwarang-runs-"));
  temporaryDirectories.push(directory);
  return new RunStore({ directory });
}

describe("RunStore", () => {
  test("persists and updates opaque background run IDs", async () => {
    const store = await createStore();
    const record = await store.create({
      backend: "agent-cli",
      state: "running",
      pid: 12345,
      cwd: "/workspace",
    });

    expect(record.id).toMatch(/^run_[0-9a-f-]+$/);
    expect(await store.get(record.id)).toMatchObject({
      id: record.id,
      backend: "agent-cli",
      state: "running",
      pid: 12345,
      cwd: "/workspace",
    });

    await store.update(record.id, {
      state: "completed",
      exitCode: 0,
      resultText: "done",
    });
    expect(await store.get(record.id)).toMatchObject({
      state: "completed",
      exitCode: 0,
      resultText: "done",
    });
  });

  test("rejects path traversal instead of reading outside its directory", async () => {
    const store = await createStore();
    await expect(store.get("../outside")).rejects.toThrow(/run ID/i);
  });
});
