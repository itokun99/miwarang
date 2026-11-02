# PROJECT KNOWLEDGE BASE

**Generated:** 2026-11-02
**Commit:** d4dbd69
**Branch:** main

## OVERVIEW
Senpi (OMO harness) extension `miwarang-senpi-delegate`: registers `miwarang_delegate` / `miwarang_wait` / `miwarang_cancel` tools that route eligible OMO targets (`category:*`, `agent:*`) to a local OpenCode v2 service or any configured CLI agent, and blocks native `task` calls for those targets. Plain ESM JavaScript on Bun - no build step, no TypeScript, no lint script. One runtime dependency: `typebox` (Senpi tool schemas only).

## STRUCTURE
```
miwarang/
├── src/
│   ├── extension.js      # Senpi entry: 3 tool registrations + native-task blocking hook
│   ├── config.js         # JSON config load/validate + route and free-model resolution
│   ├── watch.js          # in-session background-run status
│   ├── backends/
│   │   ├── opencode.js   # opencode-v2 backend over `opencode api` (session lifecycle)
│   │   └── command.js    # generic executor backend: argv invocation, run store, sanitizing
│   └── runs/store.js     # opaque run_<uuid> metadata store (JSON files, 0600)
├── test/                 # six bun:test modules mirroring src
├── docs/releases/        # house-format release notes (also the gh release body)
├── config.example.json   # backend and OMO route examples
└── CONTRIBUTING.md       # backend-adding checklist; PR expectations
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add/change a delegated target | config.example.json + README "Multi-harness routing" | keys are `category:<name>` / `agent:<name>`; resolution: exact → `category:*`/`agent:*` wildcard → `defaultRoute` |
| Add a backend type | src/extension.js `createBackends` + src/backends/ adapter | follow the CONTRIBUTING "Adding a backend" checklist |
| Tool schemas / agent guidance text | `pi.registerTool` in src/extension.js | asserted by `test/extension.test.js` |
| Model selection and price policy | src/config.js `resolveRoute`, src/extension.js | catalog selection and route/backend policy rules |
| Route resolution + `resolvedVia` | src/config.js `resolveTargetRoute` | exact → `category:*`/`agent:*` wildcard → `defaultRoute`; delegate `details.resolvedVia` is `exact`/`wildcard`/`default` |
| Price policy | src/extension.js `effectivePricePolicy` | route `pricePolicy` ?? backend `pricePolicy` ?? `any`; command backends drop freeOnly when effective policy is `any` |
| Block policy (`blockNativeTask`) | src/extension.js `shouldBlockNativeTask` | per-route flag overrides top-level; default `configured` blocks exact/wildcard matches; `defaultRoute` never blocks; `"all"` requires wildcard/defaultRoute |
| Native `task` interception | `pi.on("tool_call")` in src/extension.js | blocks per `blockNativeTask` policy, not route presence alone |
| OpenCode API surface | src/backends/opencode.js | `POST /api/session`, `/prompt`, `/interrupt`, `GET /api/model`, `POST /api/experimental/session/<id>/wait`, `GET /api/session/<id>/message` |
| Background runs and cancellation | src/backends/command.js, src/runs/store.js, src/watch.js | lifecycle persistence, wait/cancel, and in-session status |
| Release notes | docs/releases/<version>.md | GH release body is the file verbatim |

## CODE MAP
Refs = literal identifier occurrences in JavaScript files under `src/` and `test/`.

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| miwarangExtension | function (default export) | `src/extension.js:20` | 1 | Senpi entry; reads `MIWARANG_CONFIG` or the default config path |
| setupExtension | function | `src/extension.js:27` | 4 | registers tools, command, and interception hook |
| loadConfig | function | `src/config.js:3` | 3 | reads and validates the JSON config |
| resolveTargetRoute | function | `src/config.js:65` | 29 | resolves exact, wildcard, and default target routes |
| resolveRoute | function | `src/config.js:9` | 20 | selects an ordered model candidate from the live catalog |
| createOpenCodeBackend | function | `src/backends/opencode.js:8` | 7 | OpenCode catalog and session lifecycle |
| runOpenCodeCli | function | `src/backends/opencode.js:161` | 6 | execFile wrapper; timeouts surface as exit 124 |
| createCommandBackend | function | `src/backends/command.js:80` | 9 | runs and tracks configured CLI processes |
| buildCommandInvocation | function | `src/backends/command.js:11` | 8 | expands argv placeholders and prompt transport |
| RunStore | class | `src/runs/store.js:8` | 20 | persists command-run lifecycle metadata |
| createRunTracker | function | `src/watch.js:14` | 7 | tracks this session's background runs |
| configuredCommandModels | function | `src/extension.js:451` | 12 | builds the fallback catalog for command backends |
| backendForRun | function | `src/extension.js:470` | 15 | selects the backend for wait/cancel IDs |
| messageText | function | `src/backends/opencode.js:150` | 3 | extracts text from OpenCode messages |

## CONVENTIONS
- Plain ESM JavaScript on Bun; no TypeScript, build script, or lint script. `typebox` is used at the Senpi tool-schema boundary.
- Targets resolve exact route, then namespace wildcard, then `defaultRoute`; results include `resolvedVia` (`exact`, `wildcard`, or `default`) and the selected model.
- Effective price policy is route-level, then backend-level, then `any`; `blockNativeTask` supports top-level and per-route policies.
- Tests use `bun:test`; the six test files follow the source modules.

## ANTI-PATTERNS (THIS PROJECT)
- Never commit API keys, tokens, local agent credentials, or generated run data.
- Never hard-code OpenCode credentials or provider-specific headers; use the authenticated `opencode api` CLI.
- Do not load the extension through both the global wrapper and `senpi -e`; tools would register twice.
- Do not push or release this public repository unless the user asks.

## UNIQUE STYLES
- Release flow: bump `package.json` version, write `docs/releases/<version>.md` (`## Fixed` / `## Included` + `## Verification` with concrete numbers), `chore(release): vX.Y.Z` commit, annotated tag, `gh release create --notes-file docs/releases/vX.Y.Z.md`.
- Conventional Commits with short subjects.
- Verification claims cite concrete counts and commands rather than adjectives.

## COMMANDS
```bash
bun install                                  # single dependency: typebox
bun test
senpi -e ./src/extension.js --list-models    # one-off; omit when the global wrapper is loaded
opencode api GET /api/model                  # live model catalog; freeOnly routes depend on it
```

## NOTES
- `MIWARANG_CONFIG` overrides the config path; default is `~/.config/miwarang/config.json`; a missing or invalid config fails extension load.
- Senpi caches the extension module at session start; use `/reload` after editing `src/`.
- `.omo/` contains local working state and is deliberately untracked; keep it out of release changes.
