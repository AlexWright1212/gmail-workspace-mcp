/**
 * Shared OAuth flow primitives for tests.
 *
 * Phase 4 (docs/plans/001-remote-access-migration.md) deleted the shared bearer
 * token, so a test that wants an authenticated `/mcp` request has exactly one
 * way to get one: drive the real authorization-code flow to a real access
 * token. That is more setup than `Authorization: Bearer <constant>` was, and
 * deliberately so -- a test that could authenticate any other way would be
 * testing a path production no longer has.
 *
 * Google is the only thing stubbed (`makeFakeGoogleVerifier`). Registration,
 * PKCE, consent, the code exchange, and audience validation all run for real
 * against the deployed provider code.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Metadata/audience values only -- they do not need to match the host:port the
// test client actually connects to. `http://localhost` satisfies the SDK's
// issuer-URL validation (HTTPS required except for localhost/127.0.0.1)
// without needing to know the ephemeral port in advance.
export const ISSUER_URL = new URL('http://localhost');
export const RESOURCE_URL = new URL('/mcp', ISSUER_URL);
/** The second protected resource (plan 002 Phase 2): the Google Workspace endpoint. */
export const WORKSPACE_RESOURCE_URL = new URL('/workspace/mcp', ISSUER_URL);
export const GOOGLE = {
  clientId: 'google-login-client-id',
  clientSecret: 'google-login-client-secret',
  redirectUri: 'http://localhost/oauth/google/callback',
};

/** The owner identity the allowlist accepts; the default login for tests that don't care. */
export const OWNER_EMAIL = 'ownerpersonal@gmail.com';
export const OWNER_GOOGLE_CODE = 'owner-google-code';
export const OWNER_IDENTITIES = { [OWNER_GOOGLE_CODE]: OWNER_EMAIL };

export async function makeConfigRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'oauth-test-'));
}

export function makeFakeGoogleVerifier(emailByCode) {
  return async (code) => {
    const email = emailByCode[code];
    if (!email) throw new Error('fake Google verifier got an unexpected code: ' + code);
    return { email, emailVerified: true };
  };
}

/**
 * The `endpoints` option for startHttpServer: both real endpoint paths and
 * display names, each served by the given stub factory (or a different one
 * for Workspace). The protected resources -- what a token is bound to -- are
 * derived from this list by createHttpApp, exactly as in production.
 */
export function testEndpoints(createServer, { workspaceCreateServer } = {}) {
  return [
    { path: RESOURCE_URL.pathname, displayName: 'Mail', createServer },
    { path: WORKSPACE_RESOURCE_URL.pathname, displayName: 'Google Workspace', createServer: workspaceCreateServer ?? createServer },
  ];
}

/** The `oauth` option for startHttpServer, wired to a stubbed Google. */
export function oauthOptions(configRoot, googleIdentities = OWNER_IDENTITIES, overrides = {}) {
  return {
    configRoot,
    issuerUrl: ISSUER_URL,
    google: GOOGLE,
    verifyGoogleIdentity: makeFakeGoogleVerifier(googleIdentities),
    log: () => {},
    ...overrides,
  };
}

function base64url(buf) {
  return buf.toString('base64url');
}

export function makePkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export async function registerClient(base, redirectUri, clientName = 'oauth-test-client') {
  const res = await fetch(base + '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: clientName,
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return body;
}

export async function authorize(base, { clientId, redirectUri, challenge, scope, state, resource }) {
  const url = new URL(base + '/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (scope) url.searchParams.set('scope', scope);
  if (state) url.searchParams.set('state', state);
  if (resource) url.searchParams.set('resource', resource);
  return fetch(url, { redirect: 'manual' });
}

export async function googleCallback(base, { pendingId, code, error }) {
  const url = new URL(base + '/oauth/google/callback');
  if (pendingId !== undefined) url.searchParams.set('state', pendingId);
  if (code !== undefined) url.searchParams.set('code', code);
  if (error !== undefined) url.searchParams.set('error', error);
  return fetch(url, { redirect: 'manual' });
}

export async function submitConsent(base, { pendingId, decision }) {
  return fetch(base + '/oauth/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pendingId, decision }),
    redirect: 'manual',
  });
}

export async function exchangeToken(base, body) {
  return fetch(base + '/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

/**
 * Drives authorize() -> Google callback -> the CONSENT step, and returns the
 * consent-page HTML plus the pendingId -- everything a caller needs whether it
 * intends to approve or deny.
 */
export async function loginToConsentScreen(
  base,
  { redirectUri, clientId, challenge, scope, state, resource, googleCode },
) {
  const authorizeRes = await authorize(base, { clientId, redirectUri, challenge, scope, state, resource });
  assert.equal(authorizeRes.status, 302);
  const googleUrl = new URL(authorizeRes.headers.get('location'));
  assert.equal(googleUrl.origin, 'https://accounts.google.com');
  const pendingId = googleUrl.searchParams.get('state');
  assert.ok(pendingId);

  const callbackRes = await googleCallback(base, { pendingId, code: googleCode });
  // The CRITICAL fix under test: identity success renders a consent page --
  // status 200, HTML -- rather than redirecting straight back to the client
  // with a code. A regression to the old direct-redirect behaviour fails here,
  // not just in the dedicated phishing-scenario test.
  assert.equal(
    callbackRes.status,
    200,
    'expected the consent page, got a redirect: ' + callbackRes.headers.get('location'),
  );
  const html = await callbackRes.text();
  assert.match(html, /Authorize this application/);
  assert.match(html, new RegExp(clientId));

  return { pendingId, html };
}

/**
 * The whole outer+inner flow to a minted token, approving consent along the
 * way. Fails via assertions if login or consent is refused -- callers that
 * EXPECT a refusal drive the pieces above directly instead.
 */
export async function completeLoginAndGetToken(
  base,
  { googleCode = OWNER_GOOGLE_CODE, scope, resource, clientName } = {},
) {
  const redirectUri = 'https://client.example.com/callback';
  const client = await registerClient(base, redirectUri, clientName);
  const { verifier, challenge } = makePkcePair();
  const outerState = 'outer-state-' + crypto.randomBytes(4).toString('hex');

  const { pendingId } = await loginToConsentScreen(base, {
    redirectUri,
    clientId: client.client_id,
    challenge,
    scope,
    state: outerState,
    resource,
    googleCode,
  });

  const consentRes = await submitConsent(base, { pendingId, decision: 'approve' });
  assert.equal(consentRes.status, 302);
  const backToClient = new URL(consentRes.headers.get('location'));
  assert.equal(backToClient.origin + backToClient.pathname, redirectUri);
  assert.equal(backToClient.searchParams.get('state'), outerState);
  const code = backToClient.searchParams.get('code');
  assert.ok(code, 'expected an authorization code, got: ' + backToClient.href);

  const tokenRes = await exchangeToken(base, {
    grant_type: 'authorization_code',
    code,
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    ...(resource ? { resource } : {}),
  });
  const tokens = await tokenRes.json();
  assert.equal(tokenRes.status, 200, JSON.stringify(tokens));
  assert.ok(tokens.access_token);
  return { tokens, client, verifier, redirectUri };
}

/** Shorthand: just the access token string, full scopes, for the owner, bound to Mail unless `resource` says otherwise. */
export async function mintAccessToken(base, options = {}) {
  const { tokens } = await completeLoginAndGetToken(base, {
    scope: 'read write',
    resource: RESOURCE_URL.href,
    ...options,
  });
  return tokens.access_token;
}
