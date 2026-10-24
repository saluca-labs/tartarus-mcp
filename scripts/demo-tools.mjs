// Prints what an MCP client sees from the built server: its name and version, the
// tools/list result, and one memory_remember / memory_search round trip.
// Used to capture docs/img/tools-list-2026-10-22.png. Runs against a throwaway
// SQLite file in the OS temp dir and never prints that path.
// Usage: node scripts/demo-tools.mjs [path/to/entry.js]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(process.argv[2] ?? "dist/index.js");
const dir = mkdtempSync(join(tmpdir(), "tartarus-demo-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, TARTARUS_DB: join(dir, "memory.db") },
  stderr: "ignore",
});
const client = new Client({ name: "tartarus-demo", version: "0.0.0" });

try {
  await client.connect(transport);
  const info = client.getServerVersion();
  console.log("MCP client -> node dist/index.js (stdio)");
  console.log(`server: ${info.name} ${info.version}`);
  console.log("");
  console.log("tools/list:");
  const { tools } = await client.listTools();
  for (const t of tools) {
    const req = t.inputSchema?.required ?? [];
    const props = Object.keys(t.inputSchema?.properties ?? {})
      .map((p) => (req.includes(p) ? p : `${p}?`));
    console.log(`  ${t.name}(${props.join(", ")})`);
  }
  console.log("");
  const args = { content: "The user prefers SQLite for local tools", topics: ["preferences"] };
  console.log(`tools/call memory_remember ${JSON.stringify(args)}`);
  const r = await client.callTool({ name: "memory_remember", arguments: args });
  const stored = JSON.parse(r.content[0].text);
  console.log(`  -> id ${stored.id}, topics ${JSON.stringify(stored.topics)}`);
  console.log(`tools/call memory_search {"query":"SQLite"}`);
  const s = await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
  const hits = JSON.parse(s.content[0].text);
  for (const h of hits) console.log(`  -> id ${h.id}: ${h.content}`);
} finally {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
}
