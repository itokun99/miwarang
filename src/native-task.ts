import { resolveTargetRoute } from "./config.ts";
import type { MiwarangConfig } from "./config.ts";

interface ToolCallEvent {
  toolName: string;
  input?: unknown;
}

export interface BlockResult {
  block: boolean;
  reason: string;
}

export interface PiHost {
  on(event: string, handler: (e: ToolCallEvent) => BlockResult | undefined): void;
  registerTool(definition: unknown): void;
  cwd?: string;
  [key: string]: unknown;
}

export function registerNativeTaskHook(pi: PiHost, config: MiwarangConfig): void {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "task") return;
    const blocked = taskTargets(event.input).filter((target) =>
      shouldBlockNativeTask(config, target),
    );
    if (!blocked.length) return;

    const names = blocked.join(", ");
    return {
      block: true,
      reason:
        `OMO target ${names} is configured for Miwarang delegation. ` +
        "Call miwarang_delegate with the same full target and prompt; only target and prompt are required. " +
        "Omit backend, model, and agent for normal routing. Omit mode for foreground work; " +
        "use mode background only when run_in_background is true, then track the returned ID " +
        "with miwarang_wait or miwarang_cancel.",
    };
  });
}

function taskTargets(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as { tasks?: unknown };
  const tasks = Array.isArray(record.tasks) ? record.tasks : [input];
  return tasks.flatMap((task) => {
    if (!task || typeof task !== "object") return [];
    const t = task as { category?: unknown; subagent_type?: unknown };
    if (typeof t.category === "string") return [`category:${t.category}`];
    if (typeof t.subagent_type === "string") return [`agent:${t.subagent_type}`];
    return [];
  });
}

function shouldBlockNativeTask(config: MiwarangConfig, target: string): boolean {
  let resolved: ReturnType<typeof resolveTargetRoute>;
  try {
    resolved = resolveTargetRoute(config, target);
  } catch {
    return false;
  }
  if (resolved.key === "defaultRoute") return false;

  const flag = resolved.blockNativeTask ?? config.blockNativeTask ?? "configured";
  return blockNativeTaskCovers(flag as boolean | string | string[], target);
}

function blockNativeTaskCovers(flag: boolean | string | string[] | undefined, target: string): boolean {
  if (flag === false || flag === "none") return false;
  if (flag === true || flag === "all" || flag === "configured") return true;
  if (Array.isArray(flag)) {
    return flag.includes(target) || flag.includes(namespaceWildcard(target));
  }
  return false;
}

function namespaceWildcard(target: string): string {
  if (target.startsWith("category:")) return "category:*";
  if (target.startsWith("agent:")) return "agent:*";
  return target;
}
