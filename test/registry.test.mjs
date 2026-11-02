// Plan 002 Phase 1: TOOL_REGISTRY (src/tools/registry.ts) replaces the
// hand-maintained TOOL_SCOPES map that used to live in src/http/scopes.ts.
// scopeForTool now derives mail:read / mail:write from each tool's
// `annotations.readOnlyHint` instead of a second, separately-maintained list
// -- this test hardcodes the pre-refactor TOOL_SCOPES mail:read set (copied
// from src/http/scopes.ts before its map was deleted) so a drift in the
// derivation is caught here, not discovered live.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY } from '../dist/tools/registry.js';
import { scopeForTool, READ_SCOPE, WRITE_SCOPE } from '../dist/http/scopes.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The exact set that used to be READ_SCOPE in src/http/scopes.ts's
// TOOL_SCOPES map, before it was deleted in favor of TOOL_REGISTRY.
const PRE_REFACTOR_MAIL_READ_TOOLS = new Set([
  'read_emails',
  'search_emails',
  'get_email_thread',
  'get_labels',
  'list_blocked_senders',
  'list_drafts',
  'search_drafts',
]);

test('every definition in TOOL_REGISTRY has a boolean readOnlyHint', () => {
  assert.ok(TOOL_REGISTRY.size > 0, 'registry should not be empty');
  for (const [name, entry] of TOOL_REGISTRY) {
    assert.equal(
      typeof entry.definition.annotations?.readOnlyHint,
      'boolean',
      `${name} should have a boolean annotations.readOnlyHint`,
    );
  }
});

test('every tool name in endpoints.json exists in TOOL_REGISTRY', async () => {
  const raw = await fs.readFile(path.join(REPO, 'endpoints.json'), 'utf8');
  const endpoints = JSON.parse(raw);
  for (const [endpointName, endpoint] of Object.entries(endpoints)) {
    for (const toolName of endpoint.tools) {
      assert.ok(
        TOOL_REGISTRY.has(toolName),
        `endpoints.json's "${endpointName}" lists "${toolName}", not found in TOOL_REGISTRY`,
      );
    }
  }
});

test('scopeForTool returns read for exactly the pre-refactor mail:read tool set', () => {
  for (const name of PRE_REFACTOR_MAIL_READ_TOOLS) {
    assert.equal(
      scopeForTool(name),
      READ_SCOPE,
      `${name} should be ${READ_SCOPE} (was in the pre-refactor TOOL_SCOPES map)`,
    );
  }

  // And nothing else among the 23 mail-endpoint tools should be mail:read.
  const mailWriteTools = [
    'mark_as_read',
    'label_messages',
    'unlabel_messages',
    'label_thread',
    'unlabel_thread',
    'archive_emails',
    'trash_emails',
    'create_label',
    'delete_label',
    'block_sender',
    'unblock_sender',
    'mute_thread',
    'create_draft',
    'send_message',
    'send_draft',
    'delete_drafts',
  ];
  for (const name of mailWriteTools) {
    assert.equal(scopeForTool(name), WRITE_SCOPE, `${name} should be ${WRITE_SCOPE}`);
  }
});
