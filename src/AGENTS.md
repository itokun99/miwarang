# SOURCE MODULES

## OVERVIEW
Runtime composition, route/config validation, backend adapters, run storage, and per-session status; OpenCode uses its configured default model and orchestrator while Command Code uses route candidates.

## WHERE TO LOOK
| Concern | Location | Notes |
|---|---|---|
| Extension composition | `extension.js` | Builds the adapters and tracker, then registers the delegate tool. |
| Delegate routing and fallback | `delegate-routing.js` | OpenCode defaults; command candidate selection and cross-backend failover. |
| Native task interception | `native-task.js` | Exact/wildcard/default resolution and the native-task block policy. |
| Background lifecycle tools | `run-tools.js` | Wait/cancel dispatch and run-ID-to-backend resolution. |
| Config loading and route validation | `config.js` | Hand-rolled route, command model-list, and fallback validation. |
| OpenCode integration | `backends/opencode.js` | Authenticated `opencode api` session, wait, message, and interrupt operations. |
| Generic CLI integration | `backends/command.js` | Executable plus argv, output capture/sanitizing, background lifecycle, and model-list parsing. |
| Run metadata | `runs/store.js` | JSON records used by command runs and backend resolution. |
| In-session status | `watch.js` | Tracks runs started by this session and formats status/footer output. |

## CONVENTIONS
- Keep dependencies injectable at module boundaries: `setupExtension` accepts `config`, `backends`, `runStore`, and `timers`; backend constructors accept command/run or spawn/store seams.
- Keep target resolution separate from model selection: `resolveTargetRoute` selects a configured route and fallbacks; `resolveRoute` checks ordered candidates only for command backends.
- OpenCode session creation omits `model` and selects the `orchestrator` agent; the OpenCode harness supplies its configured default model.
- Command Code print mode uses its built-in `General` agent; pass `--tools-enable agent,agent_output` so it can delegate to registered harness agents.
- Command prompts use `promptInput: "argument" | "stdin"` and are carried as one argv value or stdin; command invocations return executable and argv separately.
- Run records hold lifecycle metadata, not prompts or environment variables. `RunStore` validates IDs and writes directories/files with modes `0700`/`0600`.
- `createRunTracker` refreshes command-run state from `RunStore`; OpenCode run state is updated when wait or cancel returns.
- OpenCode message results are newest-first; `wait` selects assistant text using completion timestamps and skips text-less steps.
- `createBackends` selects adapters by `backend.type`; unknown types fail during extension setup.
- Foreground provider/quota failures can advance through candidates and configured fallbacks; background retries stop after a run ID is returned.
- `backendForRun` resolves an explicit backend, then the stored run record, then the legacy ID-prefix heuristic.
- The 15-second status timer is injectable and runs only while command runs are active.
- `validateConfig` rejects nested fallback chains and invalid `blockNativeTask` coverage before tool registration.

## ANTI-PATTERNS
- Never interpolate a prompt into a shell command; invoke the configured executable with an argv array.
- Do not pass an OMO `agent:<name>` target as a harness agent override; they are separate namespaces.
- Do not add a free-only model filter to route selection.
- Do not persist prompts or environment variables in run records.
