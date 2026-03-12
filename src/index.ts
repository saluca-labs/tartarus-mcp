#!/usr/bin/env node
/**
 * tartarus-mcp
 *
 * Local-first MCP memory server powered by @saluca/asphodel.
 * Persistent, searchable memory for any AI agent. Zero cloud dependencies.
 *
 * Config:
 *   TARTARUS_DB=/path/to/memory.db  (default: ~/.tartarus/memory.db)
 *
 * Install:
 *   npx tartarus-mcp install
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir, platform } from 'os'
import { Asphodel, SQLiteAdapter } from '@saluca/asphodel'

// ── Install CLI ───────────────────────────────────────────────────────────────

if (process.argv[2] === 'install') {
  runInstall()
  process.exit(0)
}

function runInstall(): void {
  const entry = { command: 'npx', args: ['tartarus-mcp@latest'], env: {} as Record<string, string> }
  const installed: string[] = []
  const skipped: string[]   = []

  const clients: Array<{ name: string; path: string }> = [
    {
      name: 'Claude Code',
      path: join(homedir(), '.claude', 'settings.json'),
    },
    {
      name: 'Cursor',
      path: platform() === 'win32'
        ? join(process.env['APPDATA'] ?? homedir(), 'Cursor', 'mcp.json')
        : join(homedir(), '.cursor', 'mcp.json'),
    },
    {
      name: 'Windsurf',
      path: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    },
  ]

  for (const client of clients) {
    try {
      if (!existsSync(dirname(client.path))) continue
      mkdirSync(dirname(client.path), { recursive: true })
      const raw     = existsSync(client.path) ? readFileSync(client.path, 'utf8') : '{}'
      const config  = JSON.parse(raw) as Record<string, unknown>
      const servers = (config.mcpServers ?? {}) as Record<string, unknown>
      if (servers['tartarus']) {
        skipped.push(client.name + ' (already installed)')
      } else {
        servers['tartarus'] = entry
        config.mcpServers   = servers
        writeFileSync(client.path, JSON.stringify(config, null, 2) + '\n', 'utf8')
        installed.push(client.name)
      }
    } catch (err) {
      process.stderr.write(`  ✗ ${client.name}: ${(err as Error).message}\n`)
    }
  }

  process.stdout.write('\ntartarus-mcp install\n\n')
  if (installed.length) process.stdout.write(installed.map(c => `  ✓ ${c}`).join('\n') + '\n')
  if (skipped.length)   process.stdout.write(skipped.map(c   => `  – ${c}`).join('\n') + '\n')
  if (!installed.length && !skipped.length) {
    process.stdout.write('  No supported MCP clients found.\n\n')
    process.stdout.write('  Add manually to your MCP settings:\n\n')
    process.stdout.write(`  "tartarus": ${JSON.stringify(entry, null, 4)}\n`)
  } else {
    const dbPath = process.env['TARTARUS_DB'] ?? join(homedir(), '.tartarus', 'memory.db')
    process.stdout.write(`\n  Restart your editor to activate.\n  DB: ${dbPath}\n\n`)
  }
}

// ── Store setup ───────────────────────────────────────────────────────────────

const dbPath = process.env['TARTARUS_DB'] ?? join(homedir(), '.tartarus', 'memory.db')
mkdirSync(dirname(dbPath), { recursive: true })

const adapter  = new SQLiteAdapter(dbPath)
const asphodel = new Asphodel(adapter)
await asphodel.init()

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'memory_remember',
    description: 'Store a memory. Call after any fact, decision, preference, or context worth keeping across sessions.',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string', description: 'The memory to store.' },
        topics:  { type: 'array', items: { type: 'string' }, description: 'Topic labels (auto-extracted if omitted).' },
      },
    },
  },
  {
    name: 'memory_recall',
    description: 'Retrieve memories by topic.',
    inputSchema: {
      type: 'object',
      required: ['topic'],
      properties: {
        topic: { type: 'string', description: 'Topic to look up.' },
        limit: { type: 'number', description: 'Max results (default: 10).' },
      },
    },
  },
  {
    name: 'memory_search',
    description: 'Full-text search across all stored memories.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'number', description: 'Max results (default: 10).' },
      },
    },
  },
  {
    name: 'memory_forget',
    description: 'Delete a memory by ID.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'number', description: 'Memory ID to delete.' },
      },
    },
  },
  {
    name: 'memory_list',
    description: 'List recent memories.',
    inputSchema: {
      type: 'object',
      properties: {
        limit:  { type: 'number', description: 'Max results (default: 20).' },
        offset: { type: 'number', description: 'Pagination offset (default: 0).' },
      },
    },
  },
]

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'tartarus-mcp', version: '0.2.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  const a = args as Record<string, unknown>

  try {
    let result: unknown

    switch (name) {
      case 'memory_remember':
        result = await asphodel.remember(a['content'] as string, {
          topics: a['topics'] as string[] | undefined,
        })
        break

      case 'memory_recall':
        result = await asphodel.recall(a['topic'] as string, {
          limit: a['limit'] as number | undefined,
        })
        break

      case 'memory_search':
        result = await asphodel.search(a['query'] as string, {
          limit: a['limit'] as number | undefined,
        })
        break

      case 'memory_forget':
        result = { deleted: await asphodel.forget(a['id'] as number) }
        break

      case 'memory_list':
        result = await asphodel.list(
          (a['limit']  as number | undefined) ?? 20,
          (a['offset'] as number | undefined) ?? 0,
        )
        break

      default:
        throw new Error(`Unknown tool: ${name}`)
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`[tartarus-mcp] Ready. DB: ${dbPath}\n`)
