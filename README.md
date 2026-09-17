# tartarus-mcp

Local-first MCP memory server. Persistent, searchable memory for any AI agent.

Built on the Apache-2.0 [Asphodel](./src/vendor/asphodel/NOTICE) memory core, vendored in this repo. Zero cloud dependencies. SQLite-backed.

## Install (build from source)

tartarus-mcp is not published to npm or any other package registry. Build it from this repository, pinned to a reviewed commit:

```bash
git clone https://github.com/saluca-labs/tartarus-mcp.git
cd tartarus-mcp
git checkout c8451c11db2aecf7ee7c0b201b9b6dcbee6fd5ee
npm ci --ignore-scripts=false
npm run build
node dist/index.js install
```

`install` configures Claude Code, Cursor and Windsurf to run `node /absolute/path/to/tartarus-mcp/dist/index.js`, so keep the checkout where it is. It also prints the equivalent `claude mcp add` line for the Claude Code CLI.

`--ignore-scripts=false` is needed only if your npm config sets `ignore-scripts=true`: the `better-sqlite3` dependency compiles or downloads its native binding in an install script.

## Manual setup

After building, add this to your MCP settings, using the absolute path of your checkout:

```json
{
  "mcpServers": {
    "tartarus": {
      "command": "node",
      "args": ["/absolute/path/to/tartarus-mcp/dist/index.js"]
    }
  }
}
```

### Without a local checkout

npm can fetch and build the pinned commit straight from GitHub. This does not use the npm registry for tartarus-mcp itself; its third-party dependencies still come from npm.

```json
{
  "mcpServers": {
    "tartarus": {
      "command": "npx",
      "args": ["-y", "--ignore-scripts=false", "github:saluca-labs/tartarus-mcp#c8451c11db2aecf7ee7c0b201b9b6dcbee6fd5ee"]
    }
  }
}
```

The first start takes about 30 seconds while it builds. Pin a full commit SHA, never a branch.

## Tools

| Tool | Description |
|------|-------------|
| `memory_remember` | Store a memory (topics auto-extracted) |
| `memory_recall` | Retrieve memories by topic |
| `memory_search` | Full-text search across all memories |
| `memory_forget` | Delete a memory by ID |
| `memory_list` | List recent memories |

## Config

```bash
TARTARUS_DB=/path/to/memory.db  # default: ~/.tartarus/memory.db
```

## Enterprise

Hash-chained audit trails, multi-tenant isolation, compliance controls, and team memory at [asphodel.ai](https://asphodel.ai).

## License

Functional Source License 1.1, Apache 2.0 Future License (`FSL-1.1-ALv2`), see [LICENSE](./LICENSE). Each version becomes available under the Apache License 2.0 on the second anniversary of its release. Copyright [Saluca LLC](https://saluca.com).

The vendored Asphodel core in [`src/vendor/asphodel/`](./src/vendor/asphodel/) (and its tests in `tests/vendor/asphodel/`) is licensed under the Apache License 2.0, not FSL; see its [LICENSE](./src/vendor/asphodel/LICENSE) and [NOTICE](./src/vendor/asphodel/NOTICE), which record the origin commit.

Versions 0.2.0 and earlier were published to npm with an `Apache-2.0` licence field, and those releases remain available under Apache 2.0.

## Distribution

npm is no longer a distribution channel. On 2026-09-16 Saluca removed all of its packages from npm, including `tartarus-mcp` and `@saluca/asphodel`, which tartarus-mcp used to depend on. That is why the Asphodel core is vendored here, why `package.json` is `"private": true`, and why the npm publish workflow was removed. Install from source as described above. Do not install a package named `tartarus-mcp` from npm: it is not ours.