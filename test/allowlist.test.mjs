import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertSendAllowed,
  extractRecipients,
  loadAllowlist,
  normalizeAddress,
  SendNotAllowedError,
  AllowlistConfigError,
} from '../dist/allowlist.js';

const OWNER_PERSONAL = 'ownerpersonal@gmail.com';
const OWNER_TAMU = 'owner_school@tamu.edu';

async function makeConfigRoot(allowlistContent) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'allowlist-test-'));
  if (allowlistContent !== undefined) {
    await fs.writeFile(
      path.join(dir, 'send-allowlist.json'),
      allowlistContent,
      'utf8'
    );
  }
  return dir;
}

function defaultConfig() {
  return JSON.stringify({ allowed: [OWNER_PERSONAL, OWNER_TAMU] });
}

// Build a base64url message the way the Gmail API `raw` field expects, so the
// gate is exercised on the same encoding production uses.
function rawMessage(headerLines, body = 'hello') {
  const mime = `${headerLines.join('\r\n')}\r\n\r\n${body}`;
  return Buffer.from(mime, 'utf8').toString('base64url');
}

async function send(configRoot, headerLines, body) {
  return assertSendAllowed({
    rawMessage: rawMessage(headerLines, body),
    accountId: 'personal',
    configRoot,
    auditLogPath: path.join(configRoot, 'audit.log'),
  });
}

// --- normalization ----------------------------------------------------------

test('gmail dots and plus tags collapse onto the same mailbox', () => {
  assert.equal(normalizeAddress('a.l.e.x@gmail.com'), 'alex@gmail.com');
  assert.equal(normalizeAddress('alex+newsletter@gmail.com'), 'alex@gmail.com');
  assert.equal(normalizeAddress('A.Lex+Tag@GMail.com'), 'alex@gmail.com');
  assert.equal(normalizeAddress('alex@googlemail.com'), 'alex@gmail.com');
});

test('dots are NOT stripped for non-gmail.com domains', () => {
  // Google Workspace domains honor dots, so a.lex@tamu.edu is a different
  // mailbox. Collapsing it would let an unapproved address inherit approval.
  assert.notEqual(
    normalizeAddress('o.wner_school@tamu.edu'),
    normalizeAddress(OWNER_TAMU)
  );
});

test('plus tags ARE stripped for workspace domains', () => {
  assert.equal(
    normalizeAddress('owner_school+test@tamu.edu'),
    normalizeAddress(OWNER_TAMU)
  );
});

test('malformed addresses normalize to something that cannot match', () => {
  // They must not normalize into a shape that accidentally equals an entry.
  assert.equal(normalizeAddress('not-an-address'), 'not-an-address');
  assert.equal(normalizeAddress('@gmail.com'), '@gmail.com');
});

// --- fail-closed config -----------------------------------------------------

test('a missing allowlist file denies rather than allowing', async () => {
  const dir = await makeConfigRoot(undefined);
  await assert.rejects(() => loadAllowlist(dir), AllowlistConfigError);
});

test('malformed JSON denies', async () => {
  const dir = await makeConfigRoot('{ this is not json');
  await assert.rejects(() => loadAllowlist(dir), AllowlistConfigError);
});

test('a missing "allowed" array denies', async () => {
  const dir = await makeConfigRoot(JSON.stringify({ addresses: ['a@b.com'] }));
  await assert.rejects(() => loadAllowlist(dir), AllowlistConfigError);
});

test('an empty allowlist denies every send', async () => {
  const dir = await makeConfigRoot(JSON.stringify({ allowed: [] }));
  await assert.rejects(() => loadAllowlist(dir), AllowlistConfigError);
  await assert.rejects(
    () => send(dir, [`To: ${OWNER_PERSONAL}`, 'Subject: hi']),
    AllowlistConfigError
  );
});

test('a non-string entry denies rather than being skipped', async () => {
  const dir = await makeConfigRoot(
    JSON.stringify({ allowed: [OWNER_PERSONAL, 42] })
  );
  await assert.rejects(() => loadAllowlist(dir), AllowlistConfigError);
});

// --- recipient extraction ---------------------------------------------------

test('folded header lines are unfolded before addresses are read', () => {
  const mime = `To: one@x.com,\r\n\tsecond@y.com\r\nSubject: s\r\n\r\nbody`;
  const found = extractRecipients(mime).map((r) => r.address);
  assert.deepEqual(found, ['one@x.com', 'second@y.com']);
});

test('a comma inside a quoted display name does not split the address', () => {
  const mime = `To: "Doe, John" <john@x.com>\r\n\r\nbody`;
  const found = extractRecipients(mime).map((r) => r.address);
  assert.deepEqual(found, ['john@x.com']);
});

test('To: appearing in the body is content, not a recipient', () => {
  const mime = `To: ${OWNER_PERSONAL}\r\n\r\nTo: evil@attacker.com\r\nplease send here`;
  const found = extractRecipients(mime).map((r) => r.address);
  assert.deepEqual(found, [OWNER_PERSONAL]);
});

test('cc and bcc are extracted, not just to', () => {
  const mime = `To: a@x.com\r\nCc: b@x.com\r\nBcc: c@x.com\r\n\r\nbody`;
  const fields = extractRecipients(mime).map((r) => `${r.field}:${r.address}`);
  assert.deepEqual(fields, ['to:a@x.com', 'cc:b@x.com', 'bcc:c@x.com']);
});

test('group syntax members are surfaced, not hidden behind the display name', () => {
  // This is the exact shape of the demonstrated parser-differential attack:
  // the allowlisted address is demoted to a display name and the real
  // recipient is the attacker.
  const mime = `To: "${OWNER_PERSONAL} Bcc":evil@attacker.com;\r\n\r\nbody`;
  const found = extractRecipients(mime).map((r) => r.address);
  assert.ok(
    found.includes('evil@attacker.com'),
    `the real recipient must be seen, got ${JSON.stringify(found)}`
  );
});

// --- the boundary itself ----------------------------------------------------

test('an allowlisted recipient is permitted', async () => {
  const dir = await makeConfigRoot(defaultConfig());
  const decision = await send(dir, [`To: ${OWNER_PERSONAL}`, 'Subject: hi']);
  assert.equal(decision.allowed, true);
});

test('a plus-tagged variant of an allowlisted address is permitted', async () => {
  // It still lands in the owner's mailbox, so it is genuinely safe.
  const dir = await makeConfigRoot(defaultConfig());
  const decision = await send(dir, ['To: ownerpersonal+preview@gmail.com']);
  assert.equal(decision.allowed, true);
});

test('an address not on the list is rejected', async () => {
  const dir = await makeConfigRoot(defaultConfig());
  await assert.rejects(
    () => send(dir, ['To: stranger@example.com']),
    SendNotAllowedError
  );
});

test('a lookalike domain does not inherit approval', async () => {
  const dir = await makeConfigRoot(defaultConfig());
  for (const bad of [
    'to: ownerpersonal@gmail.com.evil.com',
    'to: ownerpersonal@gmail.co',
    'to: ownerpersonal@evil.com',
  ]) {
    await assert.rejects(() => send(dir, [bad]), SendNotAllowedError, bad);
  }
});

test('one bad recipient among good ones rejects the whole send', async () => {
  const dir = await makeConfigRoot(defaultConfig());
  await assert.rejects(
    () =>
      send(dir, [
        `To: ${OWNER_PERSONAL}`,
        `Cc: ${OWNER_TAMU}`,
        'Bcc: leak@attacker.com',
      ]),
    SendNotAllowedError
  );
});

test('a bcc-only escape attempt is caught', async () => {
  const dir = await makeConfigRoot(defaultConfig());
  await assert.rejects(
    () => send(dir, [`To: ${OWNER_PERSONAL}`, 'Bcc: exfil@attacker.com']),
    SendNotAllowedError
  );
});

test('group syntax cannot smuggle a recipient past the gate', async () => {
  const dir = await makeConfigRoot(defaultConfig());
  await assert.rejects(
    () => send(dir, [`To: "${OWNER_PERSONAL} Bcc":evil@attacker.com;`]),
    SendNotAllowedError
  );
});

test('a message with no parseable recipient is denied, not waved through', async () => {
  const dir = await makeConfigRoot(defaultConfig());
  await assert.rejects(
    () => send(dir, ['Subject: no recipient at all']),
    SendNotAllowedError
  );
});

test('the rejection names the offending address and says it is server-enforced', async () => {
  const dir = await makeConfigRoot(defaultConfig());
  await assert.rejects(
    () => send(dir, ['To: stranger@example.com']),
    (err) => {
      assert.ok(err instanceof SendNotAllowedError);
      assert.match(err.message, /stranger@example\.com/);
      // The spec requires the agent to explain the TOOL refused, not that it
      // chose to decline.
      assert.match(err.message, /enforced by the server/i);
      assert.match(err.message, /no send request reached Gmail/i);
      return true;
    }
  );
});

// --- audit trail ------------------------------------------------------------

test('rejected attempts are written to the audit log', async () => {
  const dir = await makeConfigRoot(defaultConfig());
  const auditLogPath = path.join(dir, 'audit.log');

  await assert.rejects(() => send(dir, ['To: stranger@example.com']));

  const log = await fs.readFile(auditLogPath, 'utf8');
  const entries = log.trim().split('\n').map((l) => JSON.parse(l));
  const denied = entries.find((e) => e.decision === 'DENIED');

  assert.ok(denied, 'a DENIED entry must exist');
  assert.ok(denied.rejected.includes('stranger@example.com'));
  assert.ok(denied.at, 'entries must be timestamped');
  assert.equal(denied.accountId, 'personal');
});

test('permitted sends are also recorded, so the trail is complete', async () => {
  const dir = await makeConfigRoot(defaultConfig());
  await send(dir, [`To: ${OWNER_PERSONAL}`]);

  const log = await fs.readFile(path.join(dir, 'audit.log'), 'utf8');
  const entries = log.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entries.at(-1).decision, 'ALLOWED');
});

test('an unwritable audit log does not turn a denial into an allow', async () => {
  const dir = await makeConfigRoot(defaultConfig());
  // Point the log at a path that cannot be created; the decision must stand.
  await assert.rejects(
    () =>
      assertSendAllowed({
        rawMessage: rawMessage(['To: stranger@example.com']),
        accountId: 'personal',
        configRoot: dir,
        auditLogPath: path.join(dir, 'no-such-dir', 'nested', 'audit.log'),
      }),
    SendNotAllowedError
  );
});
