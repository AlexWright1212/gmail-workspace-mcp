// Gmail signature reuse is DISABLED by owner decision.
// See docs/adr/005-disable-gmail-signature-reuse.md.
//
// These tests exist because the decision is easy to undo by accident. The
// signature code is deliberately left intact and dormant, so a future agent
// reading `getSignature()` and `signatureHtml` could reasonably conclude the
// feature is meant to work and "fix" it by re-adding the tool argument.
//
// They are structural, run against compiled `dist/`, because `src/index.ts`
// calls main() on import and cannot be imported by a test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readDist = (f) => fs.readFile(path.join(REPO, 'dist', f), 'utf8');

test('get_signature is not exposed on the mail endpoint (endpoints.json)', async () => {
  const raw = await fs.readFile(path.join(REPO, 'endpoints.json'), 'utf8');
  const enabled = JSON.parse(raw).mail?.tools;
  assert.ok(Array.isArray(enabled), 'endpoints.json must list a mail.tools array');
  assert.ok(
    !enabled.includes('get_signature'),
    'get_signature is exposed again — signature reuse is disabled (ADR 005)'
  );
});

test('no tool schema declares an include_signature parameter', async () => {
  const source = await readDist('tools/mail.js');
  // The schema property declaration specifically. The string also appears in
  // dormant prose inside describeSignatureUse(), which is fine.
  assert.ok(
    !/include_signature\s*:\s*\{/.test(source),
    'include_signature was re-added to a tool inputSchema (ADR 005)'
  );
});

test('both send paths hard-wire includeSignature to false rather than reading args', async () => {
  const source = await readDist('tools/mail.js');

  const assignments = [...source.matchAll(/const includeSignature = ([^;]+);/g)].map(
    (m) => m[1].trim()
  );

  assert.equal(
    assignments.length,
    2,
    `expected exactly 2 includeSignature assignments (create_draft, send_message), found ${assignments.length}`
  );

  for (const value of assignments) {
    assert.equal(
      value,
      'false',
      `includeSignature is computed as \`${value}\` instead of being hard-wired false. ` +
        'This server does NOT validate tool args against inputSchema, so reading ' +
        'rawArgs.include_signature re-enables the feature for any caller that passes it.'
    );
  }

  assert.ok(
    !/rawArgs\.include_signature/.test(source),
    'a handler reads rawArgs.include_signature again — removing it from the schema ' +
      'only hides the parameter, it does not disable it (ADR 005)'
  );
});

test('the signature code is still present, so the decision stays cheap to reverse', async () => {
  // ADR 005 claims the path is "intact and dormant". If someone deletes it,
  // that claim becomes false and the ADR needs superseding rather than the
  // code quietly disappearing.
  const client = await readDist('gmail-client.js');
  const compose = await readDist('compose.js');

  assert.ok(client.includes('getSignature'), 'getSignature() was deleted — ADR 005 says dormant, not removed');
  assert.ok(compose.includes('signatureHtml'), 'the signatureHtml channel was deleted — ADR 005 says dormant, not removed');
});
