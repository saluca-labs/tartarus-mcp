/**
 * `tartarus-mcp install`: register this checkout with the MCP clients found on
 * the machine.
 *
 * What it does, in order:
 *   1. Plans every change and prints it: the file, the exact entry it would add,
 *      and the backup it would make.
 *   2. Asks before touching anything. `--yes` answers for a non-interactive run;
 *      with no terminal and no `--yes` it refuses and writes nothing.
 *      `--dry-run` prints the plan and stops.
 *   3. Backs up each existing file to `<file>.bak-<UTC timestamp>` first, then
 *      writes the new content to a temp file in the same directory and renames
 *      it over the original, so a crash never leaves a half-written config.
 *
 * Claude Code does not read MCP servers from `~/.claude/settings.json`. User
 * scope servers live in `~/.claude.json`, which Claude Code itself rewrites
 * while it runs, so this registers through `claude mcp add --scope user` rather
 * than editing that file. Without the `claude` CLI it prints the command.
 * Earlier versions wrote `mcpServers` into `~/.claude/settings.json`; if that
 * stale entry is found it is reported, not edited.
 */
import { copyFileSync, constants, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join, basename, delimiter, extname } from 'path'
import { randomBytes } from 'crypto'
import { spawnSync } from 'child_process'

export interface McpEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface ClaudeCliResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Runs the `claude` CLI with `args`, or returns null when it is not installed. */
export type ClaudeCli = (args: string[]) => ClaudeCliResult | null

export interface InstallOptions {
  home: string
  platform: NodeJS.Platform
  appData?: string
  entryPath: string
  yes: boolean
  dryRun: boolean
  isTTY: boolean
  prompt: (question: string) => Promise<boolean>
  claudeCli: ClaudeCli
  now: () => Date
  out: (s: string) => void
  err: (s: string) => void
}

interface FilePlan {
  kind: 'file'
  client: string
  path: string
  exists: boolean
  newText: string
  backupPath: string | null
}

interface ClaudePlan {
  kind: 'claude'
  client: string
  args: string[]
}

type Plan = FilePlan | ClaudePlan

export function backupStamp(d: Date): string {
  // 20261022T183005Z: sortable, no characters Windows forbids in file names.
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export function claudeAddArgs(entry: McpEntry): string[] {
  return ['mcp', 'add', '--scope', 'user', 'tartarus', '--', entry.command, ...entry.args]
}

function shellQuote(a: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : JSON.stringify(a)
}

export function editorTargets(o: Pick<InstallOptions, 'home' | 'platform' | 'appData'>): Array<{ client: string; path: string }> {
  return [
    {
      client: 'Cursor',
      path: o.platform === 'win32'
        ? join(o.appData ?? o.home, 'Cursor', 'mcp.json')
        : join(o.home, '.cursor', 'mcp.json'),
    },
    { client: 'Windsurf', path: join(o.home, '.codeium', 'windsurf', 'mcp_config.json') },
  ]
}

/** Write `text` to `path` atomically: temp file in the same directory, then rename. */
export function atomicWrite(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' })
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* already gone */ }
    throw e
  }
}

function backupPathFor(path: string, now: Date): string {
  const base = `${path}.bak-${backupStamp(now)}`
  if (!existsSync(base)) return base
  for (let i = 1; ; i++) {
    const p = `${base}-${i}`
    if (!existsSync(p)) return p
  }
}

export async function runInstall(o: InstallOptions): Promise<number> {
  const entry: McpEntry = { command: 'node', args: [o.entryPath], env: {} }
  const now = o.now()
  const plans: Plan[] = []
  const skipped: string[] = []
  const notes: string[] = []

  // ── Plan: editor JSON configs ──────────────────────────────────────────────
  for (const t of editorTargets(o)) {
    if (!existsSync(dirname(t.path))) continue
    const exists = existsSync(t.path)
    let config: Record<string, unknown> = {}
    if (exists) {
      try {
        const parsed = JSON.parse(readFileSync(t.path, 'utf8')) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
        config = parsed as Record<string, unknown>
      } catch (e) {
        o.err(`  x ${t.client}: ${t.path} is not valid JSON (${(e as Error).message}); left untouched\n`)
        continue
      }
    }
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>
    if (servers['tartarus']) {
      const existing = servers['tartarus'] as { args?: unknown[] }
      const target = Array.isArray(existing?.args) ? String(existing.args[0] ?? '') : ''
      skipped.push(`${t.client} (already installed in ${t.path})`)
      if (target && target !== o.entryPath) {
        notes.push(`${t.client}: the existing tartarus entry in ${t.path} points at ${target}, not this checkout. It was left as it is.`)
      }
      continue
    }
    const next = { ...config, mcpServers: { ...servers, tartarus: entry } }
    plans.push({
      kind: 'file',
      client: t.client,
      path: t.path,
      exists,
      newText: JSON.stringify(next, null, 2) + '\n',
      backupPath: exists ? backupPathFor(t.path, now) : null,
    })
  }

  // ── Plan: Claude Code, through its own CLI ─────────────────────────────────
  const claudeDir = join(o.home, '.claude')
  const legacy = join(claudeDir, 'settings.json')
  if (existsSync(legacy)) {
    try {
      const cfg = JSON.parse(readFileSync(legacy, 'utf8')) as Record<string, any>
      if (cfg?.mcpServers?.tartarus) {
        notes.push(
          `Claude Code: ${legacy} has an mcpServers.tartarus entry from an older tartarus-mcp install.\n` +
          '    Claude Code never read it (MCP servers are not configured in settings.json). It was\n' +
          '    left as it is; you can delete that entry.',
        )
      }
    } catch { /* not ours to judge */ }
  }
  const probe = o.claudeCli(['mcp', 'get', 'tartarus'])
  if (probe === null) {
    if (existsSync(claudeDir)) {
      notes.push(
        'Claude Code: the `claude` CLI was not found on PATH, so nothing was registered. Run:\n' +
        `    claude ${claudeAddArgs(entry).map(shellQuote).join(' ')}`,
      )
    }
  } else if (probe.status === 0) {
    skipped.push('Claude Code (already registered: claude mcp get tartarus)')
  } else {
    plans.push({ kind: 'claude', client: 'Claude Code', args: claudeAddArgs(entry) })
  }

  // ── Show the plan ──────────────────────────────────────────────────────────
  o.out('\ntartarus-mcp install\n\n')
  for (const s of skipped) o.out(`  - ${s}\n`)
  if (plans.length) {
    o.out(`${skipped.length ? '\n' : ''}  Planned changes:\n\n`)
    const shown = JSON.stringify({ tartarus: entry }, null, 2).split('\n').map(l => `        ${l}`).join('\n')
    for (const p of plans) {
      if (p.kind === 'file') {
        o.out(`  * ${p.client}: ${p.exists ? 'update' : 'create'} ${p.path}\n`)
        if (p.backupPath) o.out(`      back up first to ${p.backupPath}\n`)
        o.out(`      add to "mcpServers":\n${shown}\n\n`)
      } else {
        o.out(`  * ${p.client}: run  claude ${p.args.map(shellQuote).join(' ')}\n\n`)
      }
    }
  }
  for (const n of notes) o.out(`  ! ${n}\n\n`)

  if (!plans.length) {
    if (!skipped.length) {
      o.out('  No supported MCP clients found. Add this to your client\'s MCP settings:\n\n')
      o.out(`  "tartarus": ${JSON.stringify(entry, null, 4)}\n\n`)
    }
    return 0
  }

  if (o.dryRun) {
    o.out('  --dry-run: nothing was written.\n\n')
    return 0
  }

  // ── Confirm ────────────────────────────────────────────────────────────────
  if (!o.yes) {
    if (!o.isTTY) {
      o.err('tartarus-mcp install: not a terminal, so it cannot ask. Nothing was written.\n' +
            '  Re-run with --yes to apply the changes above, or --dry-run to only print them.\n')
      return 1
    }
    const ok = await o.prompt('  Apply these changes? [y/N] ')
    if (!ok) {
      o.out('  Cancelled. Nothing was written.\n\n')
      return 0
    }
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  let failed = 0
  for (const p of plans) {
    try {
      if (p.kind === 'file') {
        if (p.backupPath) copyFileSync(p.path, p.backupPath, constants.COPYFILE_EXCL)
        atomicWrite(p.path, p.newText)
        const back = JSON.parse(readFileSync(p.path, 'utf8')) as Record<string, any>
        if (back?.mcpServers?.tartarus?.args?.[0] !== o.entryPath) throw new Error('read-back did not contain the entry')
        o.out(`  ok ${p.client}: ${p.path}${p.backupPath ? ` (backup ${p.backupPath})` : ''}\n`)
      } else {
        const r = o.claudeCli(p.args)
        if (!r || r.status !== 0) throw new Error(`claude ${p.args.slice(0, 2).join(' ')} failed: ${(r?.stderr || r?.stdout || 'not found').trim()}`)
        o.out(`  ok ${p.client}: registered with claude mcp add --scope user\n`)
      }
    } catch (e) {
      failed++
      o.err(`  x ${p.client}: ${(e as Error).message}\n`)
    }
  }
  o.out('\n  Restart your editor to activate.\n')
  o.out(`  Server: node ${o.entryPath}\n`)
  o.out('  Keep this checkout in place; the editor config points at it.\n\n')
  return failed ? 1 : 0
}

// ── Default `claude` CLI runner ──────────────────────────────────────────────

function findOnPath(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean)
  const exts = platform === 'win32'
    ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const d of dirs) {
    for (const e of exts) {
      const p = join(d, name + e.toLowerCase())
      if (existsSync(p)) return p
      const P = join(d, name + e)
      if (existsSync(P)) return P
    }
  }
  return null
}

const CLAUDE_CLI_TIMEOUT_MS = 60_000

function winQuote(a: string): string {
  return `"${a.replace(/"/g, '""')}"`
}

/**
 * The real CLI runner. `TARTARUS_CLAUDE_CLI` overrides the executable (a `.js`
 * or `.mjs` path runs under this Node), which the smoke test uses so it never
 * touches a real Claude Code configuration.
 */
export function defaultClaudeCli(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ClaudeCli {
  return (args: string[]) => {
    const override = env['TARTARUS_CLAUDE_CLI']
    const exe = override || findOnPath('claude', platform, env)
    if (!exe || (override && !existsSync(override))) return null
    let r
    const ext = extname(exe).toLowerCase()
    const common = { encoding: 'utf8' as const, env, timeout: CLAUDE_CLI_TIMEOUT_MS }
    if (ext === '.js' || ext === '.mjs') {
      r = spawnSync(process.execPath, [exe, ...args], common)
    } else if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
      // cmd.exe expands %VAR% even inside double quotes, so a path containing
      // '%' cannot be passed through it safely. Refuse rather than register
      // a different path than the one shown.
      if ([exe, ...args].some(a => a.includes('%'))) {
        return { status: 1, stdout: '', stderr: "refusing to pass a path containing '%' through cmd.exe; run the printed claude command by hand" }
      }
      const line = [exe, ...args].map(winQuote).join(' ')
      r = spawnSync(env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        ...common, windowsVerbatimArguments: true,
      })
    } else {
      r = spawnSync(exe, args, common)
    }
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      return { status: null, stdout: '', stderr: `claude ${args.slice(0, 2).join(' ')} timed out after ${CLAUDE_CLI_TIMEOUT_MS / 1000}s` }
    }
    if (r.error) return null
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
}

export function parseInstallFlags(argv: string[]): { yes: boolean; dryRun: boolean; unknown: string[] } {
  const yes = argv.includes('--yes') || argv.includes('-y')
  const dryRun = argv.includes('--dry-run')
  const unknown = argv.filter(a => !['--yes', '-y', '--dry-run'].includes(a))
  return { yes, dryRun, unknown }
}
