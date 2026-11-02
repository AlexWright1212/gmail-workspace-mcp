// Regenerates test/golden/mail-tools-list.json from the CURRENT build over
// stdio. Run deliberately, never from `npm test`: the snapshot is the frozen
// pre-Phase-1 (plan 002) shape of the mail endpoint's tools/list and
// instructions, and the golden test exists to detect any drift from it.
// Regenerate only when a change to the mail tool surface is intended and
// reviewed. Usage (from the repo root, after `npm run build`):
//   node test/golden/capture-mail-tools-list.mjs
// The stdio transport is used because the tools/list handler ignores the
// caller entirely, so it returns the same bytes an OAuth-gated /mcp call gets.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { mkdtempSync } from "node:fs"; import os from "node:os"; import path from "node:path";
const outPath = new URL("./mail-tools-list.json", import.meta.url).pathname;
const cfgDir = mkdtempSync(path.join(os.tmpdir(), "golden-capture-"));
const transport = new StdioClientTransport({
  command: 'node', args: ['dist/index.js'],
  env: { ...process.env, MCP_TRANSPORT: 'stdio', GMAILMCPCONFIG_DIR: cfgDir },
  stderr: 'pipe',
});
const client = new Client({ name: 'golden-capture', version: '0' });
await client.connect(transport);
const { tools } = await client.listTools();
const instructions = client.getInstructions();
const serverInfo = client.getServerVersion();
writeFileSync(outPath, JSON.stringify({ capturedAt: new Date().toISOString(), serverInfo, instructions, tools }, null, 2) + '\n');
console.log(`captured ${tools.length} tools, instructions ${Buffer.byteLength(instructions ?? '')} bytes -> ${outPath}`);
await client.close();
