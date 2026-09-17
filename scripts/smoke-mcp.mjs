// Runtime smoke test for the built MCP server (dist/index.js).
// Starts the real server over stdio against a fresh SQLite file, lists the
// tools, then stores, lists, reads back (recall + search), forgets and
// re-lists a memory through the vendored Asphodel SQLite adapter
// (src/vendor/asphodel, see its NOTICE).
// Usage: node scripts/smoke-mcp.mjs [path/to/entry.js]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, openSync, readSync, closeSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(process.argv[2] ?? "dist/index.js");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
// Which upstream commit the vendored core came from, for the log line only.
const vendoredFrom =
  /Commit:\s+([0-9a-f]{40})/.exec(readFileSync("src/vendor/asphodel/NOTICE", "utf8"))?.[1] ?? "unknown";

const EXPECTED_TOOLS = ["memory_forget", "memory_list", "memory_recall", "memory_remember",
  "memory_search", "profile_get", "profile_update"];
const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures.push(msg);
};

const dir = mkdtempSync(join(tmpdir(), "tartarus-smoke-"));
const dbPath = join(dir, "memory.db");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, TARTARUS_DB: dbPath },
  stderr: "inherit",
});
const client = new Client({ name: "tartarus-smoke", version: "0.0.0" });

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) return { isError: true, text };
  return { isError: false, value: JSON.parse(text) };
};

try {
  await client.connect(transport);
  console.log(`server entry: ${entry}`);
  console.log(`vendored asphodel core: salucallc/asphodel@${vendoredFrom}`);

  const info = client.getServerVersion();
  check(info?.name === "tartarus-mcp", `server name is tartarus-mcp (got ${info?.name})`);
  check(info?.version === pkg.version, `server version ${info?.version} matches package.json ${pkg.version}`);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), `tools/list = ${names.join(",")}`);

  const marker = `smokemarker${Date.now()}`;
  const content = `tartarus smoke ${marker} prefers sqlite`;
  const stored = await call("memory_remember", { content, topics: ["smoketopic", marker] });
  check(!stored.isError, `memory_remember succeeded ${stored.text ?? ""}`);
  const id = stored.value?.id;
  check(Number.isInteger(id) && id > 0, `memory_remember returned integer id (${id})`);
  check(stored.value?.content === content, "memory_remember echoed the content");

  // A second memory so list ordering and paging are exercised too.
  const second = await call("memory_remember", { content: "second smoke memory", topics: ["othertopic"] });
  check(!second.isError && second.value?.id !== id, `second memory stored with a distinct id (${second.value?.id})`);

  const listed = await call("memory_list", { limit: 10, offset: 0 });
  check(!listed.isError && Array.isArray(listed.value), "memory_list returned an array");
  check(listed.value?.length === 2, `memory_list returned 2 rows (got ${listed.value?.length})`);
  const row = listed.value?.find((m) => m.id === id);
  check(row?.content === content, "memory_list contains the stored memory with its content");
  const paged = await call("memory_list", { limit: 1, offset: 1 });
  check(paged.value?.length === 1, `memory_list limit=1 offset=1 returned 1 row (got ${paged.value?.length})`);

  const recalled = await call("memory_recall", { topic: "smoketopic" });
  check(!recalled.isError && recalled.value?.some((m) => m.id === id && m.content === content),
    "memory_recall(topic) gets the stored memory back by id and content");
  const recallOther = await call("memory_recall", { topic: "othertopic" });
  check(!recallOther.value?.some((m) => m.id === id), "memory_recall(other topic) does not return it");

  const found = await call("memory_search", { query: marker });
  check(!found.isError && found.value?.some((m) => m.id === id), "memory_search(marker) finds the stored memory");

  // ── agent profile ───────────────────────────────────────────────────────────
  // Exercised against the BUILT server, not the unit under test: the profile lives in its own
  // table in the same database file, and "it starts empty" is only true if the table was
  // created at startup on a database that memory has also been writing to.
  const fresh = await call("profile_get", {});
  check(!fresh.isError && JSON.stringify(fresh.value?.profile) === "{}",
    `profile_get starts empty (${JSON.stringify(fresh.value?.profile)})`);
  check(fresh.value?.revision === 0, `fresh profile revision is 0 (got ${fresh.value?.revision})`);

  const set1 = await call("profile_update", { patch: { user: { name: "Ada" }, tone: "terse" } });
  check(set1.value?.profile?.user?.name === "Ada" && set1.value?.revision === 1,
    "profile_update stored a nested value and bumped revision to 1");

  const set2 = await call("profile_update", { patch: { user: { role: "engineer" }, tone: null } });
  check(set2.value?.profile?.user?.name === "Ada" && set2.value?.profile?.user?.role === "engineer",
    "profile_update merged recursively, keeping the sibling field");
  check(!("tone" in (set2.value?.profile ?? { tone: 1 })), "profile_update with null deleted the key");

  const reread = await call("profile_get", {});
  check(reread.value?.revision === 2 && reread.value?.profile?.user?.role === "engineer",
    "profile_get reads back the merged document");

  const replaced = await call("profile_update", { patch: { only: true }, replace: true });
  check(JSON.stringify(replaced.value?.profile) === '{"only":true}',
    `profile_update replace:true swapped the whole document (${JSON.stringify(replaced.value?.profile)})`);

  const badPatch = await call("profile_update", { patch: "not an object" });
  check(badPatch.isError === true, "profile_update rejects a non-object patch");

  const forgot = await call("memory_forget", { id });
  check(forgot.value?.deleted === true, `memory_forget(${id}) returned deleted=true`);
  const again = await call("memory_forget", { id });
  check(again.value?.deleted === false, "memory_forget on the same id returns deleted=false");
  const after = await call("memory_list", {});
  check(Array.isArray(after.value) && after.value.length === 1 && !after.value.some((m) => m.id === id),
    "memory_list after forget no longer contains it");
  const recallAfter = await call("memory_recall", { topic: "smoketopic" });
  check(Array.isArray(recallAfter.value) && recallAfter.value.length === 0, "memory_recall after forget is empty");

  const bad = await client.callTool({ name: "memory_nope", arguments: {} });
  check(bad.isError === true, "unknown tool returns isError");
} catch (err) {
  check(false, `smoke run threw: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  await client.close().catch(() => {});
}

// The adapter must have written a real SQLite database at TARTARUS_DB.
if (existsSync(dbPath)) {
  const buf = Buffer.alloc(16);
  const fd = openSync(dbPath, "r");
  readSync(fd, buf, 0, 16, 0);
  closeSync(fd);
  check(buf.toString("latin1") === "SQLite format 3\0", `TARTARUS_DB is a SQLite file (${dbPath})`);
} else {
  check(false, `TARTARUS_DB was not created (${dbPath})`);
}
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }

if (failures.length) {
  console.error(`SMOKE FAILED: ${failures.length} check(s)`);
  process.exit(1);
}
console.log(`SMOKE OK: tartarus-mcp@${pkg.version} with vendored asphodel core @ ${vendoredFrom.slice(0, 7)}`);
