# PROJECT KNOWLEDGE BASE

**Generated:** 2026-10-15
**Commit:** c408e42
**Branch:** main

## OVERVIEW
Senpi (OMO harness) extension `miwarang-senpi-delegate`: registers `miwarang_delegate` / `miwarang_wait` / `miwarang_cancel` tools that route eligible OMO targets (`category:*`, `agent:*`) to a local OpenCode v2 service or any configured CLI agent, and blocks native `task` calls for those targets. Plain ESM JavaScript on Bun - no build step, no TypeScript, no lint script. One runtime dependency: `typebox` (Senpi tool schemas only).

## STRUCTURE
```
miwarang/
├── src/
│   ├── extension.js      # Senpi entry: 3 tool registrations + native-task blocking hook
│   ├── config.js         # JSON config load/validate + route and free-model resolution
│   ├── backends/
│   │   ├── opencode.js   # opencode-v2 backend over `opencode api` (session lifecycle)
│   │   └── command.js    # generic executor backend: argv invocation, run store, sanitizing
│   └── runs/store.js     # opaque run_<uuid> metadata store (JSON files, 0600)
├── test/                 # bun:test; one file per src module, fakes injected via seams
├── docs/releases/        # house-format release notes (also the gh release body)
├── config.example.json   # canonical routes for the 5 delegated OMO targets
└── CONTRIBUTING.md       # backend-adding checklist; PR expectations
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add/change a delegated target | config.example.json + README "Multi-harness routing" | keys are `category:<name>` / `agent:<name>`; resolution: exact → `category:*`/`agent:*` wildcard → `defaultRoute` |
| Add a backend type | src/extension.js `createBackends` + src/backends/ adapter | follow the CONTRIBUTING "Adding a backend" checklist |
| Tool schemas / agent guidance text | src/extension.js `registerTool` blocks | asserted by test/extension.test.js |
| Model selection, free-only policy | src/config.js `resolveRoute` | freeOnly needs a live OpenCode catalog; fails loudly, never falls back to paid |
| Route resolution + `resolvedVia` | src/config.js `resolveTargetRoute` | exact → `category:*`/`agent:*` wildcard → `defaultRoute`; delegate `details.resolvedVia` is `exact`/`wildcard`/`default` |
| Price policy | src/extension.js `effectivePricePolicy` | route `pricePolicy` ?? backend `pricePolicy` ?? `any`; command backends drop freeOnly when effective policy is `any` |
| Block policy (`blockNativeTask`) | src/extension.js `shouldBlockNativeTask` | per-route flag overrides top-level; default `configured` blocks exact/wildcard matches; `defaultRoute` never blocks; `"all"` requires wildcard/defaultRoute |
| Native `task` interception | `pi.on("tool_call")` in src/extension.js | blocks per `blockNativeTask` policy, not route presence alone |
| OpenCode API surface | src/backends/opencode.js | `POST /api/session`, `/prompt`, `/interrupt`, `GET /api/model`, `POST /api/experimental/session/<id>/wait`, `GET /api/session/<id>/message` |
| Background runs and cancellation | src/backends/command.js, src/runs/store.js | `run_<uuid>` ids; cancel kills the process group on POSIX; `backendForRun` resolves via RunStore record |
| Release notes | docs/releases/<version>.md | GH release body is the file verbatim |

## CODE MAP
Refs = occurrences across src+test (`grep -o`).

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| miwarangExtension | function (default export) | src/extension.js:9 | 1 | Senpi entry; reads `MIWARANG_CONFIG` or the default config path |
| setupExtension | function | src/extension.js:16 | 4 | registers the 3 tools + blocking hook; `backends` injectable |
| loadConfig | function | src/config.js:3 | 3 | JSON read + hand-rolled `validateConfig` |
| resolveRoute | function | src/config.js:9 | 13 | highest fan-in: candidate ordering, freeOnly gate, overrides |
| createOpenCodeBackend | function | src/backends/opencode.js:8 | 6 | `listModels/start/wait/runForeground/cancel` over the CLI |
| runOpenCodeCli | function | src/backends/opencode.js:131 | 6 | execFile wrapper; timeouts surface as exit 124 |
| createCommandBackend | function | src/backends/command.js:53 | 3 | spawn backend; detached process group; RunStore records |
| buildCommandInvocation | function | src/backends/command.js:10 | 8 | argv construction + `{{model|agent|cwd|target}}` expansion |
| RunStore | class | src/runs/store.js:8 | 8 | create/get/update/remove; regex-guards ids against path traversal |
| messageText | function | src/backends/opencode.js:120 | 3 | extracts text parts from OpenCode message shapes |

## CONVENTIONS
- ESM only, `node:`-prefixed builtins, named imports; zero dynamic imports. Only the entry has a default export.
- Testability by constructor seams, not module mocks: `setupExtension(pi, { config, backends })`, `createCommandBackend(config, { spawn, runStore })`, `createOpenCodeBackend({ command, run })`.
- Errors: plain `throw new Error(...)` carrying ids/targets/exit codes in the message (41 sites in src); no error classes.
- Config validation is hand-rolled (`validateConfig`); typebox appears only at the Senpi tool boundary.
- Prompts travel as argv or stdin (`promptInput: argument|stdin`) and are never interpolated into a shell string.
- Captured output is sanitized: `sanitize()` redacts Bearer/`api_key|token|secret` patterns before persisting or reporting; capped at 1 MB with an `[output truncated]` marker.
- Run records: ids must match `^run_[0-9a-f-]{36}$` before any path use; directory mode 0700, files 0600; prompts and env are never persisted.
- Timeouts: 10-minute default; timed-out CLI runs report exit 124 (curl-style) with stderr kept.
- Tests mirror src one-to-one (`extension.test.js` ↔ `extension.js`, ...) and use fakes through the injection seams.
- Delegate results carry `resolvedVia` (`exact` | `wildcard` | `default`) and `model` in `details`; log them when debugging route selection.
- Effective price policy: route-level `pricePolicy` ?? backend-level `pricePolicy` ?? `any`. Command backends drop the freeOnly constraint when the effective policy is `any`; opencode-v2 keeps the catalog-backed gate.
- `blockNativeTask` is explicit: per-route flag overrides top-level; default `configured` blocks exact and wildcard matches only (never `defaultRoute`); `"all"` fails fast at load without a wildcard route or `defaultRoute`.

## ANTI-PATTERNS (THIS PROJECT)
- NEVER interpolate prompts into a shell command - executable plus argv array only (CONTRIBUTING).
- NEVER commit API keys, tokens, credentials, or generated run data (`~/.local/state/miwarang/runs`).
- NEVER hardcode OpenCode credentials or provider-specific headers - go through the authenticated `opencode api` CLI.
- Do not register the extension twice (global wrapper `~/.omo/agent/extensions/miwarang.js` plus `senpi -e` re-registers every tool).
- Do not assume message order from `GET /api/session/<id>/message` - it is newest-first (descending); `wait` must pick by `time.completed` and skip text-less steps.
- Do not resolve freeOnly routes against a stale or absent catalog - the catalog is fetched live at delegation time.

## UNIQUE STYLES
- Release flow: bump `package.json` version, write `docs/releases/<version>.md` (`## Fixed` / `## Included` + `## Verification` with concrete numbers), `chore(release): vX.Y.Z` commit, annotated tag, `gh release create --notes-file docs/releases/vX.Y.Z.md`.
- Conventional Commits with short subjects.
- Verification claims cite concrete counts (e.g. "29 passing tests", character counts of returned reports) rather than adjectives.

## COMMANDS
```bash
bun install                                  # single dependency: typebox
bun test                                     # 29 pass / 0 fail, 5 files (confirmed 2026-10-15)
senpi -e ./src/extension.js --list-models    # one-off extension load (omit if the wrapper is installed)
opencode api GET /api/model                  # live model catalog; freeOnly routes depend on it
```

## NOTES
- The harness caches the extension module at session start: editing src/ does not change the running `miwarang_*` tools until the user runs `/reload`; prove on-disk behavior with a Bun script that imports src directly.
- `MIWARANG_CONFIG` overrides the config path; default is `~/.config/miwarang/config.json`; a missing or invalid config fails extension load.
- When no free model is available, delegation fails with `No available free model is configured for <target>` (catalog size plus per-candidate availability included) - by design, not a retry hint.
- F-1 (wait/cancel mis-routed `run_` ids to the first command backend) is resolved: `backendForRun` resolves explicit param → RunStore record → legacy prefix heuristic, so wait/cancel work without a manual backend parameter.
- Public repo (github.com/itokun99/miwarang): do not push or release unless asked; `.omo/` is deliberately untracked.
