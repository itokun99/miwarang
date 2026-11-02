# SOURCE MODULES

## OVERVIEW
Runtime composition, route/config validation, backend adapters, run storage, and per-session status; this distinct domain earned a guidance file with score 9.

## WHERE TO LOOK
| Concern | Location | Notes |
|---|---|---|
| Senpi registration and request flow | `extension.js` | Registers delegate/wait/cancel tools, the `/miwarang` command, and native-task interception. |
| Config loading and route validation | `config.js` | Hand-rolled shape checks, model availability, price policies, and fallback validation. |
| OpenCode integration | `backends/opencode.js` | Authenticated `opencode api` calls for catalog, session, wait, message, and interrupt operations. |
| Generic CLI integration | `backends/command.js` | Executable plus argv, output capture/sanitizing, background lifecycle, and model-list parsing. |
| Run metadata | `runs/store.js` | JSON records used by command runs and backend resolution. |
| In-session status | `watch.js` | Tracks runs started by this session and formats status/footer output. |

## CONVENTIONS
- Keep dependencies injectable at module boundaries: `setupExtension` accepts `config`, `backends`, `runStore`, and `timers`; backend constructors accept command/run or spawn/store seams.
- Keep target resolution separate from model selection: `resolveTargetRoute` selects a configured route and fallbacks; `resolveRoute` checks ordered model candidates against the selected backend's catalog.
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
- Never resolve `freeOnly` against a stale or absent model catalog, and never silently substitute a paid model.
- Do not persist prompts or environment variables in run records.
