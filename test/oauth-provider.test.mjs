import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GmailOAuthProvider } from '../dist/http/oauth/provider.js';
import { isOwnerGoogleIdentity } from '../dist/http/oauth/identity-allowlist.js';

// Plan 002 Phase 2: a provider fronts a LIST of protected resources and a
// gate verifies against exactly one of them via verifierFor(). Most tests
// here need only one resource; this is it.
const MAIL_RESOURCE = new URL('https://mcp.example.com/mcp');
function verify(provider, token, resourceUrl = MAIL_RESOURCE) {
  return provider.verifierFor(resourceUrl).verifyAccessToken(token);
}

async function makeConfigRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'oauth-provider-test-'));
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

/**
 * Drives authorize() -> Google callback -> the CONSENT step -> approve, and
 * returns the resulting authorization code. Asserts the consent page was
 * actually shown (status 200, HTML, naming the client) along the way, so a
 * regression that skips straight back to a redirect (the exact CRITICAL bug
 * this step exists to close) fails loudly here rather than only in the
 * dedicated phishing-scenario test below.
 */
async function loginAndApprove(provider, client, params, googleCode) {
  const authRes = fakeRes();
  await provider.authorize(client, { codeChallenge: params.challenge, redirectUri: client.redirect_uris[0], ...params }, authRes);
  const googleState = new URL(authRes.calls.redirects[0].url).searchParams.get('state');

  const callbackRes = fakeRes();
  await provider.handleGoogleCallback({ state: googleState, code: googleCode }, callbackRes);
  assert.equal(callbackRes.calls.redirects.length, 0, 'identity success must render consent, not redirect');
  assert.equal(callbackRes.calls.statuses[0], 200);
  const consentHtml = callbackRes.calls.bodies[0];
  assert.match(consentHtml, /Authorize this application/);
  assert.match(consentHtml, new RegExp(client.client_id));

  const consentRes = fakeRes();
  await provider.handleConsentDecision({ pendingId: googleState, decision: 'approve' }, consentRes);
  const code = new URL(consentRes.calls.redirects[0].url).searchParams.get('code');
  assert.ok(code, 'approval must issue an authorization code');
  return { code, googleState };
}

test('isOwnerGoogleIdentity matches only the two owner addresses, case/whitespace-insensitively', () => {
  assert.equal(isOwnerGoogleIdentity('ownerpersonal@gmail.com'), true);
  assert.equal(isOwnerGoogleIdentity('  OWNER_SCHOOL@TAMU.EDU '), true);
  assert.equal(isOwnerGoogleIdentity('owner_school@tamu.edu'), true);
  assert.equal(isOwnerGoogleIdentity('someone.else@gmail.com'), false);
  assert.equal(isOwnerGoogleIdentity('ownerpersonal@googlemail.com'), false);
  assert.equal(isOwnerGoogleIdentity(''), false);
});

test('a token minted for a different resource is rejected by verifyAccessToken, independent of exchange-time checks', async () => {
  const configRoot = await makeConfigRoot();
  const resourceA = new URL('https://mcp-a.example.com/mcp');
  const resourceB = new URL('https://mcp-b.example.com/mcp');

  const verifyGoogleIdentity = async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true });

  const providerA = new GmailOAuthProvider({ configRoot, resources: [{ url: resourceA, name: 'A' }], google: FAKE_GOOGLE, verifyGoogleIdentity });
  const providerB = new GmailOAuthProvider({ configRoot, resources: [{ url: resourceB, name: 'B' }], google: FAKE_GOOGLE, verifyGoogleIdentity });

  // Mint a token scoped to resourceB's audience, entirely through providerB's
  // own real authorize -> callback -> consent -> exchange path (not by
  // hand-crafting a store record), so this is a token exactly as issuance
  // would produce.
  const client = makeClient();
  const { verifier, challenge } = pkce();
  const { code } = await loginAndApprove(providerB, client, { challenge, scopes: ['read'] }, 'irrelevant');

  const tokens = await providerB.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0]);

  // providerA (a different resource/audience) must refuse a token minted for
  // providerB's resource, even though both share the same on-disk token store.
  await assert.rejects(() => verify(providerA, tokens.access_token, resourceA), /resource/i);

  // And it is accepted by the provider it actually belongs to.
  const authInfo = await verify(providerB, tokens.access_token, resourceB);
  assert.equal(authInfo.resource.href, resourceB.href);
});

test('authorize() refuses a resource that is not this server\'s own canonical URI, before any Google redirect state is created', async () => {
  const configRoot = await makeConfigRoot();
  const resourceUrl = new URL('https://mcp.example.com/mcp');
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: resourceUrl, name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
  });
  const client = makeClient();
  const { challenge } = pkce();
  const res = fakeRes();

  await assert.rejects(
    () =>
      provider.authorize(
        client,
        {
          codeChallenge: challenge,
          redirectUri: client.redirect_uris[0],
          resource: new URL('https://evil.example.com/mcp'),
        },
        res,
      ),
    /resource/i,
  );
  assert.equal(res.calls.redirects.length, 0, 'must not redirect to Google for a rejected resource');
});

test('authorize() refuses an unsupported scope before any Google redirect is issued', async () => {
  const configRoot = await makeConfigRoot();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
  });
  const client = makeClient();
  const { challenge } = pkce();
  const res = fakeRes();

  await assert.rejects(
    () =>
      provider.authorize(client, { codeChallenge: challenge, redirectUri: client.redirect_uris[0], scopes: ['mail:admin'] }, res),
    /[Ss]cope/,
  );
  assert.equal(res.calls.redirects.length, 0);
});

test('a Google identity that is on the allowlist but unverified (email_verified: false) is refused, never reaching consent', async () => {
  const configRoot = await makeConfigRoot();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: false }),
  });
  const client = makeClient();
  const { challenge } = pkce();
  const authRes = fakeRes();
  await provider.authorize(client, { codeChallenge: challenge, redirectUri: client.redirect_uris[0] }, authRes);
  const googleState = new URL(authRes.calls.redirects[0].url).searchParams.get('state');

  const callbackRes = fakeRes();
  await provider.handleGoogleCallback({ state: googleState, code: 'x' }, callbackRes);
  assert.equal(callbackRes.calls.statuses.length, 0, 'must not render a consent page for an unverified identity');
  const redirected = new URL(callbackRes.calls.redirects[0].url);
  assert.equal(redirected.searchParams.get('error'), 'access_denied');
  assert.equal(redirected.searchParams.get('code'), null);
});

test('CRITICAL fix: an attacker-registered client walking /authorize with no scope does NOT receive a code without an explicit Approve', async () => {
  const configRoot = await makeConfigRoot();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
  });
  // "Attacker" DCR-registers a client with their own redirect_uri -- open by
  // design per ADR 013 -- then walks /authorize with NO scope param, exactly
  // the reported PoC. Calling clientsStore.registerClient directly (rather
  // than going through the SDK's own /register HTTP handler, which is what
  // normally assigns client_id before calling this) means this test has to
  // assign the id itself, same as the SDK handler would.
  const attackerClient = await provider.clientsStore.registerClient({
    client_id: 'attacker-client-1',
    redirect_uris: ['https://attacker.example.com/steal'],
    client_name: 'Totally Legit Assistant',
  });
  const { challenge } = pkce();
  const authRes = fakeRes();
  await provider.authorize(attackerClient, { codeChallenge: challenge, redirectUri: attackerClient.redirect_uris[0] }, authRes);
  const googleState = new URL(authRes.calls.redirects[0].url).searchParams.get('state');

  // The real owner completes a REAL Google login (stubbed here, but a real
  // success from the owner's own account, exactly as the PoC describes).
  const callbackRes = fakeRes();
  await provider.handleGoogleCallback({ state: googleState, code: 'owner-really-logged-in' }, callbackRes);

  // The bug: this used to redirect straight to the attacker's redirect_uri
  // with a real code. The fix: it must render a consent page instead, and
  // the attacker's redirect_uri must never be contacted at this point.
  assert.equal(callbackRes.calls.redirects.length, 0, 'no redirect to the attacker must happen before consent');
  assert.equal(callbackRes.calls.statuses[0], 200);
  const html = callbackRes.calls.bodies[0];
  assert.match(html, /attacker\.example\.com/, 'the consent page must name the real redirect_uri host so a phish is visible');
  assert.match(html, /Totally Legit Assistant/, 'self-reported client_name is shown too (labelled unverified)');
  assert.match(html, /write: Change them/i, 'the actual requested scope (default: full access) must be disclosed');

  // Without an Approve, no code exists anywhere the attacker's redirect_uri
  // could have received one -- assert directly against the provider's own
  // exchange path: the pendingId is still claimable exactly once, but only a
  // decision of "approve" mints a code.
  const denyRes = fakeRes();
  await provider.handleConsentDecision({ pendingId: googleState, decision: 'deny' }, denyRes);
  const denied = new URL(denyRes.calls.redirects[0].url);
  assert.equal(denied.origin + denied.pathname, attackerClient.redirect_uris[0]);
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  assert.equal(denied.searchParams.get('code'), null, 'a denial must never carry a code');

  // And the pendingId is now burned -- a second attempt (e.g. the attacker
  // racing a POST of their own guess, or a replay) gets nothing either.
  const replayRes = fakeRes();
  await provider.handleConsentDecision({ pendingId: googleState, decision: 'approve' }, replayRes);
  assert.equal(replayRes.calls.statuses[0], 400);
});

test('an approved consent decision issues a code that exchanges normally', async () => {
  const configRoot = await makeConfigRoot();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
  });
  const client = makeClient();
  const { verifier, challenge } = pkce();
  const { code } = await loginAndApprove(provider, client, { challenge }, 'x');
  const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0]);
  assert.ok(tokens.access_token);
  const authInfo = await verify(provider, tokens.access_token);
  assert.deepEqual(authInfo.scopes.sort(), ['read', 'write']);
});

test('MEDIUM fix: two concurrent exchanges of the same authorization code -- exactly one succeeds', async () => {
  const configRoot = await makeConfigRoot();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
  });
  const client = makeClient();
  const { verifier, challenge } = pkce();
  const { code } = await loginAndApprove(provider, client, { challenge }, 'x');

  const attempts = await Promise.allSettled([
    provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0]),
    provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0]),
  ]);

  const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
  const rejected = attempts.filter((a) => a.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent exchange of a single-use code must succeed');
  assert.equal(rejected.length, 1, 'the other concurrent exchange must be rejected, not silently ignored');
  assert.match(rejected[0].reason.message, /invalid|expired/i);
});

test('an authorization code is single-use under sequential reuse too: a second exchange attempt is rejected', async () => {
  const configRoot = await makeConfigRoot();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
  });
  const client = makeClient();
  const { verifier, challenge } = pkce();
  const { code } = await loginAndApprove(provider, client, { challenge }, 'x');

  await provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0]);
  await assert.rejects(() => provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0]), /invalid|expired/i);
});

test('exchangeRefreshToken mints a new access token with the same scopes/resource, and rejects a scope widen attempt', async () => {
  const configRoot = await makeConfigRoot();
  const resourceUrl = new URL('https://mcp.example.com/mcp');
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: resourceUrl, name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
  });
  const client = makeClient();
  const { verifier, challenge } = pkce();
  const { code } = await loginAndApprove(provider, client, { challenge, scopes: ['read'] }, 'x');
  const firstTokens = await provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0]);
  assert.ok(firstTokens.refresh_token);

  const refreshed = await provider.exchangeRefreshToken(client, firstTokens.refresh_token);
  assert.notEqual(refreshed.access_token, firstTokens.access_token, 'refresh should mint a new access token');
  assert.equal(refreshed.scope, 'read');

  const authInfo = await verify(provider, refreshed.access_token);
  assert.deepEqual(authInfo.scopes, ['read']);

  // Cannot use a refresh to grab a scope beyond what was originally granted.
  await assert.rejects(
    () => provider.exchangeRefreshToken(client, firstTokens.refresh_token, ['read', 'write']),
    /scope/i,
  );

  // A refresh token issued to a different client is refused.
  const otherClient = makeClient({ client_id: 'client-2' });
  await assert.rejects(() => provider.exchangeRefreshToken(otherClient, firstTokens.refresh_token), /client/i);
});

test('revokeToken removes the token so a later verifyAccessToken rejects it', async () => {
  const configRoot = await makeConfigRoot();
  const resourceUrl = new URL('https://mcp.example.com/mcp');
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: resourceUrl, name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
  });
  const client = makeClient();
  const { verifier, challenge } = pkce();
  const { code } = await loginAndApprove(provider, client, { challenge }, 'x');
  const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0]);

  await verify(provider, tokens.access_token); // does not throw
  await provider.revokeToken(client, { token: tokens.access_token });
  await assert.rejects(() => verify(provider, tokens.access_token), /invalid|expired|revoked/i);
});

// Ticket: "POST /oauth/consent returns a raw 500, not a clean 400, on a
// malformed request" -- found live 2026-08-29 with a bare `curl -X POST` and
// no body. oauth/router.ts's express.urlencoded() leaves req.body as
// `undefined` (not `{}`) when the request has no recognizable
// Content-Type, and handleConsentDecision used to read `.pendingId` straight
// off that value. This pins the fix at the unit level, directly against the
// provider method a malformed HTTP request ultimately calls into; the
// HTTP-level reproduction lives in test/oauth-http.test.mjs.
test('handleConsentDecision on a malformed body (undefined, null, array, or missing fields) answers cleanly instead of throwing', async () => {
  const configRoot = await makeConfigRoot();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [{ url: new URL('https://mcp.example.com/mcp'), name: 'Mail' }],
    google: FAKE_GOOGLE,
    verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
  });

  for (const malformed of [undefined, null, [], 'not-an-object', {}]) {
    const res = fakeRes();
    // Must not throw -- a throw here is exactly what used to become an
    // unhandled rejection and a raw 500 at the HTTP layer.
    await provider.handleConsentDecision(malformed, res);
    assert.equal(res.calls.statuses[0], 400, `expected 400 for malformed body: ${JSON.stringify(malformed)}`);
    assert.equal(res.calls.redirects.length, 0, 'a malformed request must never be treated as a real decision worth redirecting on');
  }
});
