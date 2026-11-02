// Plan 002 Phase 3/4: what a client connected to /workspace/mcp actually sees.
// Deliberately NOT a byte-golden like the mail one -- Phase 5 tunes these
// descriptions from transcripts -- but the shape is pinned: the list is
// exactly endpoints.json's, in its order; the READ tools are read-only (so a
// `read`-scoped token can call all of them) and the WRITE tools are exactly
// the Phase 4 set, nothing else (so nothing sneaks onto the endpoint as a
// write by accident); the count stays under the 40-tool client ceiling; the
// instructions fit the 2KB budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadEndpoints } from '../dist/endpoints.js';
import { McpEndpointServer } from '../dist/mcp-server.js';
import { TOOL_REGISTRY } from '../dist/tools/registry.js';
import { scopeForTool, READ_SCOPE, WRITE_SCOPE } from '../dist/http/scopes.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The Phase 4 write surface (plan 002, "Tool surface"). A tool listed on the
// workspace endpoint with readOnlyHint:false must be one of these.
const WORKSPACE_WRITE_TOOLS = new Set([
  'create_drive_folder', 'update_drive_file', 'trash_drive_file', 'upload_drive_file',
  'write_sheet_range', 'append_sheet_rows', 'update_sheet_row', 'add_sheet_tab', 'rename_sheet_tab',
  'delete_sheet_tab', 'insert_sheet_dimension', 'delete_sheet_dimension', 'format_sheet_range',
  'add_sheet_chart', 'create_spreadsheet',
  'create_doc', 'append_doc_text', 'replace_doc_text', 'insert_doc_text',
  'create_event', 'update_event', 'delete_event',
]);

async function connectWorkspace() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-endpoint-'));
  process.env.GMAILMCPCONFIG_DIR = tmpDir;
  const endpoints = loadEndpoints(path.join(REPO, 'endpoints.json'));
  const endpoint = endpoints.find((e) => e.name === 'workspace');
  assert.ok(endpoint);
  const server = new McpEndpointServer(endpoint);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'workspace-endpoint-test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connectTransport(serverTransport), client.connect(clientTransport)]);
  return { client, server, tmpDir };
}

test('workspace tools/list is exactly endpoints.json, in order, under 40, reads read-only and writes exactly the Phase 4 set, with usable descriptions', async () => {
  const raw = JSON.parse(await fs.readFile(path.join(REPO, 'endpoints.json'), 'utf8'));
  const { client, server, tmpDir } = await connectWorkspace();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), raw.workspace.tools);
    assert.ok(tools.length > 0 && tools.length < 40, `tool count ${tools.length}`);
    const writes = new Set();
    for (const tool of tools) {
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} must carry readOnlyHint`);
      if (tool.annotations.readOnlyHint) {
        assert.equal(scopeForTool(tool.name), READ_SCOPE, `${tool.name} must need only the read scope`);
        assert.ok(!WORKSPACE_WRITE_TOOLS.has(tool.name), `${tool.name} is a write tool but claims read-only`);
      } else {
        assert.equal(scopeForTool(tool.name), WRITE_SCOPE, `${tool.name} must need the write scope`);
        assert.ok(WORKSPACE_WRITE_TOOLS.has(tool.name), `${tool.name} is exposed as a write but is not in the Phase 4 write set`);
        assert.equal(typeof tool.annotations.destructiveHint, 'boolean', `${tool.name} must say whether it is destructive`);
        writes.add(tool.name);
      }
      assert.ok(tool.description.length >= 60 && tool.description.length <= 512, `${tool.name} description length ${tool.description.length} (Codex reads the first 512 chars)`);
      assert.ok(/^[a-z]+(_[a-z]+){1,3}$/.test(tool.name), `${tool.name} must be a 2-4 word verb_noun name`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} schema must reject unknown args`);
    }
    assert.deepEqual([...writes].sort(), [...WORKSPACE_WRITE_TOOLS].sort(), 'every Phase 4 write tool is listed, and only those');
    // Every id-taking tool requires account (spec 002, "Ids belong to an account").
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      // calendar_id defaults to "primary" and fans out over both accounts, so it is not an account-bound id.
      const takesId = props.some((p) => /_id$/.test(p) && !['tab_id', 'calendar_id'].includes(p));
      if (takesId) assert.ok(tool.inputSchema.required?.includes('account'), `${tool.name} takes an id so must require account`);
    }
    // Every write tool requires account, id or not (a write always targets one account).
    for (const name of writes) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool.inputSchema.required?.includes('account'), `${name} is a write so must require account`);
    }
    // No Docs tool takes a character index from the model (plan 002 non-negotiable).
    for (const tool of tools.filter((t) => /_doc(_|$)/.test(t.name))) {
      for (const prop of Object.keys(tool.inputSchema.properties ?? {})) {
        assert.ok(!/index|offset|position_index/i.test(prop), `${tool.name}.${prop} looks like a character index`);
      }
    }
    const instructions = client.getInstructions();
    assert.ok(Buffer.byteLength(instructions, 'utf8') < 2000);
    assert.match(instructions, /search_drive_files/);
    assert.match(instructions, /read_doc/);
    assert.match(instructions, /update_sheet_row/);
    assert.match(instructions, /insert_doc_text/);
    assert.match(instructions, /allowlist/);
    assert.match(instructions, /\/mcp/);
  } finally {
    await client.close();
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('the mail endpoint still lists none of the workspace tools, and vice versa; the unlisted and deleted tools stay that way', async () => {
  const endpoints = loadEndpoints(path.join(REPO, 'endpoints.json'));
  const mail = new Set(endpoints.find((e) => e.name === 'mail').tools.map((t) => t.name));
  const ws = new Set(endpoints.find((e) => e.name === 'workspace').tools.map((t) => t.name));
  for (const name of ws) assert.ok(!mail.has(name), `${name} leaked into mail`);
  for (const name of mail) assert.ok(!ws.has(name), `${name} leaked into workspace`);
  // Built but listed on no endpoint (plan 002, "Tool surface").
  for (const unlisted of ['share_drive_file', 'list_accounts', 'begin_account_auth', 'finish_account_auth', 'get_signature', 'get_attachment', 'get_all_attachments']) {
    assert.ok(TOOL_REGISTRY.has(unlisted), `${unlisted} should still be built`);
    assert.ok(!ws.has(unlisted) && !mail.has(unlisted), `${unlisted} must be listed on no endpoint`);
  }
  // Deleted outright in Phase 3/4 (index-based or replaced), not aliased.
  for (const gone of ['docs_insert_table', 'docs_apply_style', 'docs_append', 'docs_create', 'docs_replace_text',
    'sheets_write', 'sheets_append', 'sheets_create', 'sheets_add_tab', 'sheets_rename_tab', 'sheets_delete_tab',
    'sheets_format', 'sheets_add_chart', 'sheets_insert_dimension', 'sheets_delete_dimension',
    'list_drive_files', 'get_drive_file_content', 'sheets_get', 'sheets_read', 'docs_get']) {
    assert.ok(!TOOL_REGISTRY.has(gone), `${gone} must no longer exist in the registry`);
  }
});
