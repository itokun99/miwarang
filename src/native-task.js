import { resolveTargetRoute } from "./config.js";

export function registerNativeTaskHook(pi, config) {
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

function taskTargets(input) {
  if (!input || typeof input !== "object") return [];
  const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
  return tasks.flatMap((task) => {
    if (typeof task.category === "string") return [`category:${task.category}`];
    if (typeof task.subagent_type === "string") return [`agent:${task.subagent_type}`];
    return [];
  });
}

function shouldBlockNativeTask(config, target) {
  let resolved;
  try {
    resolved = resolveTargetRoute(config, target);
  } catch {
    return false;
  }
  if (resolved.key === "defaultRoute") return false;

  const flag = resolved.blockNativeTask ?? config.blockNativeTask ?? "configured";
  return blockNativeTaskCovers(flag, target);
}

function blockNativeTaskCovers(flag, target) {
  if (flag === false || flag === "none") return false;
  if (flag === true || flag === "all" || flag === "configured") return true;
  if (Array.isArray(flag)) {
    return flag.includes(target) || flag.includes(namespaceWildcard(target));
  }
  return false;
}

function namespaceWildcard(target) {
  if (target.startsWith("category:")) return "category:*";
  if (target.startsWith("agent:")) return "agent:*";
  return target;
}
