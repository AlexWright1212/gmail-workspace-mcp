// Plan 002 Phase 1 non-negotiable: "The mail endpoint's tools/list output is
// byte-identical before and after the restructure." test/golden/mail-tools-list.json
// was captured over stdio from the pre-refactor build (see its own header
// comment / docs/plans/002, "Golden test"). This connects a real MCP Client
// to the post-refactor McpEndpointServer over an in-process transport and
// diffs the two.
//
// Runs against dist/ (src/index.ts self-executes on import; dist/mcp-server.js
// and dist/endpoints.js do not).

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
import { scopeForTool, READ_SCOPE } from '../dist/http/scopes.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function connectMailEndpoint() {
  // connectTransport() -> ensureConfigLayout() writes to configRoot; point it
  // at a fresh temp dir so this test never touches the real ~/.gmail-multi-mcp.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'golden-mail-tools-'));
  process.env.GMAILMCPCONFIG_DIR = tmpDir;

  const endpoints = loadEndpoints(path.join(REPO, 'endpoints.json'));
  const mailEndpoint = endpoints.find((e) => e.name === 'mail');
  assert.ok(mailEndpoint, 'mail endpoint must exist in endpoints.json');

  const server = new McpEndpointServer(mailEndpoint);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'golden-test-client', version: '1.0.0' }, { capabilities: {} });

  await Promise.all([
    server.connectTransport(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, server, tmpDir };
}

function stableKeyOrder(value) {
  if (Array.isArray(value)) return value.map(stableKeyOrder);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableKeyOrder(value[key]);
    }
    return out;
  }
  return value;
}

test('mail endpoint tools/list is byte-identical to the pre-refactor golden snapshot', async () => {
  const golden = JSON.parse(await fs.readFile(path.join(REPO, 'test/golden/mail-tools-list.json'), 'utf8'));
  const { client, server, tmpDir } = await connectMailEndpoint();

  try {
    const { tools } = await client.listTools();
    const instructions = client.getInstructions();
    const serverVersion = client.getServerVersion();

    assert.equal(tools.length, golden.tools.length, 'tool count must match the golden snapshot');

    tools.forEach((tool, index) => {
      const goldenTool = golden.tools[index];
      assert.equal(tool.name, goldenTool.name, `tool[${index}].name mismatch (order matters)`);
      assert.equal(tool.description, goldenTool.description, `${tool.name}.description mismatch`);
      assert.deepEqual(
        stableKeyOrder(tool.inputSchema),
        stableKeyOrder(goldenTool.inputSchema),
        `${tool.name}.inputSchema mismatch`,
      );
    });

    assert.equal(instructions, golden.instructions, 'server instructions must be byte-identical');
    assert.equal(serverVersion?.name, golden.serverInfo.name);
    assert.equal(serverVersion?.version, golden.serverInfo.version);

    // The one deliberate addition: every tool now carries annotations with a
    // boolean readOnlyHint, and that classification must agree with
    // scopeForTool (i.e. the same source of truth the OAuth scope gate uses).
    for (const tool of tools) {
      assert.equal(
        typeof tool.annotations?.readOnlyHint,
        'boolean',
        `${tool.name} should have a boolean annotations.readOnlyHint`,
      );
      const scope = scopeForTool(tool.name);
      assert.ok(scope, `${tool.name} should have a defined scope`);
      const scopeSaysRead = scope === READ_SCOPE;
      assert.equal(
        tool.annotations.readOnlyHint,
        scopeSaysRead,
        `${tool.name}: readOnlyHint=${tool.annotations.readOnlyHint} but scopeForTool says ${scope}`,
      );
    }
  } finally {
    await client.close();
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.GMAILMCPCONFIG_DIR;
  }
});
