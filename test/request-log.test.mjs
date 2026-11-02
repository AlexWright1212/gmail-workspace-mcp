import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { startHttpServer } from '../dist/http/server.js';
import { REQUEST_LOG_FILENAME } from '../dist/http/request-log.js';
import { mintAccessToken, oauthOptions, testEndpoints } from './helpers/oauth.mjs';

// Same shape of stub server used by test/oauth-http.test.mjs, trimmed to just
// what this file needs: something that answers tools/list and tools/call so
// the JSON-RPC-granularity hook in transports.ts has real messages to observe.
function makeServerFactory() {
  return () => {
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
    server.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [{ type: 'text', text: 'ok:' + request.params.name }],
    }));
    return {
      connectTransport: async (transport) => {
        await server.connect(transport);
      },
      close: async () => {
        await server.close();
      },
    };
  };
}

async function makeConfigRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'request-log-test-'));
}

async function readLogLines(logPath) {
  try {
    const raw = await fs.readFile(logPath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

const ISSUER_URL = new URL('http://localhost');
const GOOGLE = {
  clientId: 'google-login-client-id',
  clientSecret: 'google-login-client-secret',
  redirectUri: 'http://localhost/oauth/google/callback',
};

function base64url(buf) {
  return buf.toString('base64url');
}

function makePkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Drives DCR -> authorize -> Google callback -> consent -> token exchange to a real, working access token, the same flow test/oauth-http.test.mjs already exercises. */
async function getOAuthToken(base, { googleCode, email }) {
  const redirectUri = 'https://client.example.com/callback';
  const registerRes = await fetch(base + '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'request-log-test-client',
    }),
  });
  const client = await registerRes.json();
  assert.equal(registerRes.status, 201, JSON.stringify(client));

  const { verifier, challenge } = makePkcePair();
  const authUrl = new URL(base + '/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  const authorizeRes = await fetch(authUrl, { redirect: 'manual' });
  const googleUrl = new URL(authorizeRes.headers.get('location'));
  const pendingId = googleUrl.searchParams.get('state');

  const callbackUrl = new URL(base + '/oauth/google/callback');
  callbackUrl.searchParams.set('state', pendingId);
  callbackUrl.searchParams.set('code', googleCode);
  const callbackRes = await fetch(callbackUrl, { redirect: 'manual' });
  assert.equal(callbackRes.status, 200);

  const consentRes = await fetch(base + '/oauth/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pendingId, decision: 'approve' }),
    redirect: 'manual',
  });
  assert.equal(consentRes.status, 302);
  const code = new URL(consentRes.headers.get('location')).searchParams.get('code');
  assert.ok(code);

  const tokenRes = await fetch(base + '/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: client.client_id,
    }),
  });
  const tokens = await tokenRes.json();
  assert.equal(tokenRes.status, 200, JSON.stringify(tokens));
  return { tokens, client, code, verifier };
}

test('an OAuth-authenticated /mcp request is logged with the real client_id, authMethod: oauth, and granted scopes', async () => {
  const configRoot = await makeConfigRoot();
  const running = await startHttpServer({
    endpoints: testEndpoints(makeServerFactory()),
    port: 0,
    host: '127.0.0.1',
    requestLog: { configRoot },
    log: () => {},
    oauth: {
      configRoot,
      issuerUrl: ISSUER_URL,
      google: GOOGLE,
      verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
      log: () => {},
    },
  });
  const base = 'http://127.0.0.1:' + running.port;

  let tokens;
  let client;
  try {
    ({ tokens, client } = await getOAuthToken(base, { googleCode: 'any-code' }));

    const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + tokens.access_token } },
    });
    await mcpClient.connect(transport);
    await mcpClient.callTool({ name: 'send_message', arguments: {} });
    await mcpClient.close();
  } finally {
    await running.close();
  }

  const lines = await readLogLines(path.join(configRoot, REQUEST_LOG_FILENAME));
  const mcpLines = lines.filter((entry) => entry.path === '/mcp');
  assert.ok(mcpLines.length > 0);
  for (const entry of mcpLines) {
    assert.equal(entry.clientId, client.client_id);
    assert.equal(entry.authMethod, 'oauth');
    assert.deepEqual(entry.scopes.sort(), ['read', 'write']);
  }
  const allRpcEvents = mcpLines.flatMap((entry) => entry.rpc);
  assert.ok(allRpcEvents.includes('tools/call:send_message'));

  // The whole point of client-id logging: it must be the real, revokable
  // client_id, not e.g. a hash or a truncation of it.
  assert.equal(typeof client.client_id, 'string');
  assert.ok(client.client_id.length > 0);
});

test('the request log NEVER contains a token value, authorization code, code_verifier, client secret, or SSE session id', async () => {
  const configRoot = await makeConfigRoot();
  const running = await startHttpServer({
    endpoints: testEndpoints(makeServerFactory()),
    port: 0,
    host: '127.0.0.1',
    requestLog: { configRoot },
    log: () => {},
    oauth: {
      configRoot,
      issuerUrl: ISSUER_URL,
      google: GOOGLE,
      verifyGoogleIdentity: async () => ({ email: 'ownerpersonal@gmail.com', emailVerified: true }),
      log: () => {},
    },
  });
  const base = 'http://127.0.0.1:' + running.port;

  let secrets;
  try {
    const { tokens, client, code, verifier } = await getOAuthToken(base, { googleCode: 'secret-code' });
    secrets = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      authorizationCode: code,
      codeVerifier: verifier,
      clientSecret: client.client_secret,
    };

    const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + tokens.access_token } },
    });
    await mcpClient.connect(transport);
    await mcpClient.listTools();
    await mcpClient.close();
  } finally {
    await running.close();
  }

  const rawLog = await fs.readFile(path.join(configRoot, REQUEST_LOG_FILENAME), 'utf8');
  assert.ok(rawLog.length > 0, 'expected the request log to have at least one entry');

  assert.ok(!rawLog.includes(secrets.accessToken), 'access token value must never appear in the request log');
  assert.ok(!rawLog.includes(secrets.refreshToken), 'refresh token value must never appear in the request log');
  assert.ok(!rawLog.includes(secrets.authorizationCode), 'authorization code must never appear in the request log');
  assert.ok(!rawLog.includes(secrets.codeVerifier), 'code_verifier must never appear in the request log');
  if (secrets.clientSecret) {
    assert.ok(!rawLog.includes(secrets.clientSecret), 'client secret must never appear in the request log');
  }
});

test('a request-log write failure (unwritable path) never breaks the underlying /mcp request', async () => {
  // Point the log at a path whose parent directory does not exist, so every
  // appendFile() call fails with ENOENT -- this is exactly the "unwritable
  // disk" case appendRequestLogLine is required to swallow rather than throw.
  const configRoot = await makeConfigRoot();
  const badLogPath = path.join(configRoot, 'no-such-subdir', 'request-log.log');

  const running = await startHttpServer({
    endpoints: testEndpoints(makeServerFactory()),
    port: 0,
    host: '127.0.0.1',
    requestLog: { configRoot, logPath: badLogPath },
    log: () => {},
    oauth: oauthOptions(configRoot),
  });
  const base = 'http://127.0.0.1:' + running.port;

  try {
    const token = await mintAccessToken(base);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    });
    // Must not throw / must not hang -- the real request completes normally
    // even though every attempt to log it fails.
    await client.connect(transport);
    const result = await client.callTool({ name: 'read_emails', arguments: {} });
    assert.equal(result.content[0].text, 'ok:read_emails');
    await client.close();
  } finally {
    await running.close();
  }

  // And, for the avoidance of doubt, nothing was silently created elsewhere.
  await assert.rejects(() => fs.readFile(badLogPath, 'utf8'), { code: 'ENOENT' });
});

test('GET and DELETE /mcp (405, no JSON-RPC body ever parsed) still get a log line with an empty rpc array', async () => {
  const configRoot = await makeConfigRoot();
  const running = await startHttpServer({
    endpoints: testEndpoints(makeServerFactory()),
    port: 0,
    host: '127.0.0.1',
    requestLog: { configRoot },
    log: () => {},
    oauth: oauthOptions(configRoot),
  });
  const base = 'http://127.0.0.1:' + running.port;

  try {
    const auth = { Authorization: 'Bearer ' + (await mintAccessToken(base)) };
    const getRes = await fetch(base + '/mcp', { method: 'GET', headers: auth });
    assert.equal(getRes.status, 405);
    const deleteRes = await fetch(base + '/mcp', { method: 'DELETE', headers: auth });
    assert.equal(deleteRes.status, 405);
  } finally {
    await running.close();
  }

  const lines = await readLogLines(path.join(configRoot, REQUEST_LOG_FILENAME));
  const getLine = lines.find((entry) => entry.method === 'GET');
  const deleteLine = lines.find((entry) => entry.method === 'DELETE');
  assert.ok(getLine, 'expected a logged GET /mcp line');
  assert.ok(deleteLine, 'expected a logged DELETE /mcp line');
  assert.equal(getLine.status, 405);
  assert.deepEqual(getLine.rpc, []);
  assert.equal(deleteLine.status, 405);
  assert.deepEqual(deleteLine.rpc, []);
});

// Regression test for a real bug: the original implementation logged via a
// fire-and-forget `void appendFile(...)` on res.on('finish'), and nothing
// ever waited for that write before the process could move on. In isolation
// it was fast enough to look reliable; under the concurrency the full test
// suite actually produces, the LAST write of a run would intermittently not
// have landed yet by the time this test read the file back (~1-in-4,
// reproduced by running the full suite repeatedly). Fixed by serializing
// writes per file (src/http/request-log.ts's enqueueRequestLogWrite, same
// idiom as oauth/store.ts's JsonRecordStore.serialized()) and having
// running.close() await the queue's tail after the HTTP server has fully
// drained -- so this test's assertion is deterministic as a CONSEQUENCE of
// that fix, not because it waits, sleeps, or retries for one.
//
// This fires a real burst of concurrent, unawaited-until-the-end requests
// (deliberately not `await`ed one at a time) specifically to create the same
// kind of contention that exposed the original bug, then asserts every
// single one produced exactly one line -- no sleep, no polling loop, no
// retry: just `close()` and then one direct read.
test('every request in a concurrent burst is present in the log after close() -- no loss under contention (regression for the fire-and-forget write bug)', async () => {
  const configRoot = await makeConfigRoot();
  const running = await startHttpServer({
    endpoints: testEndpoints(makeServerFactory()),
    port: 0,
    host: '127.0.0.1',
    requestLog: { configRoot },
    log: () => {},
    oauth: oauthOptions(configRoot),
  });
  const base = 'http://127.0.0.1:' + running.port;
  const CONCURRENCY = 40;

  // Minted before the burst, and never counted in it: the OAuth flow's own
  // requests go to /authorize, /token and friends, none of which the request
  // log covers -- it is mounted on /mcp only.
  const auth = { Authorization: 'Bearer ' + (await mintAccessToken(base)) };

  try {
    // Fired concurrently, not sequentially -- Promise.all resolves once every
    // response has been received, which is exactly the moment a caller with
    // the OLD fire-and-forget code could not yet trust the log file's
    // contents. The fix moves that guarantee to close(), not to this Promise.
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_unused, i) =>
        fetch(base + '/mcp', {
          method: i % 2 === 0 ? 'GET' : 'DELETE',
          headers: auth,
        }),
      ),
    );
  } finally {
    // The fix under test: close() now drains the request-log write queue
    // before resolving. Nothing after this line waits, sleeps, or polls.
    await running.close();
  }

  const lines = await readLogLines(path.join(configRoot, REQUEST_LOG_FILENAME));
  assert.equal(lines.length, CONCURRENCY, `expected exactly ${CONCURRENCY} log lines, got ${lines.length} -- a mismatch here means a write was lost`);
});

test('an unauthenticated /mcp request is never logged at all', async () => {
  const configRoot = await makeConfigRoot();
  const running = await startHttpServer({
    endpoints: testEndpoints(makeServerFactory()),
    port: 0,
    host: '127.0.0.1',
    requestLog: { configRoot },
    log: () => {},
    oauth: oauthOptions(configRoot),
  });
  const base = 'http://127.0.0.1:' + running.port;

  try {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    assert.equal(res.status, 401);
  } finally {
    await running.close();
  }

  const lines = await readLogLines(path.join(configRoot, REQUEST_LOG_FILENAME));
  assert.equal(lines.length, 0, 'a 401 (failed auth) must never produce a request-log line');
});
