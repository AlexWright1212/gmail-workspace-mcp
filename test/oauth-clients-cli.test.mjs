import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/clients.sh's underlying logic (scripts/lib/oauth-clients.cjs) is a
// standalone, dependency-free Node script -- deliberately runnable directly
// against a fixture directory for exactly this kind of test, without going
// anywhere near the VPS. See that file's own module doc comment for why it's
// structured this way (one file, two invocation modes, no copy that drifts).
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'lib', 'oauth-clients.cjs');

async function makeFixture(clients) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-clients-cli-test-'));
  const oauthDir = path.join(dir, 'oauth');
  await fs.mkdir(oauthDir, { recursive: true });
  await fs.writeFile(path.join(oauthDir, 'clients.json'), JSON.stringify(clients), 'utf8');
  return oauthDir;
}

function run(args) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
}

// Regression test for a real finding by independent adversarial review, in
// two rounds: the first fix only stripped the ASCII C0/DEL range
// (`[\x00-\x1f\x7f]`), which closed the ESC/CSI/OSC bypass but missed an
// entire class of Unicode rendering-control characters that need no control
// byte at all -- most importantly U+202E RIGHT-TO-LEFT OVERRIDE, the
// standard Unicode filename-spoofing trick from real malware campaigns
// (`evil-client-<RLO>txt.exe` DISPLAYS as `evil-client-exe.txt` in any
// bidi-aware renderer). This test enumerates every class
// `isDangerousCodePoint` now covers -- C0/DEL, C1, bidi controls, the
// Unicode line/paragraph separators, and zero-width characters -- individually
// by code point, through BOTH `list` and `revoke` (they share the same
// `sanitizeForTerminal` function, so a fix to one that missed the other would
// otherwise go unnoticed).
//
// This also pins the STRATEGY, not just the effect: disallowed code points
// must be escaped visibly (`<U+XXXX>`), never silently deleted.
// `evil-client-<RLO>txt.exe` deleted down to `evil-client-txt.exe` is STILL
// misleading -- a plausible name with no sign anything was removed. The
// operator needs to see that something hostile was present.
const DANGEROUS_CODEPOINTS = {
  'C0 ESC': 0x1b,
  'DEL': 0x7f,
  'C1 CSI (no ESC needed)': 0x9b,
  'LRM': 0x200e,
  'RLM': 0x200f,
  'RLO (the RTL filename-spoofing exploit)': 0x202e,
  'LRI': 0x2066,
  'LINE SEPARATOR (fabricates a fake second entry)': 0x2028,
  'PARAGRAPH SEPARATOR': 0x2029,
  'ZWSP (invisible padding)': 0x200b,
  'ZWJ': 0x200d,
  'BOM / ZERO WIDTH NO-BREAK SPACE': 0xfeff,
};

test('list and revoke escape every class of rendering-control code point (C0/DEL, C1, bidi overrides, line/paragraph separators, zero-width) -- never delete, never leak the raw code point', async () => {
  const codePoints = Object.values(DANGEROUS_CODEPOINTS);
  // One client_name carrying every dangerous class at once, each one framed
  // by plain-text markers so a test can confirm the surrounding text
  // survives and only the dangerous code point itself was touched.
  const maliciousName = codePoints
    .map((cp, i) => `seg${i}${String.fromCodePoint(cp)}`)
    .join('|') + '|END';
  const maliciousRedirect = `https://example.com/${String.fromCodePoint(0x202e)}cb`;

  const oauthDir = await makeFixture({
    'hostile-client': {
      client_id: 'hostile-client',
      client_name: maliciousName,
      redirect_uris: [maliciousRedirect],
      client_id_issued_at: 1735689600,
    },
  });

  const listOutput = run([oauthDir, 'list']);
  const revokeOutput = run([oauthDir, 'revoke', 'hostile-client']);

  for (const [label, output] of [
    ['list', listOutput],
    ['revoke dry-run', revokeOutput],
  ]) {
    // Walk the output BY CODE POINT (codePointAt via [...string]), not by
    // string matching -- a string-match check could be satisfied by an
    // escaping scheme that still lets the raw code point through elsewhere
    // in the output. \n (0x0a) is the CLI's own line separator between
    // console.log calls, not attacker-controlled content, and is excluded.
    const outputCodePoints = [...output].map((ch) => ch.codePointAt(0));
    for (const [name, cp] of Object.entries(DANGEROUS_CODEPOINTS)) {
      assert.ok(
        !outputCodePoints.includes(cp),
        `${label} output leaks the raw ${name} code point (U+${cp.toString(16).toUpperCase()}) -- ` +
          `sanitizeForTerminal did not escape it. Full output: ${JSON.stringify(output)}`,
      );
      const marker = `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
      assert.ok(
        output.includes(marker),
        `${label} output is missing the visible escape marker ${marker} for ${name} -- ` +
          `a dangerous character must be shown, not silently deleted. Full output: ${JSON.stringify(output)}`,
      );
    }
    // The plain-text segments around every dangerous code point must
    // survive untouched -- this is a per-character escape, not a swallow of
    // the whole field (which would also hide a real client_name's mundane
    // text) and not a truncation at the first dangerous character.
    assert.match(output, /seg0/);
    assert.match(output, /seg11/);
    assert.match(output, /\|END/);
  }
});

test('legitimate non-ASCII client names and redirect URIs pass through completely unchanged, code point for code point', async () => {
  // Every one of these was specifically called out as needing to stay
  // clean: accents, an umlaut, a diacritic, a Greek letter, CJK text, an
  // astral-plane emoji (a surrogate pair in UTF-16 -- exercises the
  // for...of/codePointAt iteration path, not a plain charCodeAt loop that
  // could split it), and ordinary punctuation.
  const legitName = 'Café Müller Zoë β 日本語クライアント名 \u{1F680} (v2) — beta!';
  const legitRedirect = 'https://café.example.com/callback?x=1&y=2';

  const oauthDir = await makeFixture({
    'legit-client': {
      client_id: 'legit-client',
      client_name: legitName,
      redirect_uris: [legitRedirect],
      client_id_issued_at: 1735689600,
    },
  });

  const listOutput = run([oauthDir, 'list']);
  const revokeOutput = run([oauthDir, 'revoke', 'legit-client']);

  for (const [label, output] of [
    ['list', listOutput],
    ['revoke dry-run', revokeOutput],
  ]) {
    // No sanitizer marker of any kind should appear -- nothing here is
    // dangerous, so nothing should have been touched.
    assert.ok(!output.includes('<U+'), `${label} output contains an escape marker for legitimate text: ${JSON.stringify(output)}`);

    // Extract the printed name/redirect line and compare CODE POINT FOR CODE
    // POINT against the original input, not via a substring/regex match --
    // proves nothing was dropped, reordered, or normalized, not just that
    // some recognizable fragment survived.
    const nameLine = output.match(/^ {2}name: (.*)$/m);
    assert.ok(nameLine, `${label} output is missing a name line: ${JSON.stringify(output)}`);
    assert.deepEqual(
      [...nameLine[1]].map((ch) => ch.codePointAt(0)),
      [...legitName].map((ch) => ch.codePointAt(0)),
      `${label}: printed name diverges from the original code-point sequence`,
    );

    const redirectLine = output.match(/^ {2}redirect_uris: (.*)$/m);
    assert.ok(redirectLine, `${label} output is missing a redirect_uris line: ${JSON.stringify(output)}`);
    assert.deepEqual(
      [...redirectLine[1]].map((ch) => ch.codePointAt(0)),
      [...legitRedirect].map((ch) => ch.codePointAt(0)),
      `${label}: printed redirect_uri diverges from the original code-point sequence`,
    );
  }
});

test('a client_name/redirect_uri with no control characters is printed unchanged', async () => {
  const oauthDir = await makeFixture({
    'plain-client': {
      client_id: 'plain-client',
      client_name: 'Claude Code',
      redirect_uris: ['https://claude.ai/callback'],
      client_id_issued_at: 1735689600,
    },
  });

  const output = run([oauthDir, 'list']);
  assert.match(output, /name: Claude Code$/m);
  assert.match(output, /redirect_uris: https:\/\/claude\.ai\/callback$/m);
});

// Regression test for a LOW finding: `rest.includes('--yes')` is
// membership-based, so `revoke '--yes'` (a client_id that happens to equal
// the confirm flag itself) would satisfy its own confirmation check and
// actually delete on what was meant to be read as a dry run. Not
// exploitable today -- client_id is always a server-generated
// crypto.randomUUID(), never chosen by a caller -- but the check must be
// correct on its own terms, not rely on that. Fixed by making the check
// positional (`rest[1] === '--yes'`) instead of membership-based.
test('revoke <client_id> where client_id is literally the string "--yes" does NOT auto-confirm (positional flag check)', async () => {
  const oauthDir = await makeFixture({
    '--yes': {
      client_id: '--yes',
      redirect_uris: ['https://x.example.com'],
      client_id_issued_at: 1735689600,
    },
  });

  const output = run([oauthDir, 'revoke', '--yes']);
  assert.match(output, /Dry run only -- nothing was changed/, 'a bare positional client_id of "--yes" must be treated as a dry run, not a confirmation');

  const stored = JSON.parse(await fs.readFile(path.join(oauthDir, 'clients.json'), 'utf8'));
  assert.ok('--yes' in stored, 'the client must NOT have been deleted by a dry run');
});

test('revoke <client_id> --yes (two separate arguments) still actually deletes', async () => {
  const oauthDir = await makeFixture({
    'real-client': {
      client_id: 'real-client',
      redirect_uris: ['https://real.example.com/cb'],
      client_id_issued_at: 1735689600,
    },
  });

  const output = run([oauthDir, 'revoke', 'real-client', '--yes']);
  assert.match(output, /Revoked and verified/);

  const stored = JSON.parse(await fs.readFile(path.join(oauthDir, 'clients.json'), 'utf8'));
  assert.ok(!('real-client' in stored), 'the client must have been deleted when --yes is passed as its own argument');
});

// ---- migrate-scopes (plan 002 Phase 6) ----
//
// The one-shot rewrite of stored scope names that let the legacy alias be
// deleted without any client re-consenting. Pins: dry run by default and
// changes nothing; --yes rewrites BOTH stores; the rewrite is the same grant
// under its current spelling (client, resource, googleEmail, expiry all
// untouched); duplicates collapse; names it does not know are left alone
// (the server refuses those itself); idempotent; and no token value is ever
// printed -- the store keys ARE the token values.

async function makeScopeFixture() {
  const oauthDir = await makeFixture({
    'cc-mail': { client_id: 'cc-mail', client_name: 'Claude Code (gmail-remote)', redirect_uris: ['http://localhost:3118/callback'], client_id_issued_at: 1735689600 },
    'ws': { client_id: 'ws', client_name: 'Claude Code (google-workspace)', redirect_uris: ['http://localhost:3118/callback'], client_id_issued_at: 1735689600 },
  });
  const tokens = {
    'SECRET-ACCESS-OLD': { token: 'SECRET-ACCESS-OLD', clientId: 'cc-mail', scopes: ['mail:read', 'mail:write'], resource: 'https://mcp.example.com/mcp', googleEmail: 'owner@example.com', expiresAt: 4102444800 },
    'SECRET-ACCESS-MIXED': { token: 'SECRET-ACCESS-MIXED', clientId: 'cc-mail', scopes: ['mail:read', 'read'], resource: 'https://mcp.example.com/mcp', googleEmail: 'owner@example.com', expiresAt: 4102444800 },
    'SECRET-ACCESS-NEW': { token: 'SECRET-ACCESS-NEW', clientId: 'ws', scopes: ['read', 'write'], resource: 'https://mcp.example.com/workspace/mcp', googleEmail: 'owner@example.com', expiresAt: 4102444800 },
    'SECRET-ACCESS-UNKNOWN': { token: 'SECRET-ACCESS-UNKNOWN', clientId: 'ws', scopes: ['mail:admin'], resource: 'https://mcp.example.com/workspace/mcp', googleEmail: 'owner@example.com', expiresAt: 4102444800 },
  };
  const refreshTokens = {
    'SECRET-REFRESH-OLD': { token: 'SECRET-REFRESH-OLD', clientId: 'cc-mail', scopes: ['mail:read', 'mail:write'], resource: 'https://mcp.example.com/mcp', googleEmail: 'owner@example.com' },
    'SECRET-REFRESH-NEW': { token: 'SECRET-REFRESH-NEW', clientId: 'ws', scopes: ['read', 'write'], resource: 'https://mcp.example.com/workspace/mcp', googleEmail: 'owner@example.com' },
  };
  await fs.writeFile(path.join(oauthDir, 'tokens.json'), JSON.stringify(tokens), 'utf8');
  await fs.writeFile(path.join(oauthDir, 'refresh-tokens.json'), JSON.stringify(refreshTokens), 'utf8');
  return { oauthDir, tokens, refreshTokens };
}

async function readStore(oauthDir, name) {
  return JSON.parse(await fs.readFile(path.join(oauthDir, name), 'utf8'));
}

test('migrate-scopes without --yes reports what it would rewrite, changes nothing, and prints no token value', async () => {
  const { oauthDir, tokens, refreshTokens } = await makeScopeFixture();
  const output = run([oauthDir, 'migrate-scopes']);

  assert.match(output, /access token records carrying a retired scope name: 2/);
  assert.match(output, /refresh token records carrying a retired scope name: 1/);
  assert.match(output, /client cc-mail: 2 record\(s\): mail:read mail:write -> read write \| mail:read read -> read/);
  assert.match(output, /Dry run only -- nothing was changed/);
  assert.ok(!output.includes('SECRET-'), `a token value leaked into the output: ${JSON.stringify(output)}`);

  assert.deepEqual(await readStore(oauthDir, 'tokens.json'), tokens, 'dry run must not touch tokens.json');
  assert.deepEqual(await readStore(oauthDir, 'refresh-tokens.json'), refreshTokens, 'dry run must not touch refresh-tokens.json');
});

test('migrate-scopes --yes rewrites both stores to the current names, touches nothing else on the record, and reads back clean', async () => {
  const { oauthDir, tokens, refreshTokens } = await makeScopeFixture();
  const output = run([oauthDir, 'migrate-scopes', '--yes']);
  assert.match(output, /Rewrote and verified: 3 record\(s\)/);
  assert.ok(!output.includes('SECRET-'), `a token value leaked into the output: ${JSON.stringify(output)}`);

  const after = await readStore(oauthDir, 'tokens.json');
  assert.deepEqual(after['SECRET-ACCESS-OLD'], { ...tokens['SECRET-ACCESS-OLD'], scopes: ['read', 'write'] });
  assert.deepEqual(after['SECRET-ACCESS-MIXED'], { ...tokens['SECRET-ACCESS-MIXED'], scopes: ['read'] }, 'duplicates collapse to one current name');
  assert.deepEqual(after['SECRET-ACCESS-NEW'], tokens['SECRET-ACCESS-NEW'], 'a record already under current names is untouched');
  assert.deepEqual(after['SECRET-ACCESS-UNKNOWN'], tokens['SECRET-ACCESS-UNKNOWN'], 'an unknown name is left for the server to refuse, not guessed at');

  const refreshAfter = await readStore(oauthDir, 'refresh-tokens.json');
  assert.deepEqual(refreshAfter['SECRET-REFRESH-OLD'], { ...refreshTokens['SECRET-REFRESH-OLD'], scopes: ['read', 'write'] });
  assert.deepEqual(refreshAfter['SECRET-REFRESH-NEW'], refreshTokens['SECRET-REFRESH-NEW']);

  // The store files keep the exact idiom the server writes (2-space JSON,
  // trailing newline), so the live server reads them back unchanged.
  const raw = await fs.readFile(path.join(oauthDir, 'tokens.json'), 'utf8');
  assert.equal(raw, JSON.stringify(after, null, 2) + '\n');

  // Idempotent: a second run has nothing to do and does not fail.
  const again = run([oauthDir, 'migrate-scopes', '--yes']);
  assert.match(again, /Nothing to migrate/);
  assert.match(run([oauthDir, 'list']), /name: Claude Code \(gmail-remote\)/);
});

test('migrate-scopes on a store with no retired names says so and writes nothing', async () => {
  const oauthDir = await makeFixture({});
  const tokens = { 'SECRET-A': { token: 'SECRET-A', clientId: 'x', scopes: ['read'], resource: 'https://mcp.example.com/mcp', googleEmail: 'o@example.com', expiresAt: 4102444800 } };
  await fs.writeFile(path.join(oauthDir, 'tokens.json'), JSON.stringify(tokens), 'utf8');
  const output = run([oauthDir, 'migrate-scopes', '--yes']);
  assert.match(output, /Nothing to migrate/);
  assert.equal(await fs.readFile(path.join(oauthDir, 'tokens.json'), 'utf8'), JSON.stringify(tokens), 'the file must not even be rewritten when there is nothing to change');
  await assert.rejects(fs.access(path.join(oauthDir, 'refresh-tokens.json')), 'a missing store must not be created by a no-op run');
});

test('list marks a client whose stored token still carries a retired scope name RETIRED and points at migrate-scopes; a current-name client is not marked', async () => {
  const { oauthDir } = await makeScopeFixture();
  const output = run([oauthDir, 'list']);
  const ccMail = output.slice(output.indexOf('client_id: cc-mail'), output.indexOf('client_id: ws'));
  const ws = output.slice(output.indexOf('client_id: ws'));
  assert.match(ccMail, /scopes: .*<- RETIRED names: the server refuses these since 2026-09-20; run `bash scripts\/clients\.sh migrate-scopes`/);
  assert.doesNotMatch(ws, /RETIRED/, 'the mail:admin record is unknown, not retired; only mail:read/mail:write are');
  assert.ok(!output.includes('SECRET-'), `a token value leaked into list output: ${JSON.stringify(output)}`);

  run([oauthDir, 'migrate-scopes', '--yes']);
  assert.doesNotMatch(run([oauthDir, 'list']), /RETIRED/, 'after migration nothing is marked');
});

test('a store file holding valid JSON of the wrong shape fails loudly by file name instead of crashing on a bare TypeError', async () => {
  const oauthDir = await makeFixture({});
  await fs.writeFile(path.join(oauthDir, 'tokens.json'), 'null', 'utf8');
  for (const args of [[oauthDir, 'migrate-scopes'], [oauthDir, 'list']]) {
    assert.throws(
      () => run(args),
      (err) => /tokens\.json is not a JSON object of records \(got null\)/.test(String(err.stderr)),
      `${args[1]} must name the malformed file`,
    );
  }
});
