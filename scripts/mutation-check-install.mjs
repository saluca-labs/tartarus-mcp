// Reverts each protection in src/install.ts in place, checks the install tests
// FAIL, then restores the file. A protection whose revert leaves the tests green
// is not tested. Usage: node scripts/mutation-check-install.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "src/install.ts";
const TESTS = ["tests/install.test.ts", "tests/install-atomic.test.ts"];

const MUTATIONS = [
  ["no confirmation: apply without asking", "  if (!o.yes) {\n    if (!o.isTTY) {", "  if (false) {\n    if (!o.isTTY) {"],
  ["no backup before writing", "        if (p.backupPath) copyFileSync(p.path, p.backupPath, constants.COPYFILE_EXCL)\n", ""],
  ["backup overwrites an earlier one", "  if (!existsSync(base)) return base\n", "  return base\n"],
  ["non-atomic write straight over the file", "    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' })\n    renameSync(tmp, path)",
    "    writeFileSync(path, text, 'utf8')"],
  ["Claude Code back to ~/.claude/settings.json (old behaviour)",
    "    { client: 'Windsurf', path: join(o.home, '.codeium', 'windsurf', 'mcp_config.json') },\n",
    "    { client: 'Windsurf', path: join(o.home, '.codeium', 'windsurf', 'mcp_config.json') },\n    { client: 'Claude Code', path: join(o.home, '.claude', 'settings.json') },\n"],
  ["dry-run writes", "  if (o.dryRun) {", "  if (false) {"],
  ["non-TTY without --yes applies", "    if (!o.isTTY) {\n", "    if (false) {\n"],
];

const original = readFileSync(FILE, "utf8");
let survived = 0;
for (const [name, from, to] of MUTATIONS) {
  if (original.split(from).length !== 2) {
    console.error(`anchor not found exactly once: ${name}`);
    process.exit(2);
  }
  writeFileSync(FILE, original.replace(from, to));
  try {
    const r = spawnSync("npx", ["vitest", "run", ...TESTS], { encoding: "utf8", shell: process.platform === "win32" });
    const killed = r.status !== 0;
    if (!killed) survived++;
    const line = (r.stdout.match(/Tests\s+[^\n]+/) || ["?"])[0].trim();
    console.log(`${killed ? "KILLED  " : "SURVIVED"} ${name}: ${line}`);
  } finally {
    writeFileSync(FILE, original);
  }
}
const final = spawnSync("npx", ["vitest", "run", ...TESTS], { encoding: "utf8", shell: process.platform === "win32" });
console.log(`restored: ${(final.stdout.match(/Tests\s+[^\n]+/) || ["?"])[0].trim()}`);
process.exit(survived || final.status ? 1 : 0);
