import { describe, expect, test } from "bun:test";
import { runOpenCodeCli } from "../src/backends/opencode.js";

describe("OpenCode CLI process adapter", () => {
  test("reports a timed-out CLI run as exit 124 and keeps stderr", async () => {
    const result = await runOpenCodeCli("sh", ["-c", "printf 'boom' >&2; exec sleep 5"], {
      timeoutMs: 50,
    });

    expect(result).toEqual({ stdout: "", stderr: "boom", exitCode: 124 });
  });

  test("keeps the real exit code and stderr of a failing CLI run", async () => {
    const result = await runOpenCodeCli("sh", ["-c", "printf 'nope' >&2; exit 7"]);

    expect(result).toEqual({ stdout: "", stderr: "nope", exitCode: 7 });
  });
});
