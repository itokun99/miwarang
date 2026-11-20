# Installation and host adapters

The Miwarang tool and the `miwarang` Agent Skill are in one repository.

## Install the skill

Use the GitHub repository as the skills CLI source:

```sh
npx skills add itokun99/miwarang --skill miwarang
```

To list the skills before installing:

```sh
npx skills add itokun99/miwarang --list
```

The npm package also contains `skills/miwarang/SKILL.md`. When installed as
an npm dependency, `skills experimental_sync` can discover that path; npm
skill sync is experimental.

## Install the tool

After the npm package is published:

```sh
npx miwarang init
```

The interactive installer configures the matching host adapter. From a
source checkout, use:

```sh
bun src/installer.ts init
```

Non-interactive examples:

```sh
bun src/installer.ts init --target senpi
bun src/installer.ts init --target pi
bun src/installer.ts init --target opencode
bun src/installer.ts init --target claude-code
bun src/installer.ts init --target mcp
```

## Host differences

- **OMO/Senpi:** installs the extension. It registers separate delegate,
  wait, and cancel tools and attaches `omoThreadId` to background runs.
- **OpenCode:** installs the V2 plugin, which registers separate tools and
  checks the host permission rules before delegate/cancel operations.
- **Pi:** installs one `miwarang` tool with an `action` for delegate, wait,
  or cancel. Pi extensions run with the process's OS permissions.
- **OMP:** installs one `miwarang` tool and asks for interactive confirmation
  before delegate/cancel by default.
- **Claude Code and generic MCP hosts:** run the stdio MCP server. The host
  decides how to present and approve each tool call.

All adapters use the same Miwarang config and host-neutral service. Backend
models remain owned by their respective harnesses.
