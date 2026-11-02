// Plan 002 Phase 1: every endpoint's server-level instructions must stay
// under the size Claude Code silently truncates at (src/instructions/*.ts's
// doc comments explain why). This asserts the byte budget directly rather
// than trusting the source comment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTIONS_BY_ENDPOINT } from '../dist/instructions/index.js';

test('every endpoint instructions string is under 2000 bytes', () => {
  const names = Object.keys(INSTRUCTIONS_BY_ENDPOINT);
  assert.ok(names.length > 0, 'INSTRUCTIONS_BY_ENDPOINT should not be empty');

  for (const name of names) {
    const text = INSTRUCTIONS_BY_ENDPOINT[name];
    assert.equal(typeof text, 'string', `${name} instructions should be a string`);
    const bytes = Buffer.byteLength(text, 'utf8');
    assert.ok(bytes < 2000, `${name} instructions are ${bytes} bytes, must be < 2000`);
  }
});

test('mail and workspace are both present', () => {
  assert.equal(typeof INSTRUCTIONS_BY_ENDPOINT.mail, 'string');
  assert.equal(typeof INSTRUCTIONS_BY_ENDPOINT.workspace, 'string');
});
