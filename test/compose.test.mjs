import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildMimeMessage, buildRawMessage } from '../dist/compose.js';

// ---------------------------------------------------------------------------
// A small, self-contained MIME parser.
//
// Deliberately hand-written rather than borrowed from nodemailer's sibling
// packages: these tests exist to check nodemailer's output, so they must not
// share a decoder (and therefore a potential shared bug) with it.
// ---------------------------------------------------------------------------

function unfold(headerBlock) {
  return headerBlock.replace(/\r\n[ \t]+/g, ' ');
}

/** Parse a header block into a lowercase-keyed map of arrays. */
function parseHeaders(headerBlock) {
  const headers = new Map();
  if (headerBlock.trim() === '') return headers;
  for (const line of unfold(headerBlock).split('\r\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!headers.has(name)) headers.set(name, []);
    headers.get(name).push(value);
  }
  return headers;
}

/** Split raw message/part text into its header block and body. */
function splitEntity(raw) {
  const separator = raw.indexOf('\r\n\r\n');
  if (separator === -1) return { headers: parseHeaders(raw), body: '' };
  return {
    headers: parseHeaders(raw.slice(0, separator)),
    body: raw.slice(separator + 4),
  };
}

function parseContentType(value = 'text/plain') {
  const segments = value.split(';');
  const type = segments.shift().trim().toLowerCase();
  const params = {};
  for (const segment of segments) {
    const index = segment.indexOf('=');
    if (index === -1) continue;
    const key = segment.slice(0, index).trim().toLowerCase();
    let raw = segment.slice(index + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    params[key] = raw;
  }
  return { type, params };
}

/** Split a multipart body on its boundary delimiters. */
function splitMultipart(body, boundary) {
  const open = `--${boundary}`;
  const close = `--${boundary}--`;
  const parts = [];
  let current = null;

  for (const line of body.split('\r\n')) {
    if (line === close) {
      if (current) parts.push(current.join('\r\n'));
      current = null;
      break;
    }
    if (line === open) {
      if (current) parts.push(current.join('\r\n'));
      current = [];
      continue;
    }
    if (current) current.push(line);
  }

  return parts;
}

function decodeQuotedPrintable(input) {
  const joined = input.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i += 1) {
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(headers, body) {
  const encoding = (headers.get('content-transfer-encoding')?.[0] ?? '7bit').toLowerCase();
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  if (encoding === 'base64') return Buffer.from(body.replace(/\r\n/g, ''), 'base64');
  return Buffer.from(body, 'utf8');
}

/** RFC 2047 decoding. Encoded words are decoded to bytes, then concatenated,
 *  so a multi-byte character split across two words still round-trips. */
function decodeEncodedWords(value) {
  const collapsed = value.replace(/\?=\s+=\?/g, '?==?');
  const pattern = /=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g;
  const chunks = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(collapsed)) !== null) {
    if (match.index > last) chunks.push(Buffer.from(collapsed.slice(last, match.index), 'utf8'));
    const [, , encoding, text] = match;
    chunks.push(
      encoding.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : decodeQuotedPrintable(text.replace(/_/g, ' '))
    );
    last = match.index + match[0].length;
  }
  chunks.push(Buffer.from(collapsed.slice(last), 'utf8'));
  return Buffer.concat(chunks).toString('utf8');
}

/** Flatten a message into a list of leaf parts: {type, headers, rawBody, text}. */
function flatten(entity) {
  const { type, params } = parseContentType(entity.headers.get('content-type')?.[0]);
  if (type.startsWith('multipart/')) {
    return splitMultipart(entity.body, params.boundary).flatMap((raw) =>
      flatten(splitEntity(raw))
    );
  }
  return [
    {
      type,
      params,
      headers: entity.headers,
      rawBody: entity.body,
      content: decodeBody(entity.headers, entity.body),
    },
  ];
}

async function parseMessage(input) {
  const raw = (await buildMimeMessage(input)).toString('utf8');
  const entity = splitEntity(raw);
  return {
    raw,
    headers: entity.headers,
    contentType: parseContentType(entity.headers.get('content-type')?.[0]),
    parts: flatten(entity),
    header(name) {
      return entity.headers.get(name.toLowerCase())?.[0];
    },
    part(type) {
      const matches = flatten(entity).filter((p) => p.type === type);
      assert.equal(matches.length, 1, `expected exactly one ${type} part, got ${matches.length}`);
      return matches[0];
    },
  };
}

// A single logical paragraph well past 700 characters and past every plausible
// wrap width. This is the shape that used to arrive hard-wrapped.
const LONG_PARAGRAPH =
  'This first paragraph has to stay a single unbroken block of text after the ' +
  'message is actually delivered, no matter how long it runs on for, because the ' +
  'entire bug this module exists to prevent was a plain-text draft that looked ' +
  'like one flowing paragraph while it was being edited and then arrived chopped ' +
  'into a dozen short hard-wrapped lines once it had gone through the delivery ' +
  'pipeline. The only legal way for a line this long to survive the 78 character ' +
  'limit is a transfer encoding that provides soft line breaks, which is exactly ' +
  'what quoted-printable does, so this sentence keeps going and going in order to ' +
  'guarantee that several of those soft breaks are actually exercised by the test, ' +
  'and that nothing anywhere in the pipeline decides to insert a real newline.';

const BASE = {
  to: 'Alex Wright <12alex12wright12@gmail.com>',
  from: 'Alex Wright <12alex12wright12@gmail.com>',
  subject: 'Composer structure test',
};

test('LONG_PARAGRAPH fixture really is over 700 characters and unbroken', () => {
  assert.ok(LONG_PARAGRAPH.length > 700, `fixture is only ${LONG_PARAGRAPH.length} chars`);
  assert.ok(!/[\r\n]/.test(LONG_PARAGRAPH), 'fixture must be a single line');
});

test('always multipart/alternative with exactly one text/plain and one text/html', async () => {
  const message = await parseMessage({ ...BASE, body: 'Just one short line.' });

  assert.equal(message.contentType.type, 'multipart/alternative');
  assert.ok(message.contentType.params.boundary, 'boundary parameter present');
  assert.equal(message.header('mime-version'), '1.0');

  const types = message.parts.map((part) => part.type);
  assert.deepEqual(types, ['text/plain', 'text/html']);
  assert.equal(types.filter((t) => t === 'text/plain').length, 1);
  assert.equal(types.filter((t) => t === 'text/html').length, 1);
});

test('a single-form body still produces both parts (no single-part message)', async () => {
  // The caller supplies one string; both representations are derived from it.
  const message = await parseMessage({ ...BASE, body: 'only plain text here' });
  assert.equal(message.part('text/plain').content.toString('utf8'), 'only plain text here');
  assert.match(message.part('text/html').content.toString('utf8'), /<p>only plain text here<\/p>/);
});

test('REGRESSION: a 700+ char paragraph survives as one unbroken line in text/plain', async () => {
  const message = await parseMessage({ ...BASE, body: LONG_PARAGRAPH });
  const plain = message.part('text/plain');

  // The raw part must be quoted-printable and must actually use soft breaks —
  // otherwise the test would pass for the wrong reason.
  assert.equal(plain.headers.get('content-transfer-encoding')[0], 'quoted-printable');
  assert.ok(/=\r\n/.test(plain.rawBody), 'raw text part uses quoted-printable soft breaks');
  assert.ok(plain.rawBody.split('\r\n').length > 5, 'raw part really is wrapped across lines');

  // Once the soft breaks are decoded, the paragraph is a single line again.
  const decoded = plain.content.toString('utf8');
  assert.equal(decoded, LONG_PARAGRAPH);
  assert.ok(!decoded.includes('\r'), 'no CR inside the decoded paragraph');
  assert.ok(!decoded.includes('\n'), 'no LF inside the decoded paragraph');
  assert.equal(decoded.split(/\r?\n/).length, 1, 'decoded paragraph is exactly one line');
});

test('REGRESSION: the long paragraph is a single <p> in the html part', async () => {
  const message = await parseMessage({ ...BASE, body: LONG_PARAGRAPH });
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(html, `<div dir="ltr"><p>${LONG_PARAGRAPH}</p></div>`);
});

test('every raw line of the generated message is 78 characters or fewer', async () => {
  const message = await parseMessage({
    ...BASE,
    subject: 'A rather long subject line with an em dash — and an emoji 🎉 to force encoding',
    cc: 'someone.with.a.long.address@example-domain-that-is-long.com',
    references:
      '<aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@mail.gmail.com> <bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@mail.gmail.com>',
    body: `${LONG_PARAGRAPH}\n\n- ${LONG_PARAGRAPH}\n\nShort tail.`,
  });

  // Byte length, not `line.length`: the RFC 5322 limit counts octets, and a
  // UTF-16 length check silently misses a line that only overflows once encoded.
  const lines = message.raw.split('\r\n');
  const offenders = lines.filter((line) => Buffer.byteLength(line, 'utf8') > 78);
  assert.deepEqual(offenders, [], `lines over 78 chars: ${JSON.stringify(offenders.slice(0, 3))}`);

  // And no bare LF anywhere: a lone \n is not a legal MIME line ending and
  // slips past quoted-printable wrapping.
  assert.ok(!/[^\r]\n/.test(message.raw), 'no bare LF line endings');
});

test('multi-paragraph input yields distinct <p> elements and blank-line-separated text', async () => {
  const body = ['First paragraph.', '', 'Second paragraph.', '', 'Third paragraph.'].join('\n');
  const message = await parseMessage({ ...BASE, body });

  const html = message.part('text/html').content.toString('utf8');
  const paragraphs = html.match(/<p>.*?<\/p>/g);
  assert.equal(paragraphs.length, 3);
  assert.deepEqual(paragraphs, [
    '<p>First paragraph.</p>',
    '<p>Second paragraph.</p>',
    '<p>Third paragraph.</p>',
  ]);

  const text = message.part('text/plain').content.toString('utf8');
  assert.equal(text, 'First paragraph.\r\n\r\nSecond paragraph.\r\n\r\nThird paragraph.');
  assert.equal(text.split('\r\n\r\n').length, 3, 'three blank-line-separated blocks');
});

test('a single newline inside a paragraph becomes <br>, not a new paragraph', async () => {
  const message = await parseMessage({ ...BASE, body: 'Best,\nAlex' });
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(html, '<div dir="ltr"><p>Best,<br>Alex</p></div>');
  assert.equal(message.part('text/plain').content.toString('utf8'), 'Best,\r\nAlex');
});

test('bullet lists become <ul>/<li> in html and stay verbatim in text', async () => {
  const body = ['Intro line.', '', '- First bullet', '- Second bullet'].join('\n');
  const message = await parseMessage({ ...BASE, body });

  const html = message.part('text/html').content.toString('utf8');
  assert.equal(
    html,
    '<div dir="ltr"><p>Intro line.</p><ul><li>First bullet</li><li>Second bullet</li></ul></div>'
  );

  const text = message.part('text/plain').content.toString('utf8');
  assert.ok(text.includes('- First bullet\r\n- Second bullet'), text);
});

test('numbered lists become <ol>/<li>', async () => {
  const message = await parseMessage({ ...BASE, body: '1. one\n2. two' });
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(html, '<div dir="ltr"><ol><li>one</li><li>two</li></ol></div>');
});

test('"a < b && c > d" round-trips as literal text in both parts', async () => {
  const body = 'a < b && c > d';
  const message = await parseMessage({ ...BASE, body });

  // Plain text: exactly what was typed, no escaping.
  assert.equal(message.part('text/plain').content.toString('utf8'), 'a < b && c > d');

  // HTML: escaped so it renders literally rather than being read as markup.
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(html, '<div dir="ltr"><p>a &lt; b &amp;&amp; c &gt; d</p></div>');
  assert.ok(!/<p>a < b/.test(html), 'raw < was not left unescaped');
});

test('html-looking body content is escaped, not emitted as markup', async () => {
  const body = 'Use <script>alert("x")</script> & the O\'Brien "quote" test.';
  const message = await parseMessage({ ...BASE, body });

  assert.equal(message.part('text/plain').content.toString('utf8'), body);

  const html = message.part('text/html').content.toString('utf8');
  assert.ok(!html.includes('<script>'), 'no live script tag');
  assert.ok(html.includes('&lt;script&gt;'), 'script tag escaped');
  assert.ok(html.includes('&amp;'), 'ampersand escaped');
  assert.ok(html.includes('&quot;'), 'double quote escaped');
  assert.ok(html.includes('&#39;'), 'single quote escaped');
});

test('non-ASCII subject is RFC 2047 encoded exactly once and decodes back', async () => {
  const subject = 'Formatting test — em dash, café, and an emoji 🎉';
  const message = await parseMessage({ ...BASE, subject, body: 'body' });

  const rawSubject = message.header('subject');
  assert.ok(rawSubject.includes('=?UTF-8?'), `expected encoded words, got: ${rawSubject}`);
  assert.ok(!/[^\x00-\x7F]/.test(rawSubject), 'encoded header is pure ASCII on the wire');

  const decoded = decodeEncodedWords(rawSubject);
  assert.equal(decoded, subject);

  // Double-encoding leaves literal "=?UTF-8?" text behind after one decode pass.
  assert.ok(!decoded.includes('=?'), `subject was double-encoded: ${decoded}`);
  assert.equal(decodeEncodedWords(decoded), decoded, 'decoding twice is a no-op');
});

test('plain ASCII subject is left alone', async () => {
  const message = await parseMessage({ ...BASE, subject: 'Plain subject', body: 'body' });
  assert.equal(message.header('subject'), 'Plain subject');
});

test('In-Reply-To and References appear verbatim when supplied', async () => {
  const inReplyTo = '<CAE9fCqJtE58q@mail.gmail.com>';
  const references = '<one@mail.gmail.com> <two@mail.gmail.com> <CAE9fCqJtE58q@mail.gmail.com>';
  const message = await parseMessage({ ...BASE, body: 'reply body', inReplyTo, references });

  assert.equal(message.header('in-reply-to'), inReplyTo);
  assert.equal(message.header('references'), references);
});

test('threading headers are absent when not supplied', async () => {
  const message = await parseMessage({ ...BASE, body: 'new thread' });
  assert.equal(message.header('in-reply-to'), undefined);
  assert.equal(message.header('references'), undefined);
});

test('Cc and Bcc headers are preserved (Gmail raw upload needs Bcc in the message)', async () => {
  const message = await parseMessage({
    ...BASE,
    body: 'body',
    cc: 'cc-one@example.com,  cc-two@example.com ',
    bcc: 'blind@example.com',
  });

  assert.equal(message.header('cc'), 'cc-one@example.com, cc-two@example.com');
  assert.equal(message.header('bcc'), 'blind@example.com');
});

test('an attachment produces a correct base64 part alongside the alternative body', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-test-'));
  const file = path.join(dir, 'report.pdf');
  const bytes = Buffer.from('%PDF-1.4\n binary-ish  ÿ payload');
  await fs.writeFile(file, bytes);

  const message = await parseMessage({
    ...BASE,
    body: LONG_PARAGRAPH,
    attachments: [{ path: file }],
  });

  assert.equal(message.contentType.type, 'multipart/mixed');

  // The alternative pair survives inside the mixed container.
  const types = message.parts.map((part) => part.type);
  assert.equal(types.filter((t) => t === 'text/plain').length, 1);
  assert.equal(types.filter((t) => t === 'text/html').length, 1);
  assert.equal(message.part('text/plain').content.toString('utf8'), LONG_PARAGRAPH);

  const attachment = message.parts.find((part) => part.type === 'application/pdf');
  assert.ok(attachment, `no application/pdf part; got ${types.join(', ')}`);
  assert.equal(attachment.headers.get('content-transfer-encoding')[0], 'base64');
  assert.match(attachment.headers.get('content-disposition')[0], /attachment/);
  assert.match(attachment.headers.get('content-disposition')[0], /report\.pdf/);
  assert.ok(attachment.content.equals(bytes), 'attachment bytes round-trip exactly');
  assert.ok(attachment.content.length > 0, 'attachment is not silently empty');
});

test('an explicit filename and content type override the defaults', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-test-'));
  const file = path.join(dir, 'raw.bin');
  await fs.writeFile(file, Buffer.from('hello'));

  const message = await parseMessage({
    ...BASE,
    body: 'body',
    attachments: [{ path: file, filename: 'notes.txt', contentType: 'text/plain' }],
  });

  const attachment = message.parts.find(
    (part) => part.headers.get('content-disposition')?.[0]?.includes('attachment')
  );
  assert.ok(attachment, 'attachment part present');
  assert.match(attachment.headers.get('content-disposition')[0], /notes\.txt/);
  assert.equal(attachment.content.toString('utf8'), 'hello');
});

test('a missing attachment path fails loudly instead of attaching nothing', async () => {
  const missing = path.join(os.tmpdir(), 'definitely-not-here-9f2c1a', 'nope.pdf');
  await assert.rejects(
    () => buildMimeMessage({ ...BASE, body: 'body', attachments: [{ path: missing }] }),
    (error) => {
      assert.match(error.message, /Attachment could not be read/);
      assert.ok(error.message.includes(missing), 'error names the offending path');
      assert.match(error.message, /ENOENT/);
      return true;
    }
  );
});

test('an unreadable directory path fails loudly too', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-test-'));
  await assert.rejects(
    () => buildMimeMessage({ ...BASE, body: 'body', attachments: [{ path: dir }] }),
    /Attachment could not be read/
  );
});

test('a missing recipient is rejected before anything is built', async () => {
  await assert.rejects(
    () => buildMimeMessage({ ...BASE, to: '   ', body: 'body' }),
    /Recipient "to" is required/
  );
});

test('body content cannot inject headers through the subject', async () => {
  const message = await parseMessage({
    ...BASE,
    subject: 'Hello\r\nBcc: attacker@example.com',
    body: 'body',
  });
  assert.equal(message.header('bcc'), undefined);
  assert.ok(message.header('subject').includes('Hello'));
});

test('buildRawMessage returns base64url with no padding and decodes to the MIME', async () => {
  const raw = await buildRawMessage({ ...BASE, body: 'round trip' });
  assert.ok(!/[+/=]/.test(raw), 'base64url alphabet only, unpadded');

  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.ok(decoded.startsWith('From: '), decoded.slice(0, 40));
  assert.ok(decoded.includes('Content-Type: multipart/alternative'));
  assert.ok(decoded.includes('round trip'));
});

test('an empty body still produces both alternative parts', async () => {
  const message = await parseMessage({ ...BASE, body: '' });
  assert.equal(message.contentType.type, 'multipart/alternative');
  assert.deepEqual(
    message.parts.map((part) => part.type),
    ['text/plain', 'text/html']
  );
});

// ---------------------------------------------------------------------------
// Address fields.
//
// Folding CRLF to a space is not enough: the colon survives, and RFC 5322 group
// syntax then turns "victim@x.com\r\nBcc: evil@y.com" into a group NAMED after
// the victim whose only mailbox is the attacker. Gmail's raw upload derives the
// envelope from these headers, so that is a real recipient swap.
// ---------------------------------------------------------------------------

const INJECTED = {
  to: 'alex@gmail.com\r\nBcc: evil@attacker.com',
  cc: 'c@d.com\r\nX-Evil: 1',
  bcc: 'b@d.com\r\nX-Evil: 1',
  from: 'me@x.com\r\nBcc: e@evil.com',
};

for (const field of ['to', 'cc', 'bcc', 'from']) {
  test(`SECURITY: CRLF injection through "${field}" is rejected, not mangled`, async () => {
    await assert.rejects(
      () => buildMimeMessage({ ...BASE, body: 'body', [field]: INJECTED[field] }),
      (error) => {
        assert.match(error.message, new RegExp(`Invalid "${field}" address`), error.message);
        assert.match(error.message, /line break/);
        return true;
      }
    );
  });
}

test('SECURITY: no injected address ever reaches a header', async () => {
  // Belt and braces: even if a future change let one of these build, the
  // attacker address must not appear anywhere in the message.
  for (const field of ['to', 'cc', 'bcc', 'from']) {
    let raw = '';
    try {
      raw = (await buildMimeMessage({ ...BASE, body: 'body', [field]: INJECTED[field] })).toString(
        'utf8'
      );
    } catch {
      continue; // rejected, which is the expected outcome
    }
    assert.ok(!raw.includes('attacker.com'), `${field}: attacker address leaked into the message`);
    assert.ok(!raw.includes('evil.com'), `${field}: attacker address leaked into the message`);
  }
});

test('SECURITY: explicit RFC 5322 group syntax is rejected in every address field', async () => {
  for (const field of ['to', 'cc', 'bcc', 'from']) {
    await assert.rejects(
      () =>
        buildMimeMessage({ ...BASE, body: 'body', [field]: 'friends: a@b.com, evil@attacker.com;' }),
      (error) => {
        assert.match(error.message, new RegExp(`Invalid "${field}" address`), error.message);
        assert.match(error.message, /group syntax/);
        return true;
      }
    );
  }
});

test('SECURITY: a colon outside angle brackets is rejected', async () => {
  await assert.rejects(
    () => buildMimeMessage({ ...BASE, body: 'body', to: '"alex@gmail.com Bcc":evil@attacker.com;' }),
    /Invalid "to" address/
  );
});

test('SECURITY: an address used as a display name is rejected as ambiguous', async () => {
  // "victim@x.com attacker@y.com" parses as ONE mailbox — the attacker's — with
  // the victim demoted to a display name. Same substitution, no CRLF needed.
  await assert.rejects(
    () => buildMimeMessage({ ...BASE, body: 'body', to: 'victim@example.com attacker@evil.com' }),
    /Invalid "to" address/
  );
});

for (const value of ['not-an-email-at-all', 'Alex Wright', 'plain text, real@x.com', '@x.com']) {
  test(`REGRESSION: ${JSON.stringify(value)} fails loudly instead of producing no To header`, async () => {
    await assert.rejects(
      () => buildMimeMessage({ ...BASE, body: 'body', to: value }),
      (error) => {
        assert.match(error.message, /Invalid "to" address/, error.message);
        assert.ok(error.message.includes(value), 'error names the offending value');
        return true;
      }
    );
  });
}

test('REGRESSION: a message is never built with a missing To header', async () => {
  for (const value of ['not-an-email-at-all', 'Alex Wright', '@x.com', 'a@', 'a@b']) {
    let built = null;
    try {
      built = await buildMimeMessage({ ...BASE, body: 'body', to: value });
    } catch {
      continue;
    }
    const message = splitEntity(built.toString('utf8'));
    assert.ok(
      message.headers.get('to'),
      `to=${JSON.stringify(value)} built a message with no To header`
    );
  }
});

test('an invalid cc or bcc is rejected rather than silently dropped', async () => {
  await assert.rejects(
    () => buildMimeMessage({ ...BASE, body: 'body', cc: 'nope' }),
    /Invalid "cc" address/
  );
  await assert.rejects(
    () => buildMimeMessage({ ...BASE, body: 'body', bcc: 'a@b.com, nope' }),
    /Invalid "bcc" address/
  );
});

test('a second From address is rejected', async () => {
  await assert.rejects(
    () => buildMimeMessage({ ...BASE, body: 'body', from: 'me@x.com, other@evil.com' }),
    /Invalid "from" address/
  );
});

test('valid address forms still work', async () => {
  const message = await parseMessage({
    ...BASE,
    body: 'body',
    to: 'Alex Wright <a@b.com>, c@d.com',
    cc: 'e@f.com',
    bcc: 'g@h.com',
    from: 'me@x.com',
  });
  assert.equal(message.header('to'), 'Alex Wright <a@b.com>, c@d.com');
  assert.equal(message.header('cc'), 'e@f.com');
  assert.equal(message.header('bcc'), 'g@h.com');
  assert.equal(message.header('from'), 'me@x.com');
});

test('an internationalized domain still resolves to punycode', async () => {
  const message = await parseMessage({ ...BASE, body: 'body', to: 'user@exämple.com' });
  assert.equal(message.header('to'), 'user@xn--exmple-cua.com');
});

// ---------------------------------------------------------------------------
// Renderer: content must never disappear from the HTML part.
// ---------------------------------------------------------------------------

/** Strip tags and decode the entities escapeHtml produces. */
function htmlToText(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

test('REGRESSION: prose starting with a number is not eaten by the ordered-list rule', async () => {
  for (const body of ['1984. It was a cold day in Texas.', '2024. What a year.', '5) Done.']) {
    const message = await parseMessage({ ...BASE, body });
    const html = message.part('text/html').content.toString('utf8');
    assert.equal(html, `<div dir="ltr"><p>${body}</p></div>`);
    assert.equal(message.part('text/plain').content.toString('utf8'), body);
  }
});

test('an ordered list keeps the author\'s starting number', async () => {
  const message = await parseMessage({ ...BASE, body: '5. five\n6. six' });
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(html, '<div dir="ltr"><ol start="5"><li>five</li><li>six</li></ol></div>');
});

test('a nested bullet renders as a nested list, not a flattened sibling', async () => {
  const message = await parseMessage({ ...BASE, body: '- outer\n  - nested detail\n- second' });
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(
    html,
    '<div dir="ltr"><ul><li>outer<ul><li>nested detail</li></ul></li><li>second</li></ul></div>'
  );
});

test('REGRESSION: a list that dedents below its first item keeps every item', async () => {
  // Found by fuzzing: building the list from the FIRST item's indent made the
  // builder stop dead at the first shallower line and silently drop the rest.
  const message = await parseMessage({ ...BASE, body: '  - deep first\n- shallow second' });
  const html = message.part('text/html').content.toString('utf8');
  assert.ok(html.includes('deep first'), html);
  assert.ok(html.includes('shallow second'), html);
});

test('REGRESSION: a list followed by a sentence stays a list', async () => {
  const message = await parseMessage({ ...BASE, body: '- a\n- b\nSee you.' });
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(html, '<div dir="ltr"><ul><li>a</li><li>b</li></ul><p>See you.</p></div>');
  assert.equal(message.part('text/plain').content.toString('utf8'), '- a\r\n- b\r\nSee you.');
});

test('a sentence followed by a list also splits correctly', async () => {
  const message = await parseMessage({ ...BASE, body: 'Here goes:\n- a\n- b' });
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(html, '<div dir="ltr"><p>Here goes:</p><ul><li>a</li><li>b</li></ul></div>');
});

test('REGRESSION: an indented block keeps its indentation in the html part', async () => {
  const message = await parseMessage({ ...BASE, body: 'Run:\n\n    npm install' });
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(html, '<div dir="ltr"><p>Run:</p><p>&nbsp;&nbsp;&nbsp;&nbsp;npm install</p></div>');
  assert.equal(htmlToText(html).includes('    npm install'), true);
});

test('every non-markup character of the body survives into the html part', async () => {
  const body = [
    '1984. It was a cold day in Texas.',
    '',
    '- outer bullet',
    '  - nested detail',
    '- second bullet',
    'See you.',
    '',
    'Run:',
    '',
    '    npm install --save',
    '',
    'Costs 5 & 6 < 7 > 4, "quoted", it\'s fine.',
  ].join('\n');

  const message = await parseMessage({ ...BASE, body });
  const html = message.part('text/html').content.toString('utf8');
  const rendered = htmlToText(html).replace(/\s+/g, '');

  // Only the list markers themselves are markup; everything else must survive.
  const expected = body
    .split('\n')
    .map((line) => line.replace(/^\s*[-*+]\s+/, ''))
    .join('')
    .replace(/\s+/g, '');

  assert.equal(rendered, expected);
  assert.ok(rendered.includes('1984.'), 'the leading number survived');
});

// ---------------------------------------------------------------------------
// Markdown subset: links and emphasis.
// ---------------------------------------------------------------------------

test('a markdown link becomes an anchor in html and stays literal in text', async () => {
  const body = 'See [our docs](https://example.com/docs) first.';
  const message = await parseMessage({ ...BASE, body });
  assert.equal(message.part('text/plain').content.toString('utf8'), body);
  assert.equal(
    message.part('text/html').content.toString('utf8'),
    '<div dir="ltr"><p>See <a href="https://example.com/docs">our docs</a> first.</p></div>'
  );
});

test('emphasis renders as <strong>/<em> and stays literal in text', async () => {
  const body = '**bold** and *italic* and _under_ but not snake_case_name';
  const message = await parseMessage({ ...BASE, body });
  assert.equal(message.part('text/plain').content.toString('utf8'), body);
  assert.equal(
    message.part('text/html').content.toString('utf8'),
    '<div dir="ltr"><p><strong>bold</strong> and <em>italic</em> and <em>under</em> ' +
      'but not snake_case_name</p></div>'
  );
});

test('SECURITY: a javascript: link never becomes an href', async () => {
  for (const body of [
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](data:text/html,<script>alert(1)</script>)',
    '[click](vbscript:msgbox(1))',
  ]) {
    const message = await parseMessage({ ...BASE, body });
    const html = message.part('text/html').content.toString('utf8');
    assert.ok(!/href="(?!https?:|mailto:)/i.test(html), `dangerous href produced: ${html}`);
    assert.ok(!/javascript:/i.test(html.replace(/&[a-z#0-9]+;/g, '')) || !/<a /.test(html), html);
    assert.ok(!html.includes('<script>'), html);
  }
});

test('SECURITY: an ampersand in a link URL is escaped inside the attribute', async () => {
  const message = await parseMessage({ ...BASE, body: '[a](https://x.com/?a=1&b=2)' });
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(html, '<div dir="ltr"><p><a href="https://x.com/?a=1&amp;b=2">a</a></p></div>');
  assert.ok(!/href="[^"]*&(?!amp;)/.test(html), 'bare ampersand left in the attribute');
});

test('SECURITY: a quote in the link text cannot break out of the attribute', async () => {
  const message = await parseMessage({ ...BASE, body: '[a"onmouseover=evil](https://x.com)' });
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(
    html,
    '<div dir="ltr"><p><a href="https://x.com">a&quot;onmouseover=evil</a></p></div>'
  );
  assert.ok(!/onmouseover=evil[^&]/.test(html.replace('&quot;onmouseover=evil', '')), html);
});

test('SECURITY: a literal <a href> typed by the author stays literal text', async () => {
  const body = '<a href="https://x.com">x</a>';
  const message = await parseMessage({ ...BASE, body });
  assert.equal(message.part('text/plain').content.toString('utf8'), body);
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(
    html,
    '<div dir="ltr"><p>&lt;a href=&quot;https://x.com&quot;&gt;x&lt;/a&gt;</p></div>'
  );
  assert.ok(!/<a /.test(html), 'author-typed anchor became live markup');
});

test('unmatched or malformed markdown degrades to literal text', async () => {
  for (const body of ['**bold', '[text](', '[a](b](c)', '*', '_', '[a](relative/path)', 'a * b * c']) {
    const message = await parseMessage({ ...BASE, body });
    const html = message.part('text/html').content.toString('utf8');
    assert.equal(message.part('text/plain').content.toString('utf8'), body);
    assert.ok(!/<(a|strong|em)\b/.test(html), `${JSON.stringify(body)} produced markup: ${html}`);
    assert.equal(htmlToText(html), body);
  }
});

test('a broken link with a real URL degrades to literal text plus an auto-link', async () => {
  // Documented consequence, not an accident: the `[](` never becomes markup, and
  // the URL inside it is still a plain https auto-link — nothing is lost or unsafe.
  const body = '[](https://x.com';
  const message = await parseMessage({ ...BASE, body });
  assert.equal(message.part('text/plain').content.toString('utf8'), body);
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(html, '<div dir="ltr"><p>[](<a href="https://x.com">https://x.com</a></p></div>');
  assert.equal(htmlToText(html), body);
});

test('a bare URL is auto-linked and still correctly escaped', async () => {
  const body = 'Visit https://example.com/a?b=1&c=2 now';
  const message = await parseMessage({ ...BASE, body });
  assert.equal(message.part('text/plain').content.toString('utf8'), body);
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(
    html,
    '<div dir="ltr"><p>Visit <a href="https://example.com/a?b=1&amp;c=2">' +
      'https://example.com/a?b=1&amp;c=2</a> now</p></div>'
  );
});

test('trailing sentence punctuation is not swallowed by an auto-link', async () => {
  const message = await parseMessage({ ...BASE, body: 'See https://example.com/x.' });
  const html = message.part('text/html').content.toString('utf8');
  assert.equal(
    html,
    '<div dir="ltr"><p>See <a href="https://example.com/x">https://example.com/x</a>.</p></div>'
  );
});

test('markdown inside a list item is rendered', async () => {
  const message = await parseMessage({
    ...BASE,
    body: '- see [docs](https://x.com/d)\n- **important**',
  });
  assert.equal(
    message.part('text/html').content.toString('utf8'),
    '<div dir="ltr"><ul><li>see <a href="https://x.com/d">docs</a></li>' +
      '<li><strong>important</strong></li></ul></div>'
  );
});

test('a leading "From " in the body is =46-escaped in the raw quoted-printable', async () => {
  const raw = (await buildMimeMessage({ ...BASE, body: 'From here on out\nthis is a test.' }))
    .toString('utf8');
  assert.ok(
    raw.split('\r\n').includes('=46rom here on out'),
    'expected an =46rom line in the raw message'
  );
  assert.ok(!/\r\nFrom here/.test(raw), 'unescaped "From " line survived');

  // And it still decodes back to exactly what was typed.
  const message = await parseMessage({ ...BASE, body: 'From here on out\nthis is a test.' });
  assert.equal(
    message.part('text/plain').content.toString('utf8'),
    'From here on out\r\nthis is a test.'
  );
});

test('a long "From " line stays inside the quoted-printable line limit', async () => {
  const body = `From ${'x'.repeat(90)} tail`;
  const raw = (await buildMimeMessage({ ...BASE, body })).toString('utf8');
  const offenders = raw.split('\r\n').filter((line) => Buffer.byteLength(line, 'utf8') > 78);
  assert.deepEqual(offenders, []);

  const message = await parseMessage({ ...BASE, body });
  assert.equal(message.part('text/plain').content.toString('utf8'), body);
});

// ---------------------------------------------------------------------------
// Attachments and the outbox drop box.
//
// readAttachment() runs on the SERVER (the VPS). A client-supplied path is
// meaningless unless it resolves on that machine — see
// docs/adr/008-accept-unconfined-attachment-path-risk.md for why that path is
// deliberately left unconfined, and docs/tickets/... none: this is the
// "file lives on a different machine" workflow gap, not the confinement
// question. Files placed in MCP_OUTBOX_DIR are a drop box: read once, then
// deleted. Everything outside it is left untouched, same as before this
// feature existed.
// ---------------------------------------------------------------------------

const ATTACHMENT_CONTENT_TYPE = 'application/x-test-attachment';

async function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('an attachment is embedded byte-correctly, outside any outbox', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-attach-'));
  const filePath = path.join(dir, 'report.bin');
  const bytes = Buffer.from([0, 1, 2, 255, 254, 253, 10, 13]); // arbitrary, non-UTF8-safe
  await fs.writeFile(filePath, bytes);

  const message = await parseMessage({
    ...BASE,
    body: 'See attached.',
    attachments: [{ path: filePath, contentType: ATTACHMENT_CONTENT_TYPE }],
  });

  const attachment = message.part(ATTACHMENT_CONTENT_TYPE);
  assert.deepEqual(attachment.content, bytes);
  assert.equal(attachment.headers.get('content-disposition')?.[0], `attachment; filename=report.bin`);

  // No MCP_OUTBOX_DIR is set for this test — an unconfigured/absent outbox
  // must never affect a normal attachment.
  assert.ok(await fs.access(filePath).then(() => true, () => false), 'file should still exist');
});

test('an attachment read from inside the outbox dir is deleted afterward', async () => {
  await withEnv('MCP_OUTBOX_DIR', await fs.mkdtemp(path.join(os.tmpdir(), 'compose-outbox-')), async () => {
    const outboxDir = process.env.MCP_OUTBOX_DIR;
    const filePath = path.join(outboxDir, 'assignment.pdf');
    await fs.writeFile(filePath, 'fake pdf bytes');

    const message = await parseMessage({
      ...BASE,
      body: 'See attached.',
      attachments: [{ path: filePath, contentType: ATTACHMENT_CONTENT_TYPE }],
    });

    assert.equal(message.part(ATTACHMENT_CONTENT_TYPE).content.toString('utf8'), 'fake pdf bytes');
    assert.equal(
      await fs.access(filePath).then(() => true, () => false),
      false,
      'outbox file should have been deleted after being attached'
    );
  });
});

test('an attachment outside the outbox dir is left in place even when an outbox is configured', async () => {
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-elsewhere-'));
  const filePath = path.join(outsideDir, 'not-staged.txt');
  await fs.writeFile(filePath, 'permanent file');

  await withEnv('MCP_OUTBOX_DIR', await fs.mkdtemp(path.join(os.tmpdir(), 'compose-outbox-')), async () => {
    await parseMessage({
      ...BASE,
      body: 'See attached.',
      attachments: [{ path: filePath, contentType: ATTACHMENT_CONTENT_TYPE }],
    });
  });

  assert.equal(
    await fs.access(filePath).then(() => true, () => false),
    true,
    'file outside the outbox must never be deleted'
  );
});

test('a symlink inside the outbox pointing outside it is not treated as an outbox file', async () => {
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-real-'));
  const realTarget = path.join(outsideDir, 'secret.txt');
  await fs.writeFile(realTarget, 'do not delete me');

  await withEnv('MCP_OUTBOX_DIR', await fs.mkdtemp(path.join(os.tmpdir(), 'compose-outbox-')), async () => {
    const outboxDir = process.env.MCP_OUTBOX_DIR;
    const symlinkPath = path.join(outboxDir, 'link-to-secret.txt');
    await fs.symlink(realTarget, symlinkPath);

    await parseMessage({
      ...BASE,
      body: 'See attached.',
      attachments: [{ path: symlinkPath, contentType: ATTACHMENT_CONTENT_TYPE }],
    });

    // The real target must survive regardless...
    assert.equal(
      await fs.access(realTarget).then(() => true, () => false),
      true,
      'the symlink target outside the outbox must never be deleted'
    );
    // ...and so must the symlink itself: cleanup only fires when the
    // resolved path is inside the outbox, so a link that resolves outside
    // it is left alone entirely rather than partially cleaned up.
    assert.equal(
      await fs.lstat(symlinkPath).then(() => true, () => false),
      true,
      'the symlink itself should not have been removed'
    );
  });
});

test('a missing/unconfigured outbox dir does not break attaching a normal file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-attach-'));
  const filePath = path.join(dir, 'note.txt');
  await fs.writeFile(filePath, 'hello');

  await withEnv('MCP_OUTBOX_DIR', path.join(os.tmpdir(), 'does-not-exist-' + Date.now()), async () => {
    const message = await parseMessage({
      ...BASE,
      body: 'See attached.',
      attachments: [{ path: filePath, contentType: ATTACHMENT_CONTENT_TYPE }],
    });
    assert.equal(message.part(ATTACHMENT_CONTENT_TYPE).content.toString('utf8'), 'hello');
  });

  assert.equal(
    await fs.access(filePath).then(() => true, () => false),
    true,
    'file must survive when the configured outbox dir does not exist'
  );
});
