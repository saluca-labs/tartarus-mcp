import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'

// Make the final rename fail, as a crash or a full disk would mid-install.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    renameSync: vi.fn(() => { throw new Error('simulated crash before rename') }),
  }
})

const { runInstall } = await import('../src/install.js')

let home: string
let windsurf: string
const ORIGINAL = JSON.stringify({ mcpServers: { other: { command: 'x' } } })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tartarus-atomic-test-'))
  windsurf = join(home, '.codeium', 'windsurf', 'mcp_config.json')
  mkdirSync(dirname(windsurf), { recursive: true })
  writeFileSync(windsurf, ORIGINAL)
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('atomic write', () => {
  it('a failure before the rename leaves the original file intact and no temp file', async () => {
    let err = ''
    const code = await runInstall({
      home, platform: 'linux', entryPath: '/x/dist/index.js', yes: true, dryRun: false, isTTY: false,
      prompt: async () => true, claudeCli: () => null, now: () => new Date('2026-10-22T00:00:00Z'),
      out: () => {}, err: (s) => { err += s },
    })
    expect(code).toBe(1)
    expect(err).toMatch(/simulated crash/)
    expect(readFileSync(windsurf, 'utf8')).toBe(ORIGINAL)
    expect(readdirSync(dirname(windsurf)).filter(f => f.includes('.tmp-'))).toEqual([])
  })
})
