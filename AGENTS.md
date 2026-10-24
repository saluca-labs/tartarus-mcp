# AGENTS.md

Instructions for AI coding agents working in this repository.

## What this is

A local MCP server over stdio that gives any MCP client seven tools: five memory tools on a vendored Asphodel core and two agent-profile tools, all stored in one SQLite file. TypeScript, ESM, Node.js 18 or later, built from source; it is not on npm.

## Read in this order

1. [README.md](README.md) "How it works" and "Architecture": the call path from `tools/call` to a SQLite table.
2. [src/index.ts](src/index.ts): the `install` command, the `TOOLS` array (the public interface) and the `CallToolRequestSchema` handler.
3. [src/profile.ts](src/profile.ts): the agent profile store and its merge rules.
4. [src/vendor/asphodel/store.ts](src/vendor/asphodel/store.ts) and [adapters/sqlite.ts](src/vendor/asphodel/adapters/sqlite.ts): what each memory tool does to the database.
5. [scripts/smoke-mcp.mjs](scripts/smoke-mcp.mjs): the end-to-end check that pins the tool list.

## What you can and cannot see

- You can see all of the server: `src/`, its tests in `tests/`, and the CI scripts in `scripts/`.
- `src/vendor/asphodel/` is a copy of upstream Apache-2.0 code; its origin commit and local changes are in its `NOTICE`. The upstream repository is not here.
- The hosted Asphodel product (audit chains, multi-tenant, team memory) is closed and not in this repo or any public one.
- `dist/` and `node_modules/` are build output, not source.

## Using it as an agent

After `npm ci --ignore-scripts=false && npm run build`, register the server. For Claude Code:

```bash
claude mcp add tartarus -- node "/absolute/path/to/tartarus-mcp/dist/index.js"
```

For any client that reads an `mcpServers` block:

```json
{
  "mcpServers": {
    "tartarus": {
      "command": "node",
      "args": ["/absolute/path/to/tartarus-mcp/dist/index.js"],
      "env": { "TARTARUS_DB": "/path/to/memory.db" }
    }
  }
}
```

The tools are `memory_remember`, `memory_recall`, `memory_search`, `memory_forget`, `memory_list`, `profile_get` and `profile_update`. There are no MCP resources or prompts.

## The only numbers to trust

| Number | Value | Source |
|---|---|---|
| Version | 0.4.0 | `package.json` `version` (the server reports it in `initialize`) |
| Tools | 7 | `TOOLS` in `src/index.ts`, pinned by `EXPECTED_TOOLS` in `scripts/smoke-mcp.mjs` |
| Default recall and search limit | 10 | `DEFAULT_RECALL_LIMIT`, `DEFAULT_SEARCH_LIMIT` in `src/vendor/asphodel/store.ts` |
| Default list limit | 20 | `memory_list` case in `src/index.ts` |
| Topics per memory | at most 10 | `DEFAULT_MAX_TOPICS` in `src/vendor/asphodel/store.ts` |
| Memories indexed per topic word | the newest 10 | `maxMemoriesPerTopic` in `src/vendor/asphodel/adapters/sqlite.ts` |
| Runtime dependencies | 2 | `dependencies` in `package.json` |

Any other figure (speed, recall quality, scale) has no source in this repo; do not state one.

## Setup

```bash
npm ci --ignore-scripts=false   # better-sqlite3 needs its install script for the native binding
npm run build                   # tsc -> dist/
```

Node.js 18 or later; CI uses Node.js 22 on Ubuntu and Windows.

## Test

```bash
npm test               # vitest: vendored Asphodel core and profile tests
npm run smoke          # starts dist/index.js over stdio and exercises every tool; ends "SMOKE OK"
npm run smoke:install  # runs `install` against a throwaway home directory
npm run check:meta     # licence, vendoring notices and the README install pin
npm audit --audit-level=low
```

Passing looks like: vitest reports no failures, `smoke` prints `SMOKE OK: tartarus-mcp@<version>`, `check:meta` prints `OK:`.

## Conventions

- TypeScript, ES modules, two runtime dependencies (`@modelcontextprotocol/sdk`, `better-sqlite3`). Do not add dependencies without a reason in the PR.
- `src/vendor/asphodel/` is an upstream Apache-2.0 copy carried so it can be re-vendored. Do not edit it in place for tartarus-mcp features; put them in `src/` (as `src/profile.ts` does). If a vendored file must change, record the change in its `NOTICE`.
- Tool names and their input schemas in `src/index.ts` are a public interface. Changing one means updating `README.md`, `scripts/smoke-mcp.mjs` (`EXPECTED_TOOLS`), `llms.txt` and `llms-full.txt`.
- The README install section pins one full commit SHA, and CI checks it is an ancestor of `master`. Use merge commits, not squash, or the pin becomes unreachable.
- The README diagrams are Mermaid source. If you change a call path they depict, change the diagram in the same PR.
- No em-dashes in docs.

## Do not

- Publish to npm or add a publish workflow (see README "Distribution").
- Edit `dist/` (generated) or `package-lock.json` by hand.
- Commit secrets, hostnames, internal paths or personal emails.

## Done means

`npm run build`, `npm test`, `npm run smoke`, `npm run smoke:install` and `npm run check:meta` all pass, and `llms-full.txt` was regenerated if `README.md` or this file changed.
