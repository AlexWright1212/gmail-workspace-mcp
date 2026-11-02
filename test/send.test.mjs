// Tests for the send path: the allowlist choke point, send_draft's re-check of
// the draft's actual bytes, and Gmail-sourced signatures.
//
// Everything here runs against fakes. No test in this file may reach the real
// Gmail API, and the fakes record every call so a test can assert that NO send
// was attempted — "it threw" is not the same claim as "nothing left the box".

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GmailAccountClient } from '../dist/gmail-client.js';
import { SendNotAllowedError, AllowlistConfigError } from '../dist/allowlist.js';
import { buildRawMessage, htmlToPlainText } from '../dist/compose.js';

const OWNER = 'ownerpersonal@gmail.com';
const OWNER_TAMU = 'owner_school@tamu.edu';
const OUTSIDER = 'stranger@attacker.example';

const PERSONAL = { id: 'personal', email: OWNER, enabled: true };
const TAMU = { id: 'tamu', email: OWNER_TAMU, enabled: true };
const PATHS = { accountDir: '', credentialsPath: '', tokenPath: '', metaPath: '' };

async function makeConfigRoot(allowed = [OWNER, OWNER_TAMU]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'send-test-'));
  await fs.writeFile(
    path.join(dir, 'send-allowlist.json'),
    JSON.stringify({ allowed }, null, 2),
    'utf8'
  );
  return dir;
}

/** The constructor is TS-private only; runtime construction is fine. */
function makeClient(gmail, configRoot, account = PERSONAL) {
  return Reflect.construct(GmailAccountClient, [
    account, PATHS, gmail, {}, {}, {}, {}, configRoot,
  ]);
}

/**
 * A Gmail fake that records every call it receives.
 *
 * Faithfulness rules:
 *  - drafts.create stores the raw it was given and hands back an id.
 *  - drafts.get(format:'raw') returns whatever the store CURRENTLY holds, which
 *    is how a draft edited after creation is modelled.
 *  - drafts.send / messages.send record the attempt. A test that expects a
 *    refusal asserts these counters stayed at zero.
 */
function makeFakeGmail(options = {}) {
  const drafts = new Map(Object.entries(options.drafts ?? {}));
  const calls = {
    messagesSend: [],
    draftsSend: [],
    draftsCreate: [],
    draftsGet: [],
    sendAsList: 0,
  };
  let nextId = 1;

  const gmail = {
    calls,
    drafts,
    users: {
      settings: {
        sendAs: {
          list: async () => {
            calls.sendAsList += 1;
            if (options.sendAsError) throw options.sendAsError;
            return { data: { sendAs: options.sendAs ?? [] } };
          },
        },
      },
      drafts: {
        create: async ({ requestBody }) => {
          const id = `draft-${nextId++}`;
          calls.draftsCreate.push({ id, raw: requestBody.message.raw });
          drafts.set(id, requestBody.message.raw);
          return { data: { id, message: { id: `msg-${id}`, threadId: 'thread-1' } } };
        },
        get: async ({ id, format }) => {
          calls.draftsGet.push({ id, format });
          if (!drafts.has(id)) throw new Error(`no draft ${id}`);
          const raw = drafts.get(id);
          return {
            data: { id, message: raw === null ? {} : { id: `msg-${id}`, raw } },
          };
        },
        send: async ({ requestBody }) => {
          calls.draftsSend.push(requestBody);
          return { data: { id: 'sent-from-draft', threadId: 'thread-1' } };
        },
      },
      messages: {
        send: async ({ requestBody }) => {
          calls.messagesSend.push(requestBody);
          return { data: { id: 'sent-message', threadId: 'thread-2' } };
        },
      },
    },
  };
  return gmail;
}

// ── MIME helpers (self-contained; must not share a decoder with nodemailer) ──

function decodeQuotedPrintable(text) {
  const joined = text.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i += 1) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function rawToMime(raw) {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

/** Body of the first part declaring `contentType`, quoted-printable decoded. */
function partBody(mime, contentType) {
  const marker = mime.indexOf(`Content-Type: ${contentType}`);
  assert.notEqual(marker, -1, `no ${contentType} part found`);
  const blank = mime.indexOf('\r\n\r\n', marker);
  assert.notEqual(blank, -1, `no body for the ${contentType} part`);
  const rest = mime.slice(blank + 4);
  const end = rest.search(/\r\n--/);
  return decodeQuotedPrintable(end === -1 ? rest : rest.slice(0, end));
}

const SIGNATURE_HTML =
  '<div dir="ltr"><b>Alex Wright</b><br>' +
  '<a href="https://example.com/book">Book a call</a><br>' +
  'Tools &amp; Things</div>';

// ── The send gate ───────────────────────────────────────────────────────────

test('a non-allowlisted recipient is refused BEFORE any send call is made', async () => {
  const configRoot = await makeConfigRoot();
  const gmail = makeFakeGmail();
  const client = makeClient(gmail, configRoot);

  await assert.rejects(
    () =>
      client.sendEmail({
        to: OUTSIDER,
        subject: 'hello',
        body: 'hi',
        from: OWNER,
      }),
    (error) => {
      assert.ok(error instanceof SendNotAllowedError, `wrong error type: ${error}`);
      assert.match(error.message, /enforced by the server itself/);
      assert.match(error.message, /No message was sent/);
      return true;
    }
  );

  assert.deepEqual(gmail.calls.messagesSend, [], 'a send request reached Gmail');
  assert.deepEqual(gmail.calls.draftsSend, []);
});

test('a non-allowlisted BCC is refused even when To is allowlisted', async () => {
  const configRoot = await makeConfigRoot();
  const gmail = makeFakeGmail();
  const client = makeClient(gmail, configRoot);

  await assert.rejects(
    () =>
      client.sendEmail({
        to: OWNER,
        bcc: OUTSIDER,
        subject: 'hello',
        body: 'hi',
        from: OWNER,
      }),
    SendNotAllowedError
  );
  assert.deepEqual(gmail.calls.messagesSend, []);
});

test('an allowlisted recipient is sent, and the checked bytes are the sent bytes', async () => {
  const configRoot = await makeConfigRoot();
  const gmail = makeFakeGmail();
  const client = makeClient(gmail, configRoot);

  const result = await client.sendEmail({
    to: OWNER,
    subject: 'preview',
    body: 'one paragraph',
    from: OWNER,
  });

  assert.equal(result.messageId, 'sent-message');
  assert.equal(gmail.calls.messagesSend.length, 1);
  const mime = rawToMime(gmail.calls.messagesSend[0].raw);
  assert.match(mime, new RegExp(`^To: ${OWNER}`, 'm'));
});

test('a missing allowlist file fails closed — nothing is sent', async () => {
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'send-test-empty-'));
  const gmail = makeFakeGmail();
  const client = makeClient(gmail, configRoot);

  await assert.rejects(
    () => client.sendEmail({ to: OWNER, subject: 's', body: 'b', from: OWNER }),
    AllowlistConfigError
  );
  assert.deepEqual(gmail.calls.messagesSend, []);
});

// ── send_draft re-checks the draft's ACTUAL bytes ───────────────────────────

test('send_draft gates on the draft fetched now, not on what it was created with', async () => {
  const configRoot = await makeConfigRoot();
  const gmail = makeFakeGmail();
  const client = makeClient(gmail, configRoot);

  // Created against an allowlisted address...
  const created = await client.createDraft({
    to: OWNER,
    subject: 'looks fine',
    body: 'hello',
    from: OWNER,
  });
  assert.equal(gmail.calls.draftsCreate.length, 1);

  // ...then edited (in Gmail, or by anything else holding the credentials) to
  // point somewhere else entirely.
  const rewritten = await buildRawMessage({
    to: OUTSIDER,
    subject: 'looks fine',
    body: 'hello',
    from: OWNER,
  });
  gmail.drafts.set(created.draftId, rewritten);

  await assert.rejects(() => client.sendDraft(created.draftId), (error) => {
    assert.ok(error instanceof SendNotAllowedError);
    assert.match(error.message, new RegExp(OUTSIDER));
    return true;
  });

  assert.deepEqual(gmail.calls.draftsSend, [], 'the edited draft was sent anyway');
  assert.deepEqual(
    gmail.calls.draftsGet.map((call) => call.format),
    ['raw'],
    'the draft was not re-read as raw MIME'
  );
});

test('send_draft sends when the fetched draft bytes are allowlisted', async () => {
  const configRoot = await makeConfigRoot();
  const gmail = makeFakeGmail();
  const client = makeClient(gmail, configRoot);

  const created = await client.createDraft({
    to: OWNER_TAMU,
    subject: 'ok',
    body: 'hello',
    from: OWNER,
  });

  const result = await client.sendDraft(created.draftId);
  assert.equal(result.messageId, 'sent-from-draft');
  assert.deepEqual(gmail.calls.draftsSend, [{ id: created.draftId }]);
});

test('a draft Gmail returns without raw content is not sent', async () => {
  const configRoot = await makeConfigRoot();
  const gmail = makeFakeGmail();
  const client = makeClient(gmail, configRoot);
  gmail.drafts.set('draft-x', null);

  await assert.rejects(() => client.sendDraft('draft-x'), /could not be checked/);
  assert.deepEqual(gmail.calls.draftsSend, []);
});

test('creating a draft never touches a send endpoint', async () => {
  const configRoot = await makeConfigRoot();
  const gmail = makeFakeGmail();
  const client = makeClient(gmail, configRoot);

  // Drafts are not sends: a draft to anyone at all is allowed, which is exactly
  // why the gate must sit on the send and not on composition.
  await client.createDraft({ to: OUTSIDER, subject: 's', body: 'b', from: OWNER });
  assert.equal(gmail.calls.draftsCreate.length, 1);
  assert.deepEqual(gmail.calls.messagesSend, []);
  assert.deepEqual(gmail.calls.draftsSend, []);
});

// ── Signatures ──────────────────────────────────────────────────────────────

test('getSignature returns the signature configured for the account own address', async () => {
  const gmail = makeFakeGmail({
    sendAs: [
      { sendAsEmail: OWNER, isDefault: true, signature: SIGNATURE_HTML },
    ],
  });
  const client = makeClient(gmail, '/unused');

  const signature = await client.getSignature();
  assert.equal(signature.matchedAccountEmail, true);
  assert.equal(signature.sendAsEmail, OWNER);
  assert.equal(signature.isDefault, true);
  assert.equal(signature.signatureHtml, SIGNATURE_HTML);
});

test('an account with an EMPTY signature is a valid state, not an error', async () => {
  const gmail = makeFakeGmail({
    sendAs: [{ sendAsEmail: OWNER, isDefault: true, signature: '' }],
  });
  const client = makeClient(gmail, '/unused');

  const signature = await client.getSignature();
  assert.equal(signature.matchedAccountEmail, true);
  assert.equal(signature.signatureHtml, '');
});

test('a sendAs entry with no signature field at all reads as empty', async () => {
  const gmail = makeFakeGmail({ sendAs: [{ sendAsEmail: OWNER, isDefault: true }] });
  const client = makeClient(gmail, '/unused');
  assert.equal((await client.getSignature()).signatureHtml, '');
});

test('the default entry wins when the account has several sendAs rows for itself', async () => {
  const gmail = makeFakeGmail({
    sendAs: [
      { sendAsEmail: OWNER, isDefault: false, signature: '<div>secondary</div>' },
      { sendAsEmail: OWNER, isDefault: true, signature: '<div>primary</div>' },
    ],
  });
  const client = makeClient(gmail, '/unused');
  assert.equal((await client.getSignature()).signatureHtml, '<div>primary</div>');
});

test('another sendAs alias signature is NEVER substituted for the account own', async () => {
  const gmail = makeFakeGmail({
    sendAs: [
      { sendAsEmail: 'alias@example.com', isDefault: true, signature: '<div>alias sig</div>' },
    ],
  });
  const client = makeClient(gmail, '/unused');

  const signature = await client.getSignature();
  assert.equal(signature.matchedAccountEmail, false);
  assert.equal(signature.signatureHtml, '');
  assert.deepEqual(signature.availableSendAs, ['alias@example.com']);
});

test('no cross-account bleed: each account reads only its own Gmail settings', async () => {
  const personalGmail = makeFakeGmail({
    sendAs: [{ sendAsEmail: OWNER, isDefault: true, signature: '<div>personal sig</div>' }],
  });
  const tamuGmail = makeFakeGmail({
    sendAs: [{ sendAsEmail: OWNER_TAMU, isDefault: true, signature: '<div>tamu sig</div>' }],
  });

  const personal = makeClient(personalGmail, '/unused', PERSONAL);
  const tamu = makeClient(tamuGmail, '/unused', TAMU);

  assert.equal((await personal.getSignature()).signatureHtml, '<div>personal sig</div>');
  assert.equal((await tamu.getSignature()).signatureHtml, '<div>tamu sig</div>');
  // And again in the other order: nothing is memoized between accounts.
  assert.equal((await tamu.getSignature()).signatureHtml, '<div>tamu sig</div>');
  assert.equal((await personal.getSignature()).signatureHtml, '<div>personal sig</div>');
});

test('the signature is re-read from Gmail on every message — nothing is cached', async () => {
  const gmail = makeFakeGmail({
    sendAs: [{ sendAsEmail: OWNER, isDefault: true, signature: SIGNATURE_HTML }],
  });
  const client = makeClient(gmail, '/unused');

  await client.getSignature();
  await client.getSignature();
  assert.equal(gmail.calls.sendAsList, 2);
});

test('include_signature puts the signature in BOTH MIME parts', async () => {
  const configRoot = await makeConfigRoot();
  const gmail = makeFakeGmail({
    sendAs: [{ sendAsEmail: OWNER, isDefault: true, signature: SIGNATURE_HTML }],
  });
  const client = makeClient(gmail, configRoot);

  await client.createDraft({
    to: OWNER,
    subject: 'with signature',
    body: 'Body paragraph.',
    from: OWNER,
    includeSignature: true,
  });

  const mime = rawToMime(gmail.calls.draftsCreate[0].raw);
  const html = partBody(mime, 'text/html');
  const text = partBody(mime, 'text/plain');

  // The html part carries the owner's markup verbatim.
  assert.ok(html.includes(SIGNATURE_HTML), `html part missing the signature:\n${html}`);
  assert.ok(html.includes('Body paragraph.'));

  // The text part carries the SAME information, derived — including the link
  // target, which is the bit a naive tag-strip would silently drop.
  assert.ok(text.includes('Body paragraph.'));
  assert.ok(text.includes('Alex Wright'), `text part missing the signature:\n${text}`);
  assert.ok(text.includes('https://example.com/book'), `text part lost the link URL:\n${text}`);
  assert.ok(text.includes('Tools & Things'), `text part did not decode entities:\n${text}`);
  // ...and the raw markup must NOT appear in the plain-text part.
  assert.ok(!text.includes('<div'), `raw HTML leaked into the text part:\n${text}`);
  assert.ok(!text.includes('&amp;'));
});

test('include_signature on an account with no signature changes nothing', async () => {
  const configRoot = await makeConfigRoot();
  const withoutSig = makeFakeGmail({
    sendAs: [{ sendAsEmail: OWNER, isDefault: true, signature: '' }],
  });
  const client = makeClient(withoutSig, configRoot);

  await client.createDraft({
    to: OWNER, subject: 's', body: 'Body paragraph.', from: OWNER, includeSignature: true,
  });
  await client.createDraft({
    to: OWNER, subject: 's', body: 'Body paragraph.', from: OWNER,
  });

  const withFlag = rawToMime(withoutSig.calls.draftsCreate[0].raw);
  const without = rawToMime(withoutSig.calls.draftsCreate[1].raw);
  assert.equal(partBody(withFlag, 'text/html'), partBody(without, 'text/html'));
  assert.equal(partBody(withFlag, 'text/plain'), partBody(without, 'text/plain'));
});

test('a signed message still passes through the same send gate', async () => {
  const configRoot = await makeConfigRoot();
  const gmail = makeFakeGmail({
    sendAs: [{ sendAsEmail: OWNER, isDefault: true, signature: SIGNATURE_HTML }],
  });
  const client = makeClient(gmail, configRoot);

  await assert.rejects(
    () =>
      client.sendEmail({
        to: OUTSIDER, subject: 's', body: 'b', from: OWNER, includeSignature: true,
      }),
    SendNotAllowedError
  );
  assert.deepEqual(gmail.calls.messagesSend, []);
});

// ── htmlToPlainText ─────────────────────────────────────────────────────────

test('htmlToPlainText keeps link targets and decodes entities', () => {
  assert.equal(
    htmlToPlainText('<p>Hi <a href="https://x.test/a?b=1&amp;c=2">click</a></p>'),
    'Hi click (https://x.test/a?b=1&c=2)'
  );
});

test('htmlToPlainText does not repeat a URL that is already its own link text', () => {
  assert.equal(
    htmlToPlainText('<a href="https://x.test/a">https://x.test/a</a>'),
    'https://x.test/a'
  );
  assert.equal(
    htmlToPlainText('<a href="mailto:me@x.test">me@x.test</a>'),
    'me@x.test'
  );
});

test('htmlToPlainText turns block structure into line breaks', () => {
  assert.equal(
    htmlToPlainText('<div>Alex</div><div>Engineer</div>'),
    'Alex\nEngineer'
  );
  assert.equal(htmlToPlainText('one<br>two'), 'one\ntwo');
});

test('htmlToPlainText drops style/script content and keeps image alt text', () => {
  assert.equal(htmlToPlainText('<style>p{color:red}</style><p>Hi</p>'), 'Hi');
  assert.equal(htmlToPlainText('<img src="logo.png" alt="ACME"> Corp'), 'ACME Corp');
});

test('htmlToPlainText keeps a Gmail-shaped signature single-spaced', () => {
  // Gmail writes one <div> per line and a blank line as <div><br></div>.
  const gmailShaped =
    '<div dir="ltr"><div>Alex Wright</div><div>Engineer</div>' +
    '<div><br></div><div>alex@example.com</div></div>';
  assert.equal(
    htmlToPlainText(gmailShaped),
    'Alex Wright\nEngineer\n\nalex@example.com'
  );
});

test('the signature is wrapped the way Gmail wraps its own', async () => {
  const configRoot = await makeConfigRoot();
  const gmail = makeFakeGmail({
    sendAs: [{ sendAsEmail: OWNER, isDefault: true, signature: SIGNATURE_HTML }],
  });
  const client = makeClient(gmail, configRoot);

  await client.createDraft({
    to: OWNER, subject: 's', body: 'b', from: OWNER, includeSignature: true,
  });
  const html = partBody(rawToMime(gmail.calls.draftsCreate[0].raw), 'text/html');

  // These markers are Gmail's own; they are the only lever available for
  // telling Gmail's compose UI that this draft already carries a signature.
  // Whether they actually prevent duplication is a REAL-SEND question.
  assert.ok(html.includes('class="gmail_signature"'));
  assert.ok(html.includes('data-smartmail="gmail_signature"'));
});

test('htmlToPlainText decodes numeric entities and non-breaking spaces', () => {
  assert.equal(htmlToPlainText('a&nbsp;b &#8212; c &#x2014; d'), 'a b — c — d');
});

// ── Structural checks on the compiled output ────────────────────────────────
//
// The single-choke-point property is a property of the whole file, not of any
// one call, so it is asserted against the built JavaScript. A future send added
// somewhere else fails here even if every behavioural test still passes.

async function readDist(file) {
  return fs.readFile(new URL(`../dist/${file}`, import.meta.url), 'utf8');
}

test('every Gmail send call in the codebase lives inside deliver()', async () => {
  const source = await readDist('gmail-client.js');

  const deliverStart = source.indexOf('async deliver(');
  assert.notEqual(deliverStart, -1, 'deliver() is gone — the choke point moved');
  // deliver() ends where the next method begins.
  const deliverEnd = source.indexOf('\n    async createDraft(', deliverStart);
  assert.notEqual(deliverEnd, -1);
  const deliverBody = source.slice(deliverStart, deliverEnd);

  assert.ok(
    deliverBody.includes('assertSendAllowed('),
    'deliver() no longer calls the allowlist gate'
  );
  assert.ok(deliverBody.includes('users.messages.send('));
  assert.ok(deliverBody.includes('users.drafts.send('));

  for (const file of ['gmail-client.js', 'index.js', 'compose.js', 'allowlist.js']) {
    const text = await readDist(file);
    const matches = [...text.matchAll(/users\.(?:messages|drafts)\.send\(/g)];
    const outside = matches.filter(
      (match) =>
        file !== 'gmail-client.js' ||
        match.index < deliverStart ||
        match.index >= deliverEnd
    );
    assert.deepEqual(
      outside.map((match) => `${file}@${match.index}`),
      [],
      `a Gmail send call sits outside deliver() in ${file}`
    );
  }
});

test('no tool argument can reach the trusted signature HTML channel', async () => {
  const client = await readDist('gmail-client.js');
  const index = await readDist('index.js');

  // compose's signatureHtml is set in exactly one place, from one source.
  const assignments = [...client.matchAll(/signatureHtml[,:]/g)];
  assert.ok(assignments.length > 0);
  assert.ok(
    client.includes('input.includeSignature\n') ||
      client.includes('input.includeSignature'),
    'includeSignature is no longer the gate on fetching the signature'
  );
  // No handler may read a signature/html blob out of tool arguments.
  assert.ok(!/rawArgs\.signature/i.test(index), 'a tool argument feeds the signature channel');
  assert.ok(!/rawArgs\.html/i.test(index), 'a tool argument feeds raw HTML into compose');
});
