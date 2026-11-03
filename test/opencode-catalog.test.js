import { describe, expect, test } from "bun:test";
import { createOpenCodeBackend, runOpenCodeCli } from "../src/backends/opencode.js";

function jsonResponse(value) {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}

function makeBackend(responses) {
  const calls = [];
  const backend = createOpenCodeBackend({
    run: async (args) => {
      calls.push(args);
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected API call: ${args.join(" ")}`);
      return response;
    },
  });
  return { backend, calls };
}

describe("OpenCode model catalog API", () => {
  test("lists the authenticated local model catalog", async () => {
    const catalog = [
      {
        providerID: "opencode",
        id: "space-bunny-free",
        cost: { input: 0, output: 0 },
      },
    ];
    const { backend, calls } = makeBackend([jsonResponse({ data: catalog })]);

    expect(await backend.listModels()).toEqual(catalog);
    expect(calls).toEqual([["api", "GET", "/api/model"]]);
  });

  test("retries once when the catalog is empty on the first call", async () => {
    const catalog = [
      { providerID: "opencode", id: "space-bunny-free", cost: { input: 0, output: 0 } },
    ];
    const { backend, calls } = makeBackend([
      jsonResponse({ data: [] }),
      jsonResponse({ data: catalog }),
    ]);

    expect(await backend.listModels()).toEqual(catalog);
    expect(calls).toEqual([
      ["api", "GET", "/api/model"],
      ["api", "GET", "/api/model"],
    ]);
  });

  test("returns an empty catalog after a second empty response", async () => {
    const { backend, calls } = makeBackend([jsonResponse({ data: [] }), jsonResponse({ data: [] })]);

    expect(await backend.listModels()).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  test("does not retry when the first catalog response is malformed", async () => {
    const { backend, calls } = makeBackend([jsonResponse({ data: "not-an-array" })]);

    await expect(backend.listModels()).rejects.toThrow(
      "OpenCode model catalog response has no data array",
    );
    expect(calls).toHaveLength(1);
  });

  test("propagates an error from the retry attempt", async () => {
    let attempts = 0;
    const backend = createOpenCodeBackend({
      run: async () => {
        attempts += 1;
        if (attempts === 1) return jsonResponse({ data: [] });
        throw new Error("OpenCode API GET /api/model failed (exit 124)");
      },
    });

    await expect(backend.listModels()).rejects.toThrow(
      "OpenCode API GET /api/model failed (exit 124)",
    );
    expect(attempts).toBe(2);
  });

  test("surfaces a timed-out catalog request as exit 124", async () => {
    const backend = createOpenCodeBackend({
      run: () => runOpenCodeCli("sh", ["-c", "exec sleep 5"], { timeoutMs: 50 }),
    });

    await expect(backend.listModels()).rejects.toThrow(
      "OpenCode API GET /api/model failed (exit 124)",
    );
  });
});
