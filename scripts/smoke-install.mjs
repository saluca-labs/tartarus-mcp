// Tests the `install` command end to end.
// 1. Runs `node dist/index.js install` (no --yes, no terminal) against a
//    throwaway home directory and checks it refuses and writes nothing.
// 2. Runs it with --yes and reads back every config it wrote: the entry is a
//    source-build command (`node <absolute dist/index.js>`), not a registry
//    package; an existing config is backed up first and its other servers kept.
// 3. Claude Code is registered through `claude mcp add --scope user`, never by
//    writing ~/.claude/settings.json (Claude Code does not read MCP servers from
//    there). A fake `claude` (TARTARUS_CLAUDE_CLI) records the call, so this
//    never touches a real Claude Code configuration.
// 4. Starts the server with exactly the configured command and args, as an
//    editor would, and checks tools/list answers.
// 5. Checks install refuses to run from an npx cache directory.
// Usage: node scripts/smoke-install.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, dirname, basename } from "node:path";

const entry = resolve("dist/index.js");
const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures.push(msg);
};

const home = mkdtempSync(join(tmpdir(), "tartarus-install-"));
const appData = join(home, "AppData", "Roaming");
const configs = {
  Cursor: process.platform === "win32" ? join(appData, "Cursor", "mcp.json") : join(home, ".cursor", "mcp.json"),
  Windsurf: join(home, ".codeium", "windsurf", "mcp_config.json"),
};
const claudeSettings = join(home, ".claude", "settings.json");
mkdirSync(join(home, ".claude"), { recursive: true });
for (const p of Object.values(configs)) mkdirSync(resolve(p, ".."), { recursive: true });
// An existing config with another server must be preserved, and backed up.
const windsurfBefore = JSON.stringify({ mcpServers: { other: { command: "x" } } });
writeFileSync(configs.Windsurf, windsurfBefore);

// A fake `claude` CLI that records every call. It is ALWAYS set below, so this
// script can never reach a real Claude Code configuration.
const fakeClaudeLog = join(home, "fake-claude-calls.jsonl");
const fakeClaude = join(home, "fake-claude.mjs");
writeFileSync(fakeClaude, [
  'import { appendFileSync } from "node:fs";',
  `appendFileSync(${JSON.stringify(fakeClaudeLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
  // `get` succeeds once an `add` has been recorded, like the real CLI.
  'import { readFileSync, existsSync } from "node:fs";',
  `const log = ${JSON.stringify(fakeClaudeLog)};`,
  `const added = existsSync(log) && readFileSync(log, "utf8").includes('"add"');`,
  'process.exit(process.argv[3] === "get" ? (added ? 0 : 1) : 0);',
].join("\n"));

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: appData,
  TARTARUS_DB: join(home, "db", "memory.db"),
  TARTARUS_CLAUDE_CLI: fakeClaude,
};

// 1. No terminal, no --yes: refuse, write nothing.
const refused = spawnSync(process.execPath, [entry, "install"], { env, encoding: "utf8" });
check(refused.status === 1 && /--yes/.test(refused.stderr), `install without a terminal or --yes refuses (exit ${refused.status})`);
check(!existsSync(configs.Cursor), "refused install wrote no Cursor config");
check(readFileSync(configs.Windsurf, "utf8") === windsurfBefore, "refused install left the Windsurf config unchanged");
check(!existsSync(fakeClaudeLog) || !readFileSync(fakeClaudeLog, "utf8").includes('"add"'), "refused install did not run claude mcp add");

// 2. --yes applies.
const run = spawnSync(process.execPath, [entry, "install", "--yes"], { env, encoding: "utf8" });
check(run.status === 0, `install --yes exited 0 (got ${run.status}) ${run.stderr.trim()}`);
check(!/npx|npmjs|@saluca/.test(run.stdout), "install output mentions no npm registry package");

let entryFromConfig;
for (const [name, p] of Object.entries(configs)) {
  if (!existsSync(p)) {
    check(false, `${name}: config not written (${p})`);
    continue;
  }
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  const t = cfg.mcpServers?.tartarus;
  check(t?.command === "node", `${name}: command is node (got ${t?.command})`);
  const script = t?.args?.[0];
  check(t?.args?.length === 1 && isAbsolute(script ?? "") && resolve(script) === entry,
    `${name}: args is the absolute built entry (${script})`);
  check(existsSync(script ?? ""), `${name}: that entry exists on disk`);
  entryFromConfig ??= t;
  if (name === "Windsurf") {
    check(cfg.mcpServers?.other?.command === "x", "Windsurf: existing server kept");
    const baks = readdirSync(dirname(p)).filter((f) => f.startsWith(basename(p) + ".bak-"));
    check(baks.length === 1 && readFileSync(join(dirname(p), baks[0]), "utf8") === windsurfBefore,
      `Windsurf: original backed up byte for byte (${baks.join(",")})`);
  }
}

// 3. Claude Code went through the CLI, not settings.json.
check(!existsSync(claudeSettings), "Claude Code: ~/.claude/settings.json was not written");
const calls = existsSync(fakeClaudeLog) ? readFileSync(fakeClaudeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const add = calls.find((a) => a[1] === "add");
check(add && add.join(" ") === ["mcp", "add", "--scope", "user", "tartarus", "--", "node", entry].join(" "),
  `Claude Code: registered with claude mcp add --scope user (${add ? add.join(" ") : "no add call"})`);

const rerun = spawnSync(process.execPath, [entry, "install", "--yes"], { env, encoding: "utf8" });
check(rerun.status === 0 && /already installed/.test(rerun.stdout) && /already registered/.test(rerun.stdout),
  "second install reports already installed / registered");

// 4. Launch exactly what the editor would launch.
if (entryFromConfig) {
  const client = new Client({ name: "tartarus-install-smoke", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport({
      command: entryFromConfig.command,
      args: entryFromConfig.args,
      env: { ...env, ...entryFromConfig.env },
      stderr: "ignore",
    }));
    const { tools } = await client.listTools();
    // Assert the NAMES, not the count. A bare count passes when a tool is renamed and has to
    // be edited for every addition anyway - this failed CI on the profile PR with nothing more
    // useful than "returned 7 tools".
    const names = tools.map((t) => t.name).sort();
    const missing = ["memory_forget", "memory_list", "memory_recall", "memory_remember",
      "memory_search", "profile_get", "profile_update"].filter((n) => !names.includes(n));
    check(missing.length === 0,
      `configured command starts the server; tools/list = ${names.join(",")}` +
      (missing.length ? ` (missing: ${missing.join(",")})` : ""));
  } catch (err) {
    check(false, `configured command failed to start: ${err instanceof Error ? err.message : err}`);
  } finally {
    await client.close().catch(() => {});
  }
}

// 5. Running install from an npx cache must refuse rather than write an ephemeral path.
const npxDir = resolve("tmp-install-smoke", "_npx", "abc");
rmSync(resolve("tmp-install-smoke"), { recursive: true, force: true });
mkdirSync(npxDir, { recursive: true });
cpSync(resolve("dist"), join(npxDir, "dist"), { recursive: true });
cpSync(resolve("package.json"), join(npxDir, "package.json"));
const home2 = mkdtempSync(join(tmpdir(), "tartarus-install-npx-"));
mkdirSync(join(home2, ".cursor"), { recursive: true });
const npxRun = spawnSync(process.execPath, [join(npxDir, "dist", "index.js"), "install", "--yes"], {
  env: { ...env, HOME: home2, USERPROFILE: home2, APPDATA: join(home2, "AppData") },
  encoding: "utf8",
});
check(npxRun.status === 1 && /refusing/.test(npxRun.stderr), `install from an _npx path refuses (exit ${npxRun.status})`);
check(!existsSync(join(home2, ".cursor", "mcp.json")), "install from an _npx path wrote no config");

rmSync(resolve("tmp-install-smoke"), { recursive: true, force: true });
for (const d of [home, home2]) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
}

if (failures.length) {
  console.error(`INSTALL SMOKE FAILED: ${failures.length} check(s)`);
  process.exit(1);
}
console.log("INSTALL SMOKE OK");
