# AGENTS.md

Instructions for AI coding agents working in this repository.

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
- No em-dashes in docs.

## Do not

- Publish to npm or add a publish workflow (see README "Distribution").
- Edit `dist/` (generated) or `package-lock.json` by hand.
- Commit secrets, hostnames, internal paths or personal emails.

## Done means

`npm run build`, `npm test`, `npm run smoke`, `npm run smoke:install` and `npm run check:meta` all pass, and `llms-full.txt` was regenerated if `README.md` or this file changed.
