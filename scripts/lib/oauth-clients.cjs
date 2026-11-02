#!/usr/bin/env node
'use strict';
/**
 * The actual JSON-store logic behind `scripts/clients.sh`: list registered
 * OAuth clients (with non-secret derived counts) and revoke one (its
 * registration AND every access/refresh token, plus any in-flight
 * authorization code or pending authorization, so revocation is genuinely
 * effective rather than cosmetic).
 *
 * Deliberately plain CommonJS with zero dependencies beyond node:fs/path, and
 * runnable two ways from the exact same file (no copy that can drift):
 *
 *  - Directly, for local testing against a fixture directory:
 *      node scripts/lib/oauth-clients.cjs <oauthDir> list
 *      node scripts/lib/oauth-clients.cjs <oauthDir> revoke <client_id> [--yes]
 *      node scripts/lib/oauth-clients.cjs <oauthDir> migrate-scopes [--yes]
 *
 *  - Piped over its own stdin to a `node -` process on the VPS, which is what
 *    `scripts/clients.sh` actually does (`node - <args...> < this file`, run
 *    through scripts/vps.sh, never raw ssh). `node -` reads the script body
 *    from stdin and treats everything after `-` on the command line as this
 *    script's own argv -- see clients.sh for the exact invocation. This is
 *    what makes the two run modes byte-identical: there is exactly one copy
 *    of this logic, not a local one and a separate remote one.
 *
 * Reads and writes the SAME plain-JSON-file idiom as src/http/oauth/store.ts
 * (JsonRecordStore): one file per record type, `Record<id, T>`, written with
 * a trailing newline. This script does NOT go through that class -- it is a
 * separate, external Node process, not the running MCP server -- so its
 * read-modify-write against `clients.json`/`tokens.json`/`refresh-tokens.json`
 * is NOT synchronized with the live server's own in-process write queue.
 * That is a real, accepted limitation for an operational tool like this one:
 * running `revoke` at the exact moment the live server is minting or
 * refreshing a token for the SAME client could interleave. Personal-scale,
 * low-frequency use makes this an acceptable trade, not an oversight -- but
 * it is why `revoke` always reads every store back after writing and REFUSES
 * to report success if anything it meant to delete is still there (see
 * revokeClient below), rather than trusting the write it just performed.
 *
 * NEVER prints a client_secret or a token/refresh-token value. Client ids are
 * not secret (DCR is open by design -- see docs/adr/013) and are the entire
 * point of `list`.
 *
 * `client_name` and `redirect_uris` are attacker-controlled (self-reported at
 * DCR registration time) and are run through `sanitizeForTerminal` before
 * ever being printed -- see that function's own comment. Without it, a
 * hostile client_name containing ESC/CSI/OSC bytes could retitle the
 * terminal, clear the screen, or hide a real entry off-screen, defeating the
 * entire point of this tool being the trustworthy view of who is connected.
 */

const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Failed to read ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A corrupt store file is exactly the kind of thing that must fail
    // loudly, not be treated as "empty" -- silently proceeding could make
    // `revoke` report success while never having seen the real data.
    throw new Error(`Failed to parse ${file} as JSON: ${err.message}`);
  }
  // Every store is `Record<id, T>`. Valid JSON of the wrong shape (`null`,
  // an array, a string) would otherwise surface as a bare TypeError deep in
  // whichever command touched it first, instead of naming the file.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object of records (got ${Array.isArray(parsed) ? 'an array' : String(parsed === null ? 'null' : typeof parsed)}); refusing to proceed.`);
  }
  return parsed;
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * True for any code point that can manipulate how a terminal (or an agent's
 * transcript, or whatever else `list`'s output gets piped into) RENDERS
 * text, as opposed to merely being unusual text. Enumerated by class, not by
 * the specific bytes an example payload happened to use -- an ASCII-only
 * `[\x00-\x1f\x7f]` range was the original version of this function and
 * missed every one of these, all of which are real, working bypasses found
 * by adversarial review against a live client_name:
 *
 *  - C0 controls + DEL (0x00-0x1f, 0x7f): ESC/CSI/OSC sequences -- retitle
 *    the terminal, clear the screen, move the cursor.
 *  - C1 controls (0x80-0x9f): the single-byte equivalents of the above on a
 *    terminal that honors them -- U+009B is CSI on its own, no ESC needed.
 *  - Bidi control characters (U+200E/U+200F, U+202A-U+202E, U+2066-U+2069):
 *    U+202E RIGHT-TO-LEFT OVERRIDE is the standard Unicode filename-spoofing
 *    trick from real malware campaigns -- "evil-client-<RLO>txt.exe" DISPLAYS
 *    as "evil-client-exe.txt" in any bidi-aware renderer while remaining the
 *    original bytes underneath. No control byte required.
 *  - U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR: many renderers treat
 *    these as a hard line break, letting one client's name fabricate what
 *    looks like a second, independent list entry.
 *  - Zero-width characters (U+200B-U+200D, U+FEFF): invisible padding that
 *    can make two distinct client_name values look byte-for-byte identical
 *    to a human comparing two `list` entries.
 *
 * STRATEGY: escape visibly, never silently delete. Deleting turns
 * "evil-client-<RLO>txt.exe" into "evil-client-txt.exe" -- which is STILL
 * misleading, now with no sign anything was ever removed. For a tool whose
 * entire job is being the trustworthy view of who is connected, the operator
 * needs to SEE that a name contained something hostile, not just be
 * protected from its rendering effect. Every disallowed code point is
 * replaced with a literal, ASCII-only `<U+XXXX>` marker instead -- safe to
 * print anywhere (it cannot itself be interpreted as a control sequence),
 * self-describing, and impossible to confuse with legitimate text.
 *
 * Legitimate non-ASCII text (accents, CJK, emoji, symbols -- e.g. "Café",
 * "Müller", "Zoë", "β", "日本語クライアント名") is NOT in any of the ranges
 * above and passes through completely unchanged; this only ever touches
 * characters whose entire purpose is controlling how something renders, not
 * "unusual" text in general.
 *
 * Iterates by Unicode code point (`for...of` over the string), not by UTF-16
 * code unit (`charCodeAt` in a plain index loop) -- the latter would split a
 * surrogate pair (e.g. most emoji) into two units and risk mangling them,
 * even though neither surrogate half falls in a disallowed range here.
 */
function isDangerousCodePoint(cp) {
  if (cp <= 0x1f || cp === 0x7f) return true; // C0 + DEL
  if (cp >= 0x80 && cp <= 0x9f) return true; // C1 (includes U+009B CSI)
  if (cp === 0x200e || cp === 0x200f) return true; // LRM, RLM
  if (cp >= 0x202a && cp <= 0x202e) return true; // LRE,RLE,PDF,LRO,RLO
  if (cp >= 0x2066 && cp <= 0x2069) return true; // LRI,RLI,FSI,PDI
  if (cp === 0x2028 || cp === 0x2029) return true; // LINE/PARAGRAPH SEPARATOR
  if (cp >= 0x200b && cp <= 0x200d) return true; // ZWSP, ZWNJ, ZWJ
  if (cp === 0xfeff) return true; // BOM / ZERO WIDTH NO-BREAK SPACE
  return false;
}

function sanitizeForTerminal(value) {
  if (typeof value !== 'string') return value;
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    out += isDangerousCodePoint(cp) ? `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>` : ch;
  }
  return out;
}

function isoFromEpochSeconds(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return undefined;
  return new Date(sec * 1000).toISOString();
}

/**
 * Best-effort activity lookup from the Task A request log
 * (src/http/request-log.ts, REQUEST_LOG_FILENAME = 'request-log.log'), which
 * lives one directory up from `oauthDir` (both are direct children of the
 * same configRoot -- see src/http/oauth/store.ts's getOAuthDir and
 * src/index.ts's runHttpServer). Missing, empty, or unparseable lines are
 * silently skipped: this is a nice-to-have annotation on `list`, not
 * something revoke's correctness depends on.
 *
 * Returns the most recent `at` for the client and the set of endpoint paths
 * it has been seen on (plan 002 Phase 2: `/mcp` is Mail, `/workspace/mcp` is
 * Google Workspace; the log's `path` field is what tells them apart).
 */
function readClientActivity(oauthDir, clientId) {
  const configRoot = path.dirname(oauthDir);
  const logPath = path.join(configRoot, 'request-log.log');
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return { lastSeen: undefined, endpoints: [] };
  }

  let lastSeen;
  const endpoints = new Set();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.clientId !== clientId) continue;
    if (typeof entry.at === 'string' && (!lastSeen || entry.at > lastSeen)) lastSeen = entry.at;
    if (typeof entry.path === 'string') endpoints.add(entry.path);
  }
  return { lastSeen, endpoints: [...endpoints].sort() };
}

/**
 * The distinct scope sets across a client's stored tokens. A `mail:` name
 * is the retired pre-plan-002 spelling; since Phase 6 (2026-09-20) the
 * server refuses such a record outright (401 / invalid_grant, so the client
 * re-authorizes) instead of translating it. Seeing one here means a stale
 * store was restored -- `migrate-scopes` fixes it without anyone
 * re-consenting.
 */
function describeScopeSets(records) {
  const sets = new Set();
  for (const record of records) {
    if (record && Array.isArray(record.scopes)) sets.add(record.scopes.slice().sort().join(' ') || '(none)');
  }
  if (sets.size === 0) return '(no tokens)';
  // Exactly the names migrate-scopes rewrites -- not "anything starting with
  // mail:", which would send the operator to a command that will not touch
  // the record.
  const retired = records.some(hasRetiredScopeName);
  return [...sets].sort().map(sanitizeForTerminal).join(' | ') + (retired ? '  <- RETIRED names: the server refuses these since 2026-09-20; run `bash scripts/clients.sh migrate-scopes`' : '');
}

function storePaths(oauthDir) {
  return {
    clients: path.join(oauthDir, 'clients.json'),
    tokens: path.join(oauthDir, 'tokens.json'),
    refreshTokens: path.join(oauthDir, 'refresh-tokens.json'),
    codes: path.join(oauthDir, 'codes.json'),
    pending: path.join(oauthDir, 'pending.json'),
  };
}

function listClients(oauthDir) {
  const paths = storePaths(oauthDir);
  const clients = readJson(paths.clients, {});
  const tokens = readJson(paths.tokens, {});
  const refreshTokens = readJson(paths.refreshTokens, {});

  const clientIds = Object.keys(clients);
  if (clientIds.length === 0) {
    console.log('No OAuth clients registered.');
    return;
  }

  console.log(`# OAuth Clients (${clientIds.length})\n`);
  for (const id of clientIds) {
    const c = clients[id] || {};
    const accessRecords = Object.values(tokens).filter((t) => t && t.clientId === id);
    const refreshRecords = Object.values(refreshTokens).filter((t) => t && t.clientId === id);
    const accessCount = accessRecords.length;
    const refreshCount = refreshRecords.length;
    const { lastSeen, endpoints } = readClientActivity(oauthDir, id);
    const resources = new Set(
      [...accessRecords, ...refreshRecords].map((t) => (typeof t.resource === 'string' ? t.resource : '')).filter(Boolean),
    );

    const safeName = c.client_name ? sanitizeForTerminal(c.client_name) : undefined;
    const safeRedirects = Array.isArray(c.redirect_uris) && c.redirect_uris.length
      ? c.redirect_uris.map(sanitizeForTerminal).join(', ')
      : undefined;

    console.log(`- client_id: ${id}`);
    console.log(`  name: ${safeName || '(none -- client did not set client_name at registration)'}`);
    console.log(`  redirect_uris: ${safeRedirects || '(none)'}`);
    console.log(`  registered_at: ${isoFromEpochSeconds(c.client_id_issued_at) || '(unknown)'}`);
    console.log(`  live access tokens: ${accessCount} (raw count, not filtered for expiry)`);
    console.log(`  live refresh tokens: ${refreshCount}`);
    console.log(`  token audience(s): ${resources.size ? [...resources].sort().map(sanitizeForTerminal).join(', ') : '(no tokens)'}`);
    console.log(`  scopes: ${describeScopeSets([...accessRecords, ...refreshRecords])}`);
    console.log(`  endpoints seen (from request-log.log): ${endpoints.length ? endpoints.map(sanitizeForTerminal).join(', ') : '(none)'}`);
    console.log(`  last seen (from request-log.log): ${lastSeen || '(no matching request-log entries found)'}`);
    console.log('');
  }
}

function revokeClient(oauthDir, clientId, confirmed) {
  const paths = storePaths(oauthDir);
  const clients = readJson(paths.clients, {});

  if (!(clientId in clients)) {
    console.error(`clients.sh revoke: unknown client_id "${clientId}" -- not found in ${paths.clients}`);
    process.exitCode = 1;
    return;
  }

  const tokens = readJson(paths.tokens, {});
  const refreshTokens = readJson(paths.refreshTokens, {});
  const codes = readJson(paths.codes, {});
  const pending = readJson(paths.pending, {});

  const matchingTokenIds = Object.keys(tokens).filter((k) => tokens[k] && tokens[k].clientId === clientId);
  const matchingRefreshIds = Object.keys(refreshTokens).filter((k) => refreshTokens[k] && refreshTokens[k].clientId === clientId);
  const matchingCodeIds = Object.keys(codes).filter((k) => codes[k] && codes[k].clientId === clientId);
  const matchingPendingIds = Object.keys(pending).filter((k) => pending[k] && pending[k].clientId === clientId);

  const client = clients[clientId];
  const safeName = client.client_name ? sanitizeForTerminal(client.client_name) : undefined;
  const safeRedirects = Array.isArray(client.redirect_uris) && client.redirect_uris.length
    ? client.redirect_uris.map(sanitizeForTerminal).join(', ')
    : undefined;
  console.log(`Client: ${clientId}`);
  console.log(`  name: ${safeName || '(none)'}`);
  console.log(`  redirect_uris: ${safeRedirects || '(none)'}`);
  console.log('Would delete:');
  console.log('  1 client registration');
  console.log(`  ${matchingTokenIds.length} access token(s)`);
  console.log(`  ${matchingRefreshIds.length} refresh token(s)`);
  console.log(`  ${matchingCodeIds.length} in-flight authorization code(s)`);
  console.log(`  ${matchingPendingIds.length} pending authorization(s) (in-progress logins not yet approved/denied)`);

  if (!confirmed) {
    console.log('\nDry run only -- nothing was changed. Re-run with --yes to actually revoke.');
    return;
  }

  delete clients[clientId];
  for (const k of matchingTokenIds) delete tokens[k];
  for (const k of matchingRefreshIds) delete refreshTokens[k];
  for (const k of matchingCodeIds) delete codes[k];
  for (const k of matchingPendingIds) delete pending[k];

  writeJson(paths.clients, clients);
  writeJson(paths.tokens, tokens);
  writeJson(paths.refreshTokens, refreshTokens);
  writeJson(paths.codes, codes);
  writeJson(paths.pending, pending);

  // Read every store back rather than trust the writes just performed --
  // this project's whole verification discipline exists because a tool once
  // reported success while doing nothing (list_accounts; see CLAUDE.md).
  const verifyClients = readJson(paths.clients, {});
  const verifyTokens = readJson(paths.tokens, {});
  const verifyRefresh = readJson(paths.refreshTokens, {});
  const verifyCodes = readJson(paths.codes, {});
  const verifyPending = readJson(paths.pending, {});

  const stillThere = [];
  if (clientId in verifyClients) stillThere.push('client registration');
  if (Object.values(verifyTokens).some((t) => t && t.clientId === clientId)) stillThere.push('access token(s)');
  if (Object.values(verifyRefresh).some((t) => t && t.clientId === clientId)) stillThere.push('refresh token(s)');
  if (Object.values(verifyCodes).some((t) => t && t.clientId === clientId)) stillThere.push('authorization code(s)');
  if (Object.values(verifyPending).some((t) => t && t.clientId === clientId)) stillThere.push('pending authorization(s)');

  if (stillThere.length > 0) {
    console.error(
      `REVOKE DID NOT FULLY LAND: ${stillThere.join(', ')} still present after write. ` +
        'Do not assume this client is revoked -- investigate manually before relying on this.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nRevoked and verified: "${clientId}" has no registration, access tokens, refresh tokens, ` +
      'authorization codes, or pending authorizations remaining.',
  );
}

/**
 * `migrate-scopes` -- plan 002 Phase 6's one-shot rewrite of stored scope
 * names, run 2026-09-20 before the legacy alias in src/http/scope-names.ts
 * was deleted.
 *
 * Why it exists: Phase 2 renamed the scopes (`mail:read`/`mail:write` ->
 * `read`/`write`) and kept the old spelling working through an alias, with
 * "delete the alias once `list` shows no LEGACY client" as the gate. That
 * gate could never close on its own: the alias made re-consent unnecessary,
 * a refresh token never expires, and the refresh path deliberately left the
 * refresh-token record under the old names. So the owner's three daily mail
 * clients would have stayed LEGACY forever. Rewriting the stored names is
 * the same grant under its current spelling -- same client, same audience
 * (`resource`), same Google identity, nothing widened -- and it is what
 * lets the alias go with nobody re-logging-in.
 *
 * Same discipline and the same accepted limitation as `revoke`: dry run by
 * default, `--yes` to write, every store read back afterwards and success
 * REFUSED if any retired name survived; and the read-modify-write is not
 * synchronized with the live server's own write queue (the server never
 * writes a retired name, so the only thing a race could lose is a record
 * minted in the same instant, which the next refresh re-mints).
 *
 * Idempotent: a second run reports nothing to change. Never prints a token
 * value -- the store keys ARE the token values, so only per-client counts
 * and scope names are printed.
 */
const RETIRED_SCOPE_NAMES = Object.freeze({
  'mail:read': 'read',
  'mail:write': 'write',
});

function migrateScopeNames(scopes) {
  const out = [];
  for (const scope of scopes) {
    const mapped = Object.prototype.hasOwnProperty.call(RETIRED_SCOPE_NAMES, scope) ? RETIRED_SCOPE_NAMES[scope] : scope;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

function hasRetiredScopeName(record) {
  return Boolean(record) && Array.isArray(record.scopes)
    && record.scopes.some((scope) => Object.prototype.hasOwnProperty.call(RETIRED_SCOPE_NAMES, scope));
}

function migrateScopes(oauthDir, confirmed) {
  const paths = storePaths(oauthDir);
  const stores = [
    { label: 'access token', file: paths.tokens },
    { label: 'refresh token', file: paths.refreshTokens },
  ];

  let total = 0;
  for (const store of stores) {
    store.records = readJson(store.file, {});
    store.changes = [];
    for (const [id, record] of Object.entries(store.records)) {
      if (!hasRetiredScopeName(record)) continue;
      store.changes.push({ id, clientId: record.clientId, before: record.scopes.slice(), after: migrateScopeNames(record.scopes) });
    }
    total += store.changes.length;
  }

  for (const store of stores) {
    console.log(`${store.label} records carrying a retired scope name: ${store.changes.length}`);
    const byClient = new Map();
    for (const change of store.changes) {
      const key = typeof change.clientId === 'string' ? change.clientId : '(no clientId)';
      if (!byClient.has(key)) byClient.set(key, []);
      byClient.get(key).push(change);
    }
    for (const [clientId, changes] of byClient) {
      const spellings = new Set(changes.map((c) => `${c.before.join(' ')} -> ${c.after.join(' ')}`));
      console.log(`  client ${sanitizeForTerminal(clientId)}: ${changes.length} record(s): ${[...spellings].map(sanitizeForTerminal).join(' | ')}`);
    }
  }

  if (total === 0) {
    console.log('\nNothing to migrate: no stored token carries a retired scope name.');
    return;
  }

  if (!confirmed) {
    console.log('\nDry run only -- nothing was changed. Re-run with --yes to rewrite these records.');
    return;
  }

  // Two files, two writes, no transaction across them. If the second write
  // throws after the first landed, say exactly which store may be half
  // done rather than letting a bare exception imply nothing happened; the
  // read-back below only runs if both writes returned.
  const written = [];
  for (const store of stores) {
    for (const change of store.changes) {
      store.records[change.id].scopes = change.after;
    }
    try {
      writeJson(store.file, store.records);
      written.push(store.label);
    } catch (err) {
      console.error(
        `MIGRATION STOPPED MID-WAY: writing ${store.file} failed (${err.message}). ` +
          (written.length ? `Already written: ${written.join(', ')} store. ` : 'Nothing was written. ') +
          'Re-run `migrate-scopes` once the cause is fixed; it is idempotent.',
      );
      process.exitCode = 1;
      return;
    }
  }

  // Read back rather than trust the write -- same rule as revoke.
  const survivors = [];
  for (const store of stores) {
    const verify = readJson(store.file, {});
    const stillRetired = Object.values(verify).filter(hasRetiredScopeName).length;
    if (stillRetired > 0) survivors.push(`${stillRetired} ${store.label} record(s)`);
  }
  if (survivors.length > 0) {
    console.error(
      `MIGRATION DID NOT FULLY LAND: ${survivors.join(', ')} still carry a retired scope name after write. ` +
        'Do not delete the alias until this reads back clean -- investigate manually.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nRewrote and verified: ${total} record(s) now carry only current scope names; none retired remain.`);
}

function usage() {
  console.error('usage: node oauth-clients.cjs <oauthDir> list');
  console.error('       node oauth-clients.cjs <oauthDir> revoke <client_id> [--yes]');
  console.error('       node oauth-clients.cjs <oauthDir> migrate-scopes [--yes]');
}

function main() {
  const args = process.argv.slice(2);
  const [oauthDir, command, ...rest] = args;

  if (!oauthDir || !command) {
    usage();
    process.exitCode = 2;
    return;
  }

  if (command === 'list') {
    listClients(oauthDir);
    return;
  }

  if (command === 'revoke') {
    const clientId = rest[0];
    if (!clientId) {
      usage();
      process.exitCode = 2;
      return;
    }
    // Positional, not membership (rest.includes('--yes')) -- a
    // membership check would let a dry-run invocation like
    // `revoke '--yes'` (a hostile/mistaken client_id equal to the flag
    // itself) satisfy its own confirm check and actually delete. Not
    // exploitable today (client_id is always a server-generated
    // crypto.randomUUID()), but the check should be correct on its own
    // terms, not rely on that.
    const confirmed = rest[1] === '--yes';
    revokeClient(oauthDir, clientId, confirmed);
    return;
  }

  if (command === 'migrate-scopes') {
    // Positional for the same reason as revoke's check.
    migrateScopes(oauthDir, rest[0] === '--yes');
    return;
  }

  console.error(`oauth-clients.cjs: unknown command "${command}"`);
  usage();
  process.exitCode = 2;
}

main();
