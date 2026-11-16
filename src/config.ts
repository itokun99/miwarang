import { readFile } from "node:fs/promises";

export const BACKEND_TYPES = ["opencode-cli", "command", "koma-sdk"] as const;

export type BackendType = (typeof BACKEND_TYPES)[number];

export interface BackendConfig {
  type: BackendType;
  command?: string;
  args?: string[];
  agent?: string;
  promptInput?: "stdin" | "argument";
  timeoutMs?: number;
  policy?: { plan: string; approval: string };
  [key: string]: unknown;
}

export interface MiwarangConfig {
  backends: Record<string, BackendConfig>;
  delegation: string[];
  runsDirectory?: string;
  [key: string]: unknown;
}

const REMOVED_KEYS: Array<[keyof MiwarangConfig & string, string]> = [
  ["routes", "delegate by prompt instead; the delegation chain order lives in `delegation`"],
  ["defaultRoute", "put the preferred backend first in `delegation`"],
  ["defaultModels", "each harness owns its model; configure the backend `agent` instead"],
  ["pricePolicy", "model selection is owned by each harness"],
  ["defaultBackend", "put the preferred backend first in `delegation`"],
  ["blockNativeTask", "Miwarang is a prompt-driven delegation tool; there are no targets to block"],
];

const LEGACY_BACKEND_TYPES: Record<string, string> = {
  "opencode-v2": "opencode-cli (OpenCode now runs through its CLI; the SDK backend was removed)",
};

export async function loadConfig(path: string): Promise<MiwarangConfig> {
  const config = JSON.parse(await readFile(path, "utf8")) as MiwarangConfig;
  validateConfig(config);
  return config;
}

export function validateConfig(config: MiwarangConfig): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Miwarang config must be a JSON object");
  }
  for (const [key, guidance] of REMOVED_KEYS) {
    if (config[key] !== undefined) {
      throw new Error(
        `Miwarang config key "${key}" was removed in v0.9.0: ${guidance}. ` +
          "See docs/releases/v0.9.0.md for the migration example.",
      );
    }
  }
  if (!config.backends || typeof config.backends !== "object" || Array.isArray(config.backends)) {
    throw new Error("Miwarang config must define a backends object");
  }
  const backendIds = Object.keys(config.backends);
  if (!backendIds.length) {
    throw new Error("Miwarang config must define at least one backend");
  }
  for (const [id, backend] of Object.entries(config.backends)) {
    validateBackend(id, backend);
  }
  if (
    !Array.isArray(config.delegation) ||
    config.delegation.length === 0 ||
    config.delegation.some((id) => typeof id !== "string")
  ) {
    throw new Error("Miwarang config must define a delegation array of backend ids");
  }
  const seen = new Set<string>();
  for (const id of config.delegation) {
    if (!config.backends[id]) {
      throw new Error(`Delegation chain references unknown backend ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`Delegation chain lists backend ${id} more than once`);
    }
    seen.add(id);
  }
}

function validateBackend(id: string, backend: BackendConfig): void {
  if (!backend || typeof backend !== "object" || Array.isArray(backend)) {
    throw new Error(`Backend ${id} must be an object`);
  }
  const legacy = LEGACY_BACKEND_TYPES[backend.type as string];
  if (legacy) {
    throw new Error(
      `Backend ${id} uses removed type "${backend.type}"; use ${legacy}.`,
    );
  }
  if (!BACKEND_TYPES.includes(backend.type as BackendType)) {
    throw new Error(
      `Backend ${id} has unknown type ${String(backend.type)}; expected one of ${BACKEND_TYPES.join(", ")}`,
    );
  }
  if (backend.agent !== undefined && typeof backend.agent !== "string") {
    throw new Error(`Backend ${id} agent must be a string`);
  }
  if (backend.type === "koma-sdk") return;
  if (typeof backend.command !== "string" || !backend.command) {
    throw new Error(`Backend ${id} must define a command`);
  }
  if (
    !Array.isArray(backend.args) ||
    backend.args.some((arg) => typeof arg !== "string")
  ) {
    throw new Error(`Backend ${id} args must be a string array`);
  }
  if (
    backend.promptInput !== undefined &&
    backend.promptInput !== "stdin" &&
    backend.promptInput !== "argument"
  ) {
    throw new Error(`Backend ${id} promptInput must be stdin or argument`);
  }
}
