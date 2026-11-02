// Plan 002 Phase 2: one authorization server, two protected resources --
// Mail at /mcp and Google Workspace at /workspace/mcp. These tests pin the
// guarantees that phase added and that nothing else in the suite covers:
//
//  - A token minted for one endpoint is refused by the other, both ways,
//    over real HTTP through the real gate (the plan's non-negotiable).
//  - Each endpoint serves its own RFC 9728 metadata naming ITSELF as the
//    resource, and each 401 points at its own metadata URL.
//  - The consent page names the endpoint being authorized.
//  - Retired scope names fail closed (plan 002 Phase 6): a token or refresh
//    token stored under the pre-rename `mail:read`/`mail:write` names is
//    refused so the client re-authorizes -- never translated (the Phase 2
//    alias is gone) and never passed through to the tool gate.
//  - GET/DELETE on /workspace/mcp are 405, like /mcp.
//  - The provider's own verifyAccessToken is NOT a usable verifier.
//
// Google is stubbed; everything else -- registration, PKCE, consent, the code
// exchange, audience validation, the gate -- runs for real against dist/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { startHttpServer } from '../dist/http/server.js';
import { assertToolScopeAllowed, ScopeDeniedError } from '../dist/http/scopes.js';
import { GmailOAuthProvider } from '../dist/http/oauth/provider.js';
import { dedupeScopes, allScopesSupported } from '../dist/http/scope-names.js';
import {
  ISSUER_URL,
  RESOURCE_URL,
  WORKSPACE_RESOURCE_URL,
  OWNER_EMAIL,
  authorize,
  completeLoginAndGetToken,
  exchangeToken,
  loginToConsentScreen,
  makeConfigRoot,
  makePkcePair,
  mintAccessToken,
  oauthOptions,
  registerClient,
  testEndpoints,
} from './helpers/oauth.mjs';

// Two distinguishable stub servers, so a test can tell which endpoint
// actually answered. Both apply the real scope gate the way
// src/mcp-server.ts does.
function makeStub(label, toolNames) {
  return () => {
    const server = new Server(
      { name: 'stub-' + label, version: '0.0.0' },
      { capabilities: { tools: {} }, instructions: 'stub ' + label },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolNames.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        assertToolScopeAllowed(request.params.name, extra.authInfo);
      } catch (error) {
        if (error instanceof ScopeDeniedError) return { content: [{ type: 'text', text: error.message }] };
        throw error;
      }
      return { content: [{ type: 'text', text: label + ':' + request.params.name }] };
    });
    return {
      connectTransport: (transport) => server.connect(transport),
      close: () => server.close(),
    };
  };
}

async function withTwoEndpoints(fn, { googleIdentities } = {}) {
  const configRoot = await makeConfigRoot();
  const running = await startHttpServer({
    endpoints: testEndpoints(makeStub('mail', ['read_emails', 'send_message']), {
      // Workspace has no tools yet (Phase 3 adds them); `read_emails` is here
      // only so a scope-gated call can be made through it in a test.
      workspaceCreateServer: makeStub('workspace', []),
    }),
    port: 0,
    host: '127.0.0.1',
    log: () => {},
    oauth: oauthOptions(configRoot, googleIdentities),
  });
  const base = 'http://127.0.0.1:' + running.port;
  try {
    return await fn({ base, configRoot, running });
  } finally {
    await running.close();
  }
}

async function rawPost(base, endpointPath, token) {
  return fetch(base + endpointPath, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

async function mcpClient(base, endpointPath, token) {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(base + endpointPath), {
    requestInit: { headers: { Authorization: 'Bearer ' + token } },
  });
  await client.connect(transport);
  return client;
}

test('a token minted for /mcp is refused at /workspace/mcp, and vice versa, each 401 naming its own metadata', async () => {
  await withTwoEndpoints(async ({ base }) => {
    const mailToken = await mintAccessToken(base, { resource: RESOURCE_URL.href });
    const workspaceToken = await mintAccessToken(base, { resource: WORKSPACE_RESOURCE_URL.href });

    // Each token works where it belongs.
    const mailOk = await rawPost(base, '/mcp', mailToken);
    assert.equal(mailOk.status, 200);
    await mailOk.text();
    const workspaceOk = await rawPost(base, '/workspace/mcp', workspaceToken);
    assert.equal(workspaceOk.status, 200);
    await workspaceOk.text();

    // ...and nowhere else. The 401's WWW-Authenticate must point at the
    // metadata of the endpoint that REFUSED, so a client re-authorizes for
    // the right audience instead of retrying the same wrong token.
    const crossed = await rawPost(base, '/workspace/mcp', mailToken);
    assert.equal(crossed.status, 401);
    assert.match(
      crossed.headers.get('www-authenticate') ?? '',
      /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/workspace\/mcp"/,
    );
    await crossed.text();

    const reversed = await rawPost(base, '/mcp', workspaceToken);
    assert.equal(reversed.status, 401);
    assert.match(
      reversed.headers.get('www-authenticate') ?? '',
      /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
    await reversed.text();
  });
});

test('each endpoint serves its own protected resource metadata, naming itself; the bare alias still names Mail', async () => {
  await withTwoEndpoints(async ({ base }) => {
    const mailPrm = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(mailPrm.resource, RESOURCE_URL.href);
    assert.deepEqual(mailPrm.authorization_servers, [ISSUER_URL.href]);
    assert.deepEqual(mailPrm.scopes_supported, ['read', 'write']);
    assert.equal(mailPrm.resource_name, 'Mail MCP server');

    const workspacePrm = await (await fetch(base + '/.well-known/oauth-protected-resource/workspace/mcp')).json();
    assert.equal(workspacePrm.resource, WORKSPACE_RESOURCE_URL.href);
    assert.deepEqual(workspacePrm.authorization_servers, [ISSUER_URL.href]);
    assert.deepEqual(workspacePrm.scopes_supported, ['read', 'write']);
    assert.equal(workspacePrm.resource_name, 'Google Workspace MCP server');

    const bare = await (await fetch(base + '/.well-known/oauth-protected-resource')).json();
    assert.deepEqual(bare, mailPrm);

    // One authorization server for both.
    const asMeta = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    assert.equal(asMeta.issuer, ISSUER_URL.href);
    assert.deepEqual(asMeta.scopes_supported, ['read', 'write']);
  });
});

test('the consent page names the endpoint being authorized', async () => {
  await withTwoEndpoints(async ({ base }) => {
    const redirectUri = 'https://client.example.com/callback';
    const client = await registerClient(base, redirectUri, 'Some Agent');

    const { html: mailHtml } = await loginToConsentScreen(base, {
      redirectUri,
      clientId: client.client_id,
      challenge: makePkcePair().challenge,
      resource: RESOURCE_URL.href,
      googleCode: 'owner-google-code',
    });
    assert.match(mailHtml, /access to your <strong>Mail<\/strong> endpoint/);
    assert.match(mailHtml, new RegExp(RESOURCE_URL.href.replace(/[/.]/g, '\\$&')));
    assert.doesNotMatch(mailHtml, /Google Workspace/);

    const { html: workspaceHtml } = await loginToConsentScreen(base, {
      redirectUri,
      clientId: client.client_id,
      challenge: makePkcePair().challenge,
      resource: WORKSPACE_RESOURCE_URL.href,
      googleCode: 'owner-google-code',
    });
    assert.match(workspaceHtml, /access to your <strong>Google Workspace<\/strong> endpoint/);
    assert.match(workspaceHtml, new RegExp(WORKSPACE_RESOURCE_URL.href.replace(/[/.]/g, '\\$&')));
    // The scopes are described in plain words with their names, so the owner
    // can match what a client asked for to what is written here.
    assert.match(workspaceHtml, /read: Look at your mail, files/);
    assert.match(workspaceHtml, /write: Change them/);
  });
});

test('a client that omits `resource` gets a Mail token (the first endpoint), exactly as before Phase 2', async () => {
  await withTwoEndpoints(async ({ base }) => {
    const { tokens } = await completeLoginAndGetToken(base, { scope: 'read' });
    const ok = await rawPost(base, '/mcp', tokens.access_token);
    assert.equal(ok.status, 200);
    await ok.text();
    const refused = await rawPost(base, '/workspace/mcp', tokens.access_token);
    assert.equal(refused.status, 401);
    await refused.text();
  });
});

test('an unknown resource is refused at /authorize before any Google redirect', async () => {
  await withTwoEndpoints(async ({ base }) => {
    const redirectUri = 'https://client.example.com/callback';
    const client = await registerClient(base, redirectUri);
    const url = new URL(base + '/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', client.client_id);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code_challenge', makePkcePair().challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', new URL('/other/mcp', ISSUER_URL).href);
    const res = await fetch(url, { redirect: 'manual' });
    // The SDK reports a rejected resource by redirecting back to the client
    // with error=invalid_target -- never to Google.
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(location.origin + location.pathname, redirectUri);
    assert.equal(location.searchParams.get('error'), 'invalid_target');
    await res.text();
  });
});

test('GET and DELETE on /workspace/mcp are 405 with Allow: POST, same as /mcp', async () => {
  await withTwoEndpoints(async ({ base }) => {
    const token = await mintAccessToken(base, { resource: WORKSPACE_RESOURCE_URL.href });
    const get = await fetch(base + '/workspace/mcp', { headers: { Authorization: 'Bearer ' + token, accept: 'text/event-stream' } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    await get.text();
    const del = await fetch(base + '/workspace/mcp', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
    assert.equal(del.status, 405);
    await del.text();
  });
});

test('the Workspace endpoint completes initialize + tools/list with its own (empty) tool list', async () => {
  await withTwoEndpoints(async ({ base }) => {
    const token = await mintAccessToken(base, { resource: WORKSPACE_RESOURCE_URL.href });
    const client = await mcpClient(base, '/workspace/mcp', token);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools, []);
    await client.close();

    const mailToken = await mintAccessToken(base, { resource: RESOURCE_URL.href });
    const mail = await mcpClient(base, '/mcp', mailToken);
    assert.deepEqual((await mail.listTools()).tools.map((t) => t.name).sort(), ['read_emails', 'send_message']);
    await mail.close();
  });
});

// ---- Retired scope names fail closed (plan 002 Phase 6) ----
//
// Phase 2 carried the old names through an alias; Phase 6 rewrote every
// stored record on the VPS (`clients.sh migrate-scopes`) and deleted it.
// What these pin is the failure mode for any record that still spells a
// scope the old way -- a restored backup, a hand edit: the client must be
// sent back to consent, not translated (a second spelling of the same
// permission) and not waved through to the tool gate under a name it does
// not know (a 403 at every tool with no way out).

test('dedupeScopes drops duplicates and translates nothing; allScopesSupported knows only read and write', () => {
  assert.deepEqual(dedupeScopes(['read', 'read', 'write']), ['read', 'write']);
  assert.deepEqual(dedupeScopes(['mail:read']), ['mail:read']);
  assert.deepEqual(dedupeScopes([]), []);
  assert.equal(allScopesSupported(['read', 'write']), true);
  assert.equal(allScopesSupported([]), true);
  assert.equal(allScopesSupported(['mail:read']), false);
  assert.equal(allScopesSupported(['read', 'mail:write']), false);
});

test('an access token stored under a retired scope name is a 401 at both endpoints, never presented to the tool gate', async () => {
  await withTwoEndpoints(async ({ base, configRoot }) => {
    // Plant a record exactly as the pre-Phase-2 server wrote them.
    const retiredToken = 'retired-access-token-' + Date.now();
    const tokensPath = path.join(configRoot, 'oauth', 'tokens.json');
    const existing = JSON.parse(await fs.readFile(tokensPath, 'utf8').catch(() => '{}'));
    existing[retiredToken] = {
      token: retiredToken,
      clientId: 'retired-client',
      scopes: ['mail:read', 'mail:write'],
      resource: RESOURCE_URL.href,
      googleEmail: OWNER_EMAIL,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    await fs.writeFile(tokensPath, JSON.stringify(existing), 'utf8');

    const atMail = await rawPost(base, '/mcp', retiredToken);
    assert.equal(atMail.status, 401);
    assert.match(atMail.headers.get('www-authenticate') ?? '', /Bearer/);
    await atMail.text();

    const atWorkspace = await rawPost(base, '/workspace/mcp', retiredToken);
    assert.equal(atWorkspace.status, 401);
    await atWorkspace.text();

    // And a token under the current names on the same store still works, so
    // the refusal is about the names, not the planted file.
    const current = await mintAccessToken(base, { resource: RESOURCE_URL.href });
    const ok = await rawPost(base, '/mcp', current);
    assert.equal(ok.status, 200);
    await ok.text();
  });
});

test('a refresh token stored under a retired scope name is invalid_grant, so the client re-authorizes', async () => {
  await withTwoEndpoints(async ({ base, configRoot }) => {
    const redirectUri = 'https://client.example.com/callback';
    const client = await registerClient(base, redirectUri);

    const retiredRefresh = 'retired-refresh-token-' + Date.now();
    const refreshPath = path.join(configRoot, 'oauth', 'refresh-tokens.json');
    const existing = JSON.parse(await fs.readFile(refreshPath, 'utf8').catch(() => '{}'));
    existing[retiredRefresh] = {
      token: retiredRefresh,
      clientId: client.client_id,
      scopes: ['mail:read', 'mail:write'],
      resource: RESOURCE_URL.href,
      googleEmail: OWNER_EMAIL,
    };
    await fs.writeFile(refreshPath, JSON.stringify(existing), 'utf8');

    for (const scope of [undefined, 'mail:read mail:write', 'read write', 'read']) {
      const res = await exchangeToken(base, {
        grant_type: 'refresh_token',
        refresh_token: retiredRefresh,
        client_id: client.client_id,
        ...(scope ? { scope } : {}),
      });
      const body = await res.json();
      assert.equal(res.status, 400, `scope=${scope}: ${JSON.stringify(body)}`);
      assert.equal(body.error, 'invalid_grant', `scope=${scope}: ${JSON.stringify(body)}`);
    }

    // No access token was minted along the way.
    const tokens = JSON.parse(await fs.readFile(path.join(configRoot, 'oauth', 'tokens.json'), 'utf8').catch(() => '{}'));
    assert.ok(
      !Object.values(tokens).some((t) => t.clientId === client.client_id),
      'a refused refresh must not leave an access token behind',
    );
  });
});

test('a client asking for the retired names at authorize is refused as an unsupported scope, not translated', async () => {
  await withTwoEndpoints(async ({ base }) => {
    const redirectUri = 'https://client.example.com/callback';
    const client = await registerClient(base, redirectUri);
    const { challenge } = makePkcePair();
    const res = await authorize(base, {
      clientId: client.client_id,
      redirectUri,
      challenge,
      scope: 'mail:read mail:write',
      resource: RESOURCE_URL.href,
    });
    // Refused before any Google redirect: the client is bounced back to its
    // own redirect_uri with invalid_scope, never sent to accounts.google.com.
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(location.origin + location.pathname, redirectUri);
    assert.equal(location.searchParams.get('error'), 'invalid_scope');
    assert.match(location.searchParams.get('error_description') ?? '', /mail:read/);
  });
});

test('the provider\'s own verifyAccessToken is not a usable verifier: it throws rather than accept a token for any endpoint', async () => {
  const configRoot = await makeConfigRoot();
  const provider = new GmailOAuthProvider({
    configRoot,
    resources: [
      { url: RESOURCE_URL, name: 'Mail' },
      { url: WORKSPACE_RESOURCE_URL, name: 'Google Workspace' },
    ],
    google: { clientId: 'x', clientSecret: 'y', redirectUri: 'https://example.com/cb' },
    verifyGoogleIdentity: async () => ({ email: OWNER_EMAIL, emailVerified: true }),
  });
  try {
    await assert.rejects(() => provider.verifyAccessToken('anything'), /verifierFor/);
    assert.throws(() => provider.verifierFor(new URL('/other', ISSUER_URL)), /not one of this provider's protected resources/);
    assert.throws(
      () =>
        new GmailOAuthProvider({
          configRoot,
          resources: [],
          google: { clientId: 'x', clientSecret: 'y', redirectUri: 'https://example.com/cb' },
          verifyGoogleIdentity: async () => ({ email: OWNER_EMAIL, emailVerified: true }),
        }),
      /at least one protected resource/,
    );
  } finally {
    provider.close();
  }
});

test('createHttpApp refuses an empty endpoint list', async () => {
  const configRoot = await makeConfigRoot();
  await assert.rejects(
    () => startHttpServer({ endpoints: [], port: 0, host: '127.0.0.1', log: () => {}, oauth: oauthOptions(configRoot) }),
    /at least one endpoint/,
  );
});
