import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JsonRecordStore } from '../dist/http/oauth/store.js';
import { GmailOAuthProvider } from '../dist/http/oauth/provider.js';

/**
 * Ticket 007 -- pending.json/codes.json grow forever because nothing ever
 * removed an expired record, only ever treated it as absent when read. These
 * tests cover both the low-level sweep primitive (JsonRecordStore.sweepExpired)
 * and the provider wiring that actually calls it for the two files that
 * expire quickly.
 */

async function makeConfigRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'oauth-sweep-test-'));
}

const FAKE_GOOGLE = { clientId: 'g-client', clientSecret: 'g-secret', redirectUri: 'http://localhost/oauth/google/callback' };

function fakeRes() {
  const calls = { redirects: [], statuses: [], bodies: [] };
  const res = {
    calls,
    redirect(status, url) {
      calls.redirects.push({ status, url });
    },
    status(code) {
      calls.statuses.push(code);
      return res;
    },
    type() {
      return res;
    },
    send(body) {
      calls.bodies.push(body);
      return res;
    },
  };
  return res;
}

function makeClient(overrides = {}) {
  return {
    client_id: 'client-1',
    redirect_uris: ['https://client.example.com/callback'],
    ...overrides,
  };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

test('JsonRecordStore.sweepExpired removes only records the predicate flags, and rewrites the file', async () => {
  const configRoot = await makeConfigRoot();
  const store = new JsonRecordStore(configRoot, 'sample.json');

  await store.set('expired-1', { expiresAt: 100 });
  await store.set('expired-2', { expiresAt: 200 });
  await store.set('live-1', { expiresAt: 9_999_999_999 });

  const removed = await store.sweepExpired((record) => record.expiresAt < 1000);
  assert.equal(removed, 2);

  assert.equal(await store.get('expired-1'), undefined);
  assert.equal(await store.get('expired-2'), undefined);
  assert.deepEqual(await store.get('live-1'), { expiresAt: 9_999_999_999 });
});

test('JsonRecordStore.sweepExpired is a no-op (and does not error) on a missing file or with nothing expired', async () => {
  const configRoot = await makeConfigRoot();
  const store = new JsonRecordStore(configRoot, 'sample.json');

  assert.equal(await store.sweepExpired(() => true), 0);

  await store.set('live-1', { expiresAt: 9_999_999_999 });
  assert.equal(await store.sweepExpired((record) => record.expiresAt < 1000), 0);
  assert.deepEqual(await store.get('live-1'), { expiresAt: 9_999_999_999 });
});

test('JsonRecordStore.sweepExpired cannot race a concurrent claim(): the two never both act on the same record', async () => {
  const configRoot = await makeConfigRoot();
  const store = new JsonRecordStore(configRoot, 'sample.json');
  await store.set('contested', { expiresAt: 500 });

  // Both go through the same per-file write queue (serialized()), so exactly
  // one of these two operations is the one that actually removes the record:
  // either the sweep drops it first (claim then sees nothing), or claim()
  // removes it first (sweep then has nothing left to drop). What must never
  // happen is claim() returning a value AND the sweep also counting it removed.
  const [claimed, removed] = await Promise.all([
    store.claim('contested'),
    store.sweepExpired((record) => record.expiresAt < 1000),
  ]);

  assert.ok(
    (claimed !== undefined && removed === 0) || (claimed === undefined && removed === 1),
    `expected exactly one of claim()/sweep to have won the record, got claimed=${JSON.stringify(claimed)} removed=${removed}`,
  );
  assert.equal(await store.get('contested'), undefined);
});

test('GmailOAuthProvider.sweepExpiredRecords drops an expired pending authorization but leaves a live one alone', async () => {
  const configRoot = await makeConfigRoot();
  let currentTime = Date.now();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
    now: () => currentTime,
  });

  const client = makeClient();
  const { challenge } = pkce();

  // Authorize twice: one pending record we'll let expire, one we'll keep live.
  const expiringRes = fakeRes();
  await provider.authorize(client, { codeChallenge: challenge, redirectUri: client.redirect_uris[0], scopes: ['read'] }, expiringRes);
  const expiringId = new URL(expiringRes.calls.redirects[0].url).searchParams.get('state');

  // Past the 10-minute PENDING_AUTHORIZATION_TTL_MS.
  currentTime += 11 * 60 * 1000;

  // Issued AFTER the clock advance, so its own expiresAt is still in the future.
  const liveRes = fakeRes();
  await provider.authorize(client, { codeChallenge: challenge, redirectUri: client.redirect_uris[0], scopes: ['read'] }, liveRes);
  const liveId = new URL(liveRes.calls.redirects[0].url).searchParams.get('state');

  const pendingStore = new JsonRecordStore(configRoot, 'pending.json');
  assert.notEqual(await pendingStore.get(expiringId), undefined, 'sanity check before sweeping');

  const result = await provider.sweepExpiredRecords();
  assert.equal(result.pending, 1);

  assert.equal(await pendingStore.get(expiringId), undefined, 'expired pending record must be gone from disk');
  assert.notEqual(await pendingStore.get(liveId), undefined, 'live pending record (issued after the clock advance) must survive the sweep');
  provider.close();
});

test('GmailOAuthProvider.sweepExpiredRecords drops an expired authorization code but leaves a live one alone', async () => {
  const configRoot = await makeConfigRoot();
  let currentTime = Date.now();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
    now: () => currentTime,
  });

  const client = makeClient();

  async function loginAndApprove() {
    const { challenge } = pkce();
    const authRes = fakeRes();
    await provider.authorize(client, { codeChallenge: challenge, redirectUri: client.redirect_uris[0], scopes: ['read'] }, authRes);
    const pendingId = new URL(authRes.calls.redirects[0].url).searchParams.get('state');

    const callbackRes = fakeRes();
    await provider.handleGoogleCallback({ state: pendingId, code: 'irrelevant' }, callbackRes);

    const consentRes = fakeRes();
    await provider.handleConsentDecision({ pendingId, decision: 'approve' }, consentRes);
    return new URL(consentRes.calls.redirects[0].url).searchParams.get('code');
  }

  const expiringCode = await loginAndApprove();

  // Past the 60-second AUTHORIZATION_CODE_TTL_MS.
  currentTime += 90 * 1000;

  const expiringCodeId = expiringCode;
  const liveCode = await loginAndApprove();

  const codesStore = new JsonRecordStore(configRoot, 'codes.json');
  assert.notEqual(await codesStore.get(expiringCodeId), undefined, 'sanity check before sweeping');

  const result = await provider.sweepExpiredRecords();
  assert.equal(result.codes, 1);

  assert.equal(await codesStore.get(expiringCodeId), undefined, 'expired code must be gone from disk');
  assert.notEqual(await codesStore.get(liveCode), undefined, 'live code (issued after the clock advance) must survive the sweep');
  provider.close();
});

test('constructing GmailOAuthProvider does not crash on an empty configRoot (startup sweep with nothing to sweep)', async () => {
  const configRoot = await makeConfigRoot();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
  });

  // The constructor's own startup sweep runs fire-and-forget; awaiting a
  // second, explicit sweep is a deterministic way to prove construction
  // didn't leave anything broken, without racing or waiting on the first one.
  const result = await provider.sweepExpiredRecords();
  assert.deepEqual(result, { pending: 0, codes: 0 });
  provider.close();
});

test('sweepExpiredRecords sweeps pending.json and codes.json independently: a failure reading one does not erase or hide the other\'s real result', async () => {
  const configRoot = await makeConfigRoot();
  let currentTime = Date.now();
  const logLines = [];
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
    now: () => currentTime,
    log: (message) => logLines.push(message),
  });

  const client = makeClient();
  const { challenge } = pkce();
  const expiringRes = fakeRes();
  await provider.authorize(client, { codeChallenge: challenge, redirectUri: client.redirect_uris[0], scopes: ['read'] }, expiringRes);
  currentTime += 11 * 60 * 1000; // past PENDING_AUTHORIZATION_TTL_MS

  // Corrupt codes.json (real unparseable JSON, not a mock) so that store's
  // own sweepExpired() genuinely throws -- readJsonFile in store.ts rethrows
  // any non-ENOENT error, which a JSON.parse failure is.
  const oauthDir = path.join(configRoot, 'oauth');
  await fs.mkdir(oauthDir, { recursive: true });
  await fs.writeFile(path.join(oauthDir, 'codes.json'), '{ not valid json', 'utf8');

  const result = await provider.sweepExpiredRecords();

  assert.equal(result.pending, 1, 'the pending.json sweep must still succeed and be reported');
  assert.equal(result.codes, 0, 'the codes.json sweep failed and reports 0, but must not throw or hang');
  assert.ok(
    logLines.some((line) => line.includes('codes.json') && line.includes('failed')),
    `expected a log line naming codes.json's own failure, got: ${JSON.stringify(logLines)}`,
  );
  assert.ok(
    logLines.some((line) => line.includes('1 expired pending')),
    `expected pending's real success to still be logged, got: ${JSON.stringify(logLines)}`,
  );

  provider.close();
});

test('GmailOAuthProvider.close() releases the background sweep timer and is safe to call more than once', async () => {
  const configRoot = await makeConfigRoot();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
  });

  provider.close();
  assert.doesNotThrow(() => provider.close());
});
