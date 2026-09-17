# tartarus-mcp

Local-first MCP memory server. Persistent, searchable memory for any AI agent.

Powered by [@saluca/asphodel](https://www.npmjs.com/package/@saluca/asphodel). Zero cloud dependencies. SQLite-backed.

## Install

```bash
npx tartarus-mcp install
```

Automatically configures Claude Code, Cursor, and Windsurf.

## Manual setup

Add to your MCP settings:

```json
{
  "mcpServers": {
    "tartarus": {
      "command": "npx",
      "args": ["tartarus-mcp@0.2.1"]
    }
  }
}
```

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

Versions 0.2.0 and earlier were published to npm with an `Apache-2.0` licence field, and those releases remain available under Apache 2.0.