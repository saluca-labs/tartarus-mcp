import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { runInstall, backupStamp, parseInstallFlags, type InstallOptions, type ClaudeCli } from '../src/install.js'

const NOW = new Date('2026-10-22T18:30:05.123Z')
const STAMP = '20261022T183005Z'
const ENTRY = '/opt/tartarus-mcp/dist/index.js'

let home: string
let cursor: string
let windsurf: string
let out: string
let err: string
let prompts: string[]
let cliCalls: string[][]

function opts(over: Partial<InstallOptions> = {}): InstallOptions {
  return {
    home,
    platform: 'linux',
    entryPath: ENTRY,
    yes: false,
    dryRun: false,
    isTTY: true,
    prompt: async (q) => { prompts.push(q); return true },
    claudeCli: () => null,
    now: () => NOW,
    out: (s) => { out += s },
    err: (s) => { err += s },
    ...over,
  }
}

const EXISTING = JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }, null, 2)

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tartarus-install-test-'))
  cursor = join(home, '.cursor', 'mcp.json')
  windsurf = join(home, '.codeium', 'windsurf', 'mcp_config.json')
  mkdirSync(dirname(cursor), { recursive: true })
  mkdirSync(dirname(windsurf), { recursive: true })
  writeFileSync(windsurf, EXISTING)
  out = ''; err = ''; prompts = []; cliCalls = []
})

afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('install asks before writing', () => {
  it('shows each file and the exact entry before asking', async () => {
    let seenAtPrompt = ''
    await runInstall(opts({ prompt: async (q) => { seenAtPrompt = out; prompts.push(q); return true } }))
    expect(prompts).toHaveLength(1)
    expect(seenAtPrompt).toContain(cursor)
    expect(seenAtPrompt).toContain(windsurf)
    expect(seenAtPrompt).toContain(ENTRY)
    expect(seenAtPrompt).toContain(`${windsurf}.bak-${STAMP}`)
  })

  it('writes nothing when the user declines', async () => {
    const code = await runInstall(opts({ prompt: async () => false }))
    expect(code).toBe(0)
    expect(existsSync(cursor)).toBe(false)
    expect(readFileSync(windsurf, 'utf8')).toBe(EXISTING)
    expect(readdirSync(dirname(windsurf))).toEqual(['mcp_config.json'])
  })

  it('refuses without a terminal unless --yes, and writes nothing', async () => {
    const code = await runInstall(opts({ isTTY: false, prompt: async () => { throw new Error('must not prompt') } }))
    expect(code).toBe(1)
    expect(err).toMatch(/--yes/)
    expect(existsSync(cursor)).toBe(false)
    expect(readFileSync(windsurf, 'utf8')).toBe(EXISTING)
  })

  it('--yes applies without prompting', async () => {
    const code = await runInstall(opts({ isTTY: false, yes: true, prompt: async () => { throw new Error('must not prompt') } }))
    expect(code).toBe(0)
    expect(JSON.parse(readFileSync(cursor, 'utf8')).mcpServers.tartarus.args).toEqual([ENTRY])
  })

  it('--dry-run prints the plan and writes nothing', async () => {
    const code = await runInstall(opts({ dryRun: true }))
    expect(code).toBe(0)
    expect(prompts).toHaveLength(0)
    expect(out).toContain(cursor)
    expect(existsSync(cursor)).toBe(false)
    expect(readFileSync(windsurf, 'utf8')).toBe(EXISTING)
  })
})

describe('install backs up and writes atomically', () => {
  it('backs up the existing file, byte for byte, with a timestamp', async () => {
    await runInstall(opts())
    const bak = `${windsurf}.bak-${STAMP}`
    expect(existsSync(bak)).toBe(true)
    expect(readFileSync(bak, 'utf8')).toBe(EXISTING)
  })

  it('keeps existing keys and servers and adds tartarus', async () => {
    await runInstall(opts())
    const cfg = JSON.parse(readFileSync(windsurf, 'utf8'))
    expect(cfg.theme).toBe('dark')
    expect(cfg.mcpServers.other).toEqual({ command: 'x' })
    expect(cfg.mcpServers.tartarus).toEqual({ command: 'node', args: [ENTRY], env: {} })
  })

  it('never overwrites an earlier backup from the same second', async () => {
    writeFileSync(`${windsurf}.bak-${STAMP}`, 'older backup')
    await runInstall(opts())
    expect(readFileSync(`${windsurf}.bak-${STAMP}`, 'utf8')).toBe('older backup')
    expect(readFileSync(`${windsurf}.bak-${STAMP}-1`, 'utf8')).toBe(EXISTING)
  })

  it('leaves no temp files behind', async () => {
    await runInstall(opts())
    expect(readdirSync(dirname(windsurf)).filter(f => f.includes('.tmp-'))).toEqual([])
    expect(readdirSync(dirname(cursor)).filter(f => f.includes('.tmp-'))).toEqual([])
  })

  it('leaves an unparseable config untouched', async () => {
    writeFileSync(windsurf, '{ not json')
    await runInstall(opts())
    expect(readFileSync(windsurf, 'utf8')).toBe('{ not json')
    expect(err).toMatch(/not valid JSON/)
  })
})

describe('Claude Code', () => {
  beforeEach(() => { mkdirSync(join(home, '.claude'), { recursive: true }) })

  const cli = (registered: boolean): ClaudeCli => (args) => {
    cliCalls.push(args)
    if (args[0] === 'mcp' && args[1] === 'get') return { status: registered ? 0 : 1, stdout: '', stderr: '' }
    return { status: 0, stdout: 'Added', stderr: '' }
  }

  it('never writes ~/.claude/settings.json, which Claude Code does not read for MCP servers', async () => {
    await runInstall(opts({ claudeCli: cli(false) }))
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false)
  })

  it('registers through claude mcp add --scope user, after confirmation', async () => {
    await runInstall(opts({ claudeCli: cli(false) }))
    expect(cliCalls).toContainEqual(['mcp', 'add', '--scope', 'user', 'tartarus', '--', 'node', ENTRY])
    expect(prompts).toHaveLength(1)
  })

  it('does not call claude mcp add when the user declines', async () => {
    await runInstall(opts({ claudeCli: cli(false), prompt: async () => false }))
    expect(cliCalls.some(a => a[1] === 'add')).toBe(false)
  })

  it('skips when already registered', async () => {
    await runInstall(opts({ claudeCli: cli(true) }))
    expect(cliCalls.some(a => a[1] === 'add')).toBe(false)
    expect(out).toMatch(/already registered/)
  })

  it('prints the command when the claude CLI is missing', async () => {
    await runInstall(opts({ claudeCli: () => null }))
    expect(out).toMatch(/claude mcp add --scope user tartarus -- node/)
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false)
  })

  it('reports, and does not edit, a stale entry an older version wrote to settings.json', async () => {
    const legacy = join(home, '.claude', 'settings.json')
    const text = JSON.stringify({ mcpServers: { tartarus: { command: 'node', args: ['/old'] } } })
    writeFileSync(legacy, text)
    await runInstall(opts({ claudeCli: cli(false) }))
    expect(readFileSync(legacy, 'utf8')).toBe(text)
    expect(out).toMatch(/never read it/)
  })
})

describe('helpers', () => {
  it('backupStamp is a sortable UTC stamp', () => {
    expect(backupStamp(NOW)).toBe(STAMP)
  })
  it('parses flags', () => {
    expect(parseInstallFlags(['--yes'])).toEqual({ yes: true, dryRun: false, unknown: [] })
    expect(parseInstallFlags(['--dry-run', '-y'])).toEqual({ yes: true, dryRun: true, unknown: [] })
    expect(parseInstallFlags(['--force']).unknown).toEqual(['--force'])
  })
})
