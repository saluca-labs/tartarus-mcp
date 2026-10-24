#!/usr/bin/env node
/**
 * tartarus-mcp
 *
 * Local-first MCP memory server built on a vendored copy of the Apache-2.0
 * Asphodel core (src/vendor/asphodel, see its NOTICE).
 * Persistent, searchable memory for any AI agent. Zero cloud dependencies.
 *
 * Config:
 *   TARTARUS_DB=/path/to/memory.db  (default: ~/.tartarus/memory.db)
 *
 * Install (from source; tartarus-mcp is not published to any package registry):
 *   git clone https://github.com/saluca-labs/tartarus-mcp && cd tartarus-mcp
 *   npm ci && npm run build
 *   node dist/index.js install            (asks first; --yes, --dry-run)
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join, dirname, sep } from 'path'
import { fileURLToPath } from 'url'
import { homedir, platform } from 'os'
import { Asphodel, SQLiteAdapter } from './vendor/asphodel/index.js'
import { ProfileStore } from './profile.js'
import { createInterface } from 'readline/promises'
import { defaultClaudeCli, parseInstallFlags, runInstall } from './install.js'

// package.json always sits next to dist/ in a source checkout.
const PKG_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

// ── Install CLI ───────────────────────────────────────────────────────────────

if (process.argv[2] === 'install') {
  process.exit(await installCommand(process.argv.slice(3)))
}

async function installCommand(argv: string[]): Promise<number> {
  // tartarus-mcp is built from source and is not on any package registry (npm was
  // retired as a Saluca channel on 2026-09-16), so the editor config points `node`
  // at this checkout's built entry point rather than at a registry package name.
  const entryPath = fileURLToPath(import.meta.url)
  if (entryPath.split(sep).includes('_npx')) {
    process.stderr.write(
      '\ntartarus-mcp install: refusing to point your editor at the npx cache\n' +
      `  (${entryPath}), which npm may delete at any time.\n` +
      '  Clone and build instead, then run install from the checkout:\n' +
      '    git clone https://github.com/saluca-labs/tartarus-mcp\n' +
      '    cd tartarus-mcp && npm ci && npm run build && node dist/index.js install\n\n',
    )
    return 1
  }
  const flags = parseInstallFlags(argv)
  if (flags.unknown.length) {
    process.stderr.write(`tartarus-mcp install: unknown option ${flags.unknown.join(' ')}\n` +
      '  usage: tartarus-mcp install [--yes] [--dry-run]\n')
    return 2
  }
  const code = await runInstall({
    home: homedir(),
    platform: platform(),
    appData: process.env['APPDATA'],
    entryPath,
    yes: flags.yes,
    dryRun: flags.dryRun,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return /^y(es)?$/i.test((await rl.question(q)).trim())
      } finally {
        rl.close()
      }
    },
    claudeCli: defaultClaudeCli(),
    now: () => new Date(),
    out: (s) => { process.stdout.write(s) },
    err: (s) => { process.stderr.write(s) },
  })
  const dbPath = process.env['TARTARUS_DB'] ?? join(homedir(), '.tartarus', 'memory.db')
  process.stdout.write(`  DB: ${dbPath}  (v${PKG_VERSION})\n\n`)
  return code
}

// ── Store setup ───────────────────────────────────────────────────────────────

const dbPath = process.env['TARTARUS_DB'] ?? join(homedir(), '.tartarus', 'memory.db')
mkdirSync(dirname(dbPath), { recursive: true })

const adapter  = new SQLiteAdapter(dbPath)
const asphodel = new Asphodel(adapter)
await asphodel.init()

// Same database file, separate table. See src/profile.ts for why the profile is not
// stored as memories.
const profiles = new ProfileStore(dbPath)

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
  {
    name: 'profile_get',
    description: 'Read the agent profile: standing facts about who you work with and how. Returns {} on a fresh install. Call at the START of a session, before asking the user something they may have already told you.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'profile_update',
    description: 'Merge changes into the agent profile. Objects merge recursively, null deletes a key, arrays replace. Use for durable facts (name, role, preferences, working agreements) - NOT for things that happened, which belong in memory_remember.',
    inputSchema: {
      type: 'object',
      required: ['patch'],
      properties: {
        patch:   { type: 'object', description: 'Fields to merge. null as a value deletes that key.' },
        replace: { type: 'boolean', description: 'Replace the whole document instead of merging (default: false).' },
      },
    },
  },
]

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'tartarus-mcp', version: PKG_VERSION },
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

      case 'profile_get':
        result = profiles.get()
        break

      case 'profile_update': {
        const patch = a['patch']
        if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
          throw new Error('profile_update: `patch` must be an object')
        }
        result = profiles.update(patch as Record<string, unknown>, {
          replace: a['replace'] === true,
        })
        break
      }

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
