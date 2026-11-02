import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { startHttpServer } from '../dist/http/server.js';
import { assertToolScopeAllowed, ScopeDeniedError } from '../dist/http/scopes.js';
// Extracted to test/helpers/oauth.mjs during Phase 4 so the transport,
// raw-socket and request-log suites -- all of which lost the shared bearer
// token and now need a real one -- drive the SAME flow this file asserts
// against, rather than a second copy of it that could drift.
import {
  GOOGLE,
  ISSUER_URL,
  RESOURCE_URL,
  authorize,
  completeLoginAndGetToken,
  exchangeToken,
  googleCallback,
  loginToConsentScreen,
  makeConfigRoot,
  makeFakeGoogleVerifier,
  makePkcePair,
  registerClient,
  submitConsent,
  testEndpoints,
} from './helpers/oauth.mjs';

// The exact value the deployed server accepted until Phase 4 removed it. Kept
// only so the regression test below can prove it is no longer special.
const RETIRED_BEARER_TOKEN = 'legacy-bearer-token';

// A stub server matching index.ts's real (request, extra) handler shape: the
// scope gate is called once, before dispatch, and a denial is returned as
// ordinary tool-result text -- exactly like SendNotAllowedError today -- not
// as a protocol-level error. See src/index.ts's CallToolRequestSchema handler
// and its catch block's special-casing of ScopeDeniedError.
function makeServerFactory(stats) {
  return () => {
    stats.built += 1;
    const server = new Server(
      { name: 'stub', version: '0.0.0' },
      { capabilities: { tools: {} }, instructions: 'stub server' },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'read_emails', description: 'read', inputSchema: { type: 'object', properties: {} } },
        { name: 'send_message', description: 'write', inputSchema: { type: 'object', properties: {} } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      try {
        assertToolScopeAllowed(name, extra.authInfo);
      } catch (error) {
        if (error instanceof ScopeDeniedError) {
          return { content: [{ type: 'text', text: error.message }] };
        }
        throw error;
      }
      return { content: [{ type: 'text', text: 'ok:' + name }] };
    });
    return {
      connectTransport: async (transport) => {
        stats.connected += 1;
        await server.connect(transport);
      },
      close: async () => {
        stats.closed += 1;
        await server.close();
      },
    };
  };
}

async function withOAuthServer(options, fn) {
  const configRoot = await makeConfigRoot();
  const stats = { built: 0, connected: 0, closed: 0 };

  const running = await startHttpServer({
    endpoints: testEndpoints(makeServerFactory(stats)),
    port: 0,
    host: '127.0.0.1',
    log: () => {},
    ...options,
    oauth:
      options.oauth === null
        ? undefined
        : {
            configRoot,
            issuerUrl: ISSUER_URL,
            google: GOOGLE,
            verifyGoogleIdentity: makeFakeGoogleVerifier(options.googleIdentities ?? {}),
            log: () => {},
            ...options.oauth,
          },
  });

  const base = 'http://127.0.0.1:' + running.port;

  try {
    return await fn({ base, running, stats, configRoot, resourceUrl: RESOURCE_URL, issuerUrl: ISSUER_URL });
  } finally {
    await running.close();
  }
}

test('DCR -> authorize -> Google callback -> token exchange -> /mcp round trip succeeds for an allowlisted email', async () => {
  await withOAuthServer(
    { googleIdentities: { 'good-code': 'ownerpersonal@gmail.com' } },
    async ({ base }) => {
      const { tokens } = await completeLoginAndGetToken(base, { googleCode: 'good-code' });

      const client = new Client({ name: 'test-client', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + tokens.access_token } },
      });
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((t) => t.name).sort(),
        ['read_emails', 'send_message'],
      );
      const called = await client.callTool({ name: 'read_emails', arguments: {} });
      assert.equal(called.content[0].text, 'ok:read_emails');
      await client.close();
    },
  );
});

test('a Google identity not on the owner allowlist is refused, and no MCP code is ever issued', async () => {
  await withOAuthServer(
    { googleIdentities: { 'stranger-code': 'someone.else@gmail.com' } },
    async ({ base }) => {
      const redirectUri = 'https://client.example.com/callback';
      const client = await registerClient(base, redirectUri);
      const { challenge } = makePkcePair();

      const authorizeRes = await authorize(base, {
        clientId: client.client_id,
        redirectUri,
        challenge,
        state: 'outer-state',
      });
      const googleUrl = new URL(authorizeRes.headers.get('location'));
      const pendingId = googleUrl.searchParams.get('state');

      const callbackRes = await googleCallback(base, { pendingId, code: 'stranger-code' });
      assert.equal(callbackRes.status, 302);
      const backToClient = new URL(callbackRes.headers.get('location'));
      assert.equal(backToClient.origin + backToClient.pathname, redirectUri);
      assert.equal(backToClient.searchParams.get('error'), 'access_denied');
      assert.equal(backToClient.searchParams.get('code'), null, 'no authorization code may be issued for a refused identity');
      assert.equal(backToClient.searchParams.get('state'), 'outer-state');
    },
  );
});

test('CRITICAL fix (HTTP-level PoC reproduction): an attacker-registered client cannot obtain a code merely because the real owner completes real Google login', async () => {
  await withOAuthServer(
    { googleIdentities: { 'owner-really-logged-in': 'ownerpersonal@gmail.com' } },
    async ({ base }) => {
      // Attacker DCR-registers a client, publicly, exactly as ADR 013 allows.
      const attackerRedirectUri = 'https://attacker.example.com/steal';
      const attackerClient = await registerClient(base, attackerRedirectUri);
      const { challenge } = makePkcePair();

      // Attacker sends the owner a /authorize link with NO scope param (the
      // reported PoC) -- this is exactly a link the attacker could email or
      // otherwise get the owner to click.
      const authorizeRes = await authorize(base, {
        clientId: attackerClient.client_id,
        redirectUri: attackerRedirectUri,
        challenge,
      });
      assert.equal(authorizeRes.status, 302);
      const googleUrl = new URL(authorizeRes.headers.get('location'));
      const pendingId = googleUrl.searchParams.get('state');

      // The real owner completes a REAL Google login (stubbed here as the
      // verifier fake, but standing in for the owner's own account).
      const callbackRes = await googleCallback(base, { pendingId, code: 'owner-really-logged-in' });

      // THE BUG: this used to be a 302 straight to attacker.example.com with
      // a real, usable authorization code -- no screen ever named the app.
      // THE FIX: it must be the consent page instead, and the attacker's
      // redirect_uri must not have been contacted at all.
      assert.notEqual(callbackRes.status, 302, 'must not redirect to the attacker without consent');
      assert.equal(callbackRes.status, 200);
      const html = await callbackRes.text();
      assert.match(html, new RegExp(attackerClient.client_id));
      assert.match(html, /attacker\.example\.com/, 'the real redirect_uri host must be disclosed, not hidden');

      // Denying must produce no code, ever, at the attacker's redirect_uri.
      const denyRes = await submitConsent(base, { pendingId, decision: 'deny' });
      assert.equal(denyRes.status, 302);
      const denied = new URL(denyRes.headers.get('location'));
      assert.equal(denied.origin + denied.pathname, attackerRedirectUri);
      assert.equal(denied.searchParams.get('code'), null, 'a denial must never carry a code to the attacker');
      assert.equal(denied.searchParams.get('error'), 'access_denied');

      // And the consent decision is itself single-use -- approving after a
      // deny (or any replay) gets nothing.
      const replayRes = await submitConsent(base, { pendingId, decision: 'approve' });
      assert.equal(replayRes.status, 400);
    },
  );
});

test('MEDIUM fix (HTTP-level): firing two concurrent /token exchanges of one authorization code, exactly one succeeds', async () => {
  await withOAuthServer({ googleIdentities: { 'race-code': 'ownerpersonal@gmail.com' } }, async ({ base }) => {
    const redirectUri = 'https://client.example.com/callback';
    const client = await registerClient(base, redirectUri);
    const { verifier, challenge } = makePkcePair();

    const { pendingId } = await loginToConsentScreen(base, {
      redirectUri,
      clientId: client.client_id,
      challenge,
      googleCode: 'race-code',
    });
    const consentRes = await submitConsent(base, { pendingId, decision: 'approve' });
    const code = new URL(consentRes.headers.get('location')).searchParams.get('code');
    assert.ok(code);

    const exchangeOnce = () =>
      exchangeToken(base, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: client.client_id,
      });

    const [first, second] = await Promise.all([exchangeOnce(), exchangeOnce()]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 400], 'exactly one concurrent /token exchange of a single-use code must succeed');
  });
});

test('a read-only token is denied on a write tool; a write token is let through', async () => {
  await withOAuthServer(
    { googleIdentities: { 'read-code': 'ownerpersonal@gmail.com', 'write-code': 'ownerpersonal@gmail.com' } },
    async ({ base }) => {
      const { tokens: readOnly } = await completeLoginAndGetToken(base, { googleCode: 'read-code', scope: 'read' });
      const { tokens: readWrite } = await completeLoginAndGetToken(base, { googleCode: 'write-code', scope: 'read write' });

      const callWithToken = async (token, toolName) => {
        const client = new Client({ name: 'test-client', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
          requestInit: { headers: { Authorization: 'Bearer ' + token } },
        });
        await client.connect(transport);
        const result = await client.callTool({ name: toolName, arguments: {} });
        await client.close();
        return result;
      };

      const denied = await callWithToken(readOnly.access_token, 'send_message');
      assert.match(denied.content[0].text, /cannot call "send_message"/);
      assert.match(denied.content[0].text, /"write"/);

      const allowed = await callWithToken(readWrite.access_token, 'send_message');
      assert.equal(allowed.content[0].text, 'ok:send_message');

      // The read-only token still works for what it IS scoped for.
      const stillReads = await callWithToken(readOnly.access_token, 'read_emails');
      assert.equal(stillReads.content[0].text, 'ok:read_emails');
    },
  );
});

// The inverse of the test this replaces. Until Phase 4 the shared bearer token
// was accepted on /mcp alongside OAuth, and was tested here as such. Deleting
// it is the point of Phase 4, so what needs pinning now is that presenting it
// gets you nothing: a value that used to be a full-access credential must be
// treated as just another unknown token, with no special-cased path left.
test('the deleted shared bearer token is now refused like any unknown token', async () => {
  await withOAuthServer({ googleIdentities: {} }, async ({ base, stats }) => {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + RETIRED_BEARER_TOKEN,
      },
      body: '{}',
    });
    assert.equal(res.status, 401);
    // It fails through the ordinary OAuth verifier -- same 401, same
    // WWW-Authenticate discovery hint as any other bad token. No separate
    // code path survives for it.
    assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="/);
    await res.text();
    assert.equal(stats.built, 0, 'a refused request must never reach the MCP layer');
  });
});

test('/mcp with no OAuth token is 401 with WWW-Authenticate pointing at PRM', async () => {
  await withOAuthServer({ googleIdentities: {} }, async ({ base }) => {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    assert.equal(res.status, 401);
    const wwwAuth = res.headers.get('www-authenticate') ?? '';
    assert.match(wwwAuth, /^Bearer /);
    assert.match(wwwAuth, /resource_metadata="/);
  });
});

test('a wrong/garbage bearer on /mcp is 401 via the OAuth verifier path', async () => {
  await withOAuthServer({ googleIdentities: {} }, async ({ base }) => {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer not-a-real-token',
      },
      body: '{}',
    });
    assert.equal(res.status, 401);
  });
});

test('authorization server metadata and protected resource metadata are served spec-shaped', async () => {
  await withOAuthServer({ googleIdentities: {} }, async ({ base, resourceUrl, issuerUrl }) => {
    const asMeta = await fetch(base + '/.well-known/oauth-authorization-server');
    assert.equal(asMeta.status, 200);
    const asBody = await asMeta.json();
    assert.equal(asBody.issuer, issuerUrl.href);
    assert.equal(asBody.authorization_endpoint, issuerUrl.href.replace(/\/$/, '') + '/authorize');
    assert.equal(asBody.token_endpoint, issuerUrl.href.replace(/\/$/, '') + '/token');
    assert.equal(asBody.registration_endpoint, issuerUrl.href.replace(/\/$/, '') + '/register');
    assert.deepEqual(asBody.scopes_supported, ['read', 'write']);

    // RFC 9728's spec-correct location: PRM path-suffixed to match the
    // resource's own path (our resource is .../mcp).
    const prmAtSpecPath = await fetch(base + '/.well-known/oauth-protected-resource/mcp');
    assert.equal(prmAtSpecPath.status, 200);
    const prmBody = await prmAtSpecPath.json();
    assert.equal(prmBody.resource, resourceUrl.href);
    assert.deepEqual(prmBody.authorization_servers, [issuerUrl.href]);

    // The bare-path alias this server adds defensively (see oauth/router.ts).
    const prmBare = await fetch(base + '/.well-known/oauth-protected-resource');
    assert.equal(prmBare.status, 200);
    const prmBareBody = await prmBare.json();
    assert.deepEqual(prmBareBody, prmBody);
  });
});

test('the consent page HTML-escapes an attacker-supplied client_name (regression pin, docs/adr/013 Correction)', async () => {
  // ADR 013's Correction section and the Minor tickets list both call out
  // that this is correct today only because it was checked by hand -- nothing
  // in the suite pinned it. DCR lets any client set client_name to anything
  // (it is explicitly "self-reported, not verified" on the rendered page), so
  // a client_name containing markup is the realistic attack: if
  // renderConsentPage/escapeHtml ever regresses, this is what a real exploit
  // would look like, not a synthetic string nobody would actually send.
  await withOAuthServer(
    { googleIdentities: { 'xss-code': 'ownerpersonal@gmail.com' } },
    async ({ base }) => {
      const redirectUri = 'https://client.example.com/callback';
      const maliciousName = '<script>alert(document.cookie)</script>&"\'';

      const registerRes = await fetch(base + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_name: maliciousName,
        }),
      });
      const client = await registerRes.json();
      assert.equal(registerRes.status, 201, JSON.stringify(client));

      const { challenge } = makePkcePair();
      const authorizeRes = await authorize(base, { clientId: client.client_id, redirectUri, challenge });
      assert.equal(authorizeRes.status, 302);
      const googleUrl = new URL(authorizeRes.headers.get('location'));
      const pendingId = googleUrl.searchParams.get('state');

      const callbackRes = await googleCallback(base, { pendingId, code: 'xss-code' });
      assert.equal(callbackRes.status, 200);
      const html = await callbackRes.text();

      // The raw, executable form must never appear in the served bytes.
      assert.doesNotMatch(html, /<script>alert\(document\.cookie\)<\/script>/, 'client_name must never reach the page unescaped');
      // The escaped form must be present -- pins escapeHtml actually running
      // on this field, not just "no script tag found anywhere by accident".
      assert.match(html, /&lt;script&gt;alert\(document\.cookie\)&lt;\/script&gt;/);
      assert.match(html, /&amp;/, 'the literal & in the malicious name must be escaped');
      assert.match(html, /&quot;|&#39;/, 'the quote characters in the malicious name must be escaped');
    },
  );
});

test('POST /oauth/consent with a malformed request (no body/content-type) is a clean 400, not a raw 500 (ticket: found live 2026-08-29)', async () => {
  await withOAuthServer({ googleIdentities: {} }, async ({ base }) => {
    // Exactly the reproduction from the ticket: a bare POST with no body and
    // no Content-Type. router.ts's per-route express.urlencoded() leaves
    // req.body as `undefined` for this request, which used to make
    // handleConsentDecision throw reading `.pendingId` off it.
    const bareRes = await fetch(base + '/oauth/consent', { method: 'POST' });
    assert.equal(bareRes.status, 400, 'a request with no body must not 500');
    assert.notEqual(bareRes.status, 500);

    // A well-formed but semantically-unknown pendingId must keep behaving
    // exactly as before this fix (a clean 400) -- this fix must not have
    // widened what gets accepted.
    const unknownRes = await submitConsent(base, { pendingId: 'nonexistent-pending-id', decision: 'approve' });
    assert.equal(unknownRes.status, 400);

    // A garbage JSON body (wrong content-type entirely for this route) must
    // not 500 either.
    const jsonRes = await fetch(base + '/oauth/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pendingId: 'x', decision: 'approve' }),
    });
    assert.notEqual(jsonRes.status, 500);
  });
});

test('registered clients and issued tokens survive a process restart (new provider, same configRoot)', async () => {
  await withOAuthServer(
    { googleIdentities: { 'persist-code': 'ownerpersonal@gmail.com' } },
    async ({ base, configRoot, resourceUrl, issuerUrl }) => {
      const { tokens, client } = await completeLoginAndGetToken(base, { googleCode: 'persist-code' });

      const { GmailOAuthProvider } = await import('../dist/http/oauth/provider.js');
      const revivedProvider = new GmailOAuthProvider({
        configRoot,
        resources: [{ url: resourceUrl, name: 'Mail' }],
        google: { clientId: 'x', clientSecret: 'y', redirectUri: 'https://example.com/cb' },
        verifyGoogleIdentity: async () => {
          throw new Error('not used in this test');
        },
      });

      const revivedClient = await revivedProvider.clientsStore.getClient(client.client_id);
      assert.ok(revivedClient, 'registered client did not survive a fresh provider instance on the same configRoot');
      assert.deepEqual(revivedClient.redirect_uris, client.redirect_uris);

      const authInfo = await revivedProvider.verifierFor(resourceUrl).verifyAccessToken(tokens.access_token);
      assert.equal(authInfo.clientId, client.client_id);
      assert.deepEqual(authInfo.scopes.sort(), ['read', 'write']);
    },
  );
});
