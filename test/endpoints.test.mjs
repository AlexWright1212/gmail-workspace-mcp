// Plan 002 Phase 1: loadEndpoints() (src/endpoints.ts) is the fail-closed
// loader for endpoints.json -- the replacement for tools-enabled.json /
// loadEnabledTools(), strengthened from "boot with no tools" to "refuse to
// boot" (see that module's doc comment, and docs/adr/003).
//
// Runs against dist/, like every other test here (src/index.ts self-executes
// on import; dist/endpoints.js does not).

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEndpoints } from '../dist/endpoints.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withTempFile(contents, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'endpoints-test-'));
  const file = path.join(dir, 'endpoints.json');
  if (contents !== undefined) {
    await fs.writeFile(file, contents, 'utf8');
  }
  try {
    return await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('missing file throws, naming the path', async () => {
  await withTempFile(undefined, async (file) => {
    assert.throws(() => loadEndpoints(file), (err) => {
      assert.match(err.message, /\[endpoints\]/);
      assert.ok(err.message.includes(file), 'error should name the file path');
      return true;
    });
  });
});

test('invalid JSON throws', async () => {
  await withTempFile('{ not valid json', async (file) => {
    assert.throws(() => loadEndpoints(file), /not valid JSON/);
  });
});

test('non-object root throws', async () => {
  await withTempFile('[1, 2, 3]', async (file) => {
    assert.throws(() => loadEndpoints(file), /must contain a JSON object/);
  });
});

test('unknown tool name throws, naming the tool and the endpoint', async () => {
  const body = JSON.stringify({
    mail: { path: '/mcp', displayName: 'Test', tools: ['read_emails', 'this_tool_does_not_exist'] },
  });
  await withTempFile(body, async (file) => {
    assert.throws(() => loadEndpoints(file), (err) => {
      assert.match(err.message, /this_tool_does_not_exist/);
      assert.match(err.message, /"mail"/);
      return true;
    });
  });
});

test('duplicate path across endpoints throws', async () => {
  const body = JSON.stringify({
    mail: { path: '/mcp', displayName: 'Test', tools: [] },
    other: { path: '/mcp', displayName: 'Test', tools: [] },
  });
  await withTempFile(body, async (file) => {
    assert.throws(() => loadEndpoints(file), /path "\/mcp".*unique|unique.*path/is);
  });
});

test('path not starting with "/" throws', async () => {
  const body = JSON.stringify({ mail: { path: 'mcp', displayName: 'Test', tools: [] } });
  await withTempFile(body, async (file) => {
    assert.throws(() => loadEndpoints(file), /invalid "path"/);
  });
});

test('tools not an array throws', async () => {
  const body = JSON.stringify({ mail: { path: '/mcp', displayName: 'Test', tools: 'read_emails' } });
  await withTempFile(body, async (file) => {
    assert.throws(() => loadEndpoints(file), /must be an array of strings/);
  });
});

test('duplicate tool name within one endpoint throws', async () => {
  const body = JSON.stringify({
    mail: { path: '/mcp', displayName: 'Test', tools: ['read_emails', 'read_emails'] },
  });
  await withTempFile(body, async (file) => {
    assert.throws(() => loadEndpoints(file), /more than once/);
  });
});

test('an endpoint name with no instructions module throws', async () => {
  const body = JSON.stringify({ nonsense: { path: '/nonsense', displayName: 'Test', tools: [] } });
  await withTempFile(body, async (file) => {
    assert.throws(() => loadEndpoints(file), /no instructions module/);
  });
});

test('the real endpoints.json loads: mail at /mcp with 23 tools, workspace at /workspace/mcp with 35 (plan 002 Phase 4)', async () => {
  const endpoints = loadEndpoints(path.join(REPO, 'endpoints.json'));
  const mail = endpoints.find((e) => e.name === 'mail');
  const workspace = endpoints.find((e) => e.name === 'workspace');

  assert.ok(mail, 'mail endpoint should exist');
  assert.equal(mail.path, '/mcp');
  assert.equal(mail.tools.length, 23);
  assert.equal(typeof mail.instructions, 'string');

  assert.ok(workspace, 'workspace endpoint should exist');
  assert.equal(workspace.path, '/workspace/mcp');
  assert.equal(workspace.tools.length, 35);
  assert.equal(typeof workspace.instructions, 'string');
});

// Plan 002 Phase 2: displayName is what the OAuth consent page shows the
// owner ("access to your Mail endpoint" vs "your Google Workspace endpoint"),
// so a missing one is a boot error like every other malformed field, not a
// blank on the consent page.
test('missing or empty displayName throws, naming the endpoint', async () => {
  for (const displayName of [undefined, '', '   ', 42]) {
    const body = JSON.stringify({ mail: { path: '/mcp', displayName, tools: [] } });
    await withTempFile(body, async (file) => {
      assert.throws(() => loadEndpoints(file), /"mail".*displayName/s);
    });
  }
});

// Express's app.use(path) is prefix-matched, so an endpoint mounted at /mcp
// would also see requests for /mcp/other -- including its auth gate, which
// would then verify tokens against the WRONG audience. Refused at boot.
test('an endpoint path nested under another endpoint throws, both directions', async () => {
  const nested = JSON.stringify({
    mail: { path: '/mcp', displayName: 'Mail', tools: [] },
    workspace: { path: '/mcp/other', displayName: 'Other', tools: [] },
  });
  await withTempFile(nested, async (file) => {
    assert.throws(() => loadEndpoints(file), /nests under or over/);
  });
  const reversed = JSON.stringify({
    workspace: { path: '/mcp/other', displayName: 'Other', tools: [] },
    mail: { path: '/mcp', displayName: 'Mail', tools: [] },
  });
  await withTempFile(reversed, async (file) => {
    assert.throws(() => loadEndpoints(file), /nests under or over/);
  });
  // A shared string prefix that is NOT a path-segment prefix is fine.
  const sibling = JSON.stringify({
    mail: { path: '/mcp', displayName: 'Mail', tools: [] },
    workspace: { path: '/mcpx', displayName: 'Other', tools: [] },
  });
  await withTempFile(sibling, async (file) => {
    assert.equal(loadEndpoints(file).length, 2);
  });
});

test('the real endpoints.json carries the display names the consent page and spec use', async () => {
  const endpoints = loadEndpoints(path.join(REPO, 'endpoints.json'));
  assert.equal(endpoints.find((e) => e.name === 'mail').displayName, 'Mail');
  assert.equal(endpoints.find((e) => e.name === 'workspace').displayName, 'Google Workspace');
});
