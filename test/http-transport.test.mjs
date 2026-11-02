import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { resolveHttpConfigFromEnv, startHttpServer } from '../dist/http/server.js';
import { makeConfigRoot, mintAccessToken, oauthOptions, testEndpoints } from './helpers/oauth.mjs';

// A stand-in for GmailMultiInboxServer. It cannot be the real one: src/index.ts
// self-executes on import, which is exactly the property Phase 0 exists to work
// around. What is under test here is the transport layer, not the tool list.
function makeServerFactory(stats) {
  return () => {
    stats.built += 1;
    const server = new Server(
      { name: 'stub', version: '0.0.0' },
      { capabilities: { tools: {} }, instructions: 'stub server' },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'ping',
          description: 'Returns pong.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [{ type: 'text', text: 'pong:' + request.params.name }],
    }));
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

/**
 * Since Phase 4 there is no shared bearer token, so every authenticated test
 * here needs a real OAuth token. `fn` receives `token` -- already minted
 * through the full authorization-code flow -- and `authHeaders`, the ready-made
 * header object most of these tests want.
 *
 * `stats.built` is reset AFTER minting: the token flow itself never touches
 * /mcp, but resetting makes the per-request server-construction assertions
 * below count only what the test itself drove.
 *
 * Pass `oauth: null` for the deliberately-unconfigured case (see the
 * fail-closed test); the token is then undefined.
 */
async function withServer(options, fn) {
  const stats = { built: 0, connected: 0, closed: 0 };
  const configRoot = await makeConfigRoot();
  const { oauth, ...rest } = options;
  const running = await startHttpServer({
    endpoints: testEndpoints(makeServerFactory(stats)),
    port: 0,
    host: '127.0.0.1',
    log: () => {},
    oauth: oauth === null ? undefined : oauthOptions(configRoot, undefined, oauth ?? {}),
    ...rest,
  });
  const base = 'http://127.0.0.1:' + running.port;
  try {
    const token = oauth === null ? undefined : await mintAccessToken(base);
    stats.built = 0;
    stats.connected = 0;
    stats.closed = 0;
    const authHeaders = token ? { Authorization: 'Bearer ' + token } : {};
    return await fn({ base, running, stats, token, authHeaders });
  } finally {
    await running.close();
  }
}

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw-test-client', version: '0.0.0' },
  },
});

function rawPost(base, path, headers) {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: INITIALIZE_BODY,
  });
}

test('/mcp completes an initialize + tools/list round-trip', async () => {
  await withServer({}, async ({ base, stats, authHeaders }) => {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: authHeaders },
    });

    await client.connect(transport);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ['ping'],
    );

    const called = await client.callTool({ name: 'ping', arguments: {} });
    assert.equal(called.content[0].text, 'pong:ping');

    // Stateless: the client never received a session id to echo back.
    assert.equal(transport.sessionId, undefined);
    // One server + one transport per POST, not one per connection.
    assert.ok(stats.built >= 3, 'expected a fresh server per request, got ' + stats.built);

    await client.close();
  });
});

test('/mcp answers with JSON, not an SSE stream, and issues no session id', async () => {
  await withServer({}, async ({ base, authHeaders }) => {
    const response = await rawPost(base, '/mcp', authHeaders);

    assert.equal(response.status, 200);
    // enableJsonResponse: true. A text/event-stream body here would be the
    // long-lived stream a Cloudflare Tunnel is documented to cut and buffer.
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    // sessionIdGenerator: undefined.
    assert.equal(response.headers.get('mcp-session-id'), null);

    const body = await response.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.result.serverInfo.name, 'stub');
  });
});

test('/mcp rejects a missing, malformed, or unknown OAuth token with 401', async () => {
  await withServer({}, async ({ base, stats, token }) => {
    const missing = await rawPost(base, '/mcp', {});
    assert.equal(missing.status, 401);
    // The SDK's requireBearerAuth answers with the RFC 9728 discovery hint --
    // this is what lets a cold client find the authorization server at all.
    assert.match(missing.headers.get('www-authenticate') ?? '', /resource_metadata="/);
    await missing.text();

    const wrong = await rawPost(base, '/mcp', { Authorization: 'Bearer not-a-real-token' });
    assert.equal(wrong.status, 401);
    await wrong.text();

    // No scheme, just the raw token.
    const malformed = await rawPost(base, '/mcp', { Authorization: token });
    assert.equal(malformed.status, 401);
    await malformed.text();

    // A rejected request must never have reached the MCP layer.
    assert.equal(stats.built, 0);
  });
});

test('/ is not gated, and says what this server actually serves', async () => {
  await withServer({}, async ({ base }) => {
    const root = await fetch(base + '/');
    assert.equal(root.status, 200);
    // Not "ghub SSE server": /sse was deleted in Phase 4 and a health probe
    // that names a route the server no longer has is a lie in the one place
    // an operator looks first.
    assert.equal(await root.text(), 'ghub MCP server');
  });
});

// The routes Phase 4 deleted. Kept as an explicit regression: re-adding
// either without re-deciding ADR 012/013 would silently restore the
// unauthenticated /messages path and the session-id-in-a-query-string
// exposure that made publishing /sse unsafe in the first place.
test('/sse and /messages are gone entirely, not merely gated', async () => {
  await withServer({}, async ({ base, authHeaders }) => {
    const sse = await fetch(base + '/sse', { headers: { ...authHeaders, accept: 'text/event-stream' } });
    assert.equal(sse.status, 404);
    await sse.text();

    const messages = await fetch(base + '/messages?sessionId=nope', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(messages.status, 404);
    await messages.text();
  });
});

// The single most dangerous regression Phase 4 could introduce. Before it, an
// unconfigured OAuth layer was harmless because the bearer token still gated
// /mcp; the mount was `if (bearerToken || mountedOAuth)`. If that condition
// survived the bearer's deletion, "OAuth not configured" would mean "no gate
// mounted at all" -- a wide-open inbox on a publicly-routed hostname.
test('with OAuth unconfigured, /mcp denies everything rather than mounting no gate', async () => {
  await withServer({ oauth: null }, async ({ base, stats }) => {
    const response = await rawPost(base, '/mcp', {});
    assert.equal(response.status, 503);
    assert.match(await response.text(), /no authorization server configured/);
    assert.equal(stats.built, 0, 'an ungated request must never reach the MCP layer');
  });
});

test('GET and DELETE on /mcp are 405, so no standalone SSE stream is ever opened', async () => {
  await withServer({}, async ({ base, authHeaders }) => {
    const get = await fetch(base + '/mcp', {
      headers: { ...authHeaders, accept: 'text/event-stream' },
    });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    const body = await get.json();
    assert.equal(body.error.code, -32000);

    const del = await fetch(base + '/mcp', { method: 'DELETE', headers: authHeaders });
    assert.equal(del.status, 405);
    await del.text();
  });
});

test('resolveHttpConfigFromEnv leaves DNS-rebinding protection off by default', () => {
  const config = resolveHttpConfigFromEnv({ PORT: '3000' });
  assert.equal(config.port, 3000);
  // HOST unset means "do not pass a host to listen()", which preserves the
  // dual-stack bind the server has always had.
  assert.equal(config.host, undefined);
  assert.deepEqual(config.streamableHttpSecurity, {
    enableDnsRebindingProtection: false,
    allowedHosts: undefined,
    allowedOrigins: undefined,
  });
});

test('resolveHttpConfigFromEnv can switch DNS-rebinding protection on by config alone', () => {
  const config = resolveHttpConfigFromEnv({
    PORT: '3000',
    HOST: '127.0.0.1',
    MCP_DNS_REBINDING_PROTECTION: 'true',
    MCP_ALLOWED_HOSTS: 'mcp.example.com, mcp.example.com:443 ',
    MCP_ALLOWED_ORIGINS: 'https://claude.ai',
  });

  assert.equal(config.host, '127.0.0.1');
  assert.deepEqual(config.streamableHttpSecurity, {
    enableDnsRebindingProtection: true,
    allowedHosts: ['mcp.example.com', 'mcp.example.com:443'],
    allowedOrigins: ['https://claude.ai'],
  });
});

test('resolveHttpConfigFromEnv rejects an unusable PORT', () => {
  assert.throws(() => resolveHttpConfigFromEnv({ PORT: 'not-a-port' }), /Invalid PORT value/);
  assert.throws(() => resolveHttpConfigFromEnv({ PORT: '0' }), /Invalid PORT value/);
});

// Stateless mode builds a fresh server + transport per request, so a missed
// teardown is not a leak any single request reveals -- it is a slow OOM on a
// 1GB droplet under real traffic. Pin it: everything built must also be closed.
test('every per-request server and transport is closed again', async () => {
  await withServer({}, async ({ base, stats, authHeaders }) => {
    const post = () =>
      fetch(base + '/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...authHeaders,
        },
        body: INITIALIZE_BODY,
      });

    for (let i = 0; i < 10; i += 1) {
      const res = await post();
      assert.equal(res.status, 200);
      await res.json();
    }

    const concurrent = await Promise.all(Array.from({ length: 10 }, post));
    for (const res of concurrent) {
      assert.equal(res.status, 200);
      await res.json();
    }

    // Teardown is fired after the response is written, so let the loop drain.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(stats.built, 20, 'expected one server per request');
    assert.equal(stats.connected, 20, 'every built server must be connected');
    assert.equal(stats.closed, stats.built, 'every built server must be closed');
  });
});
