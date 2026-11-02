import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { startHttpServer } from '../dist/http/server.js';
import { makeConfigRoot, mintAccessToken, oauthOptions, testEndpoints } from './helpers/oauth.mjs';

/**
 * Closes a structural gap independent adversarial review found: every other
 * test in this suite drives `/mcp` through an SDK client transport (or
 * `fetch`), both of which build a well-formed request FOR you and hand the
 * server an already-assembled body. That is exactly the shape of test
 * docs/plans/001-remote-access-migration.md warns about by name:
 *
 *   "This is exactly the class of bug that passes a test which posts a
 *   pre-parsed body."
 *
 * -- referring to the "never mount express.json()/urlencoded() globally on
 * /mcp" non-negotiable: the Streamable HTTP transport reads the RAW request
 * stream itself, and a body parser sitting in front of it consumes that
 * stream first, leaving the transport to hang or see an empty body. No test
 * using `fetch`/a client library can ever catch that regression, because
 * those all go through Node's own well-formed HTTP client machinery
 * regardless of what middleware sits on the server side.
 *
 * Since Phase 4 these requests carry a real OAuth access token, minted through
 * the ordinary flow with `fetch`. That is not a contradiction: what must never
 * touch a client library is the request to `/mcp` itself, whose raw stream the
 * transport reads. How the credential in its Authorization header was obtained
 * is irrelevant to the property under test.
 *
 * This test opens a bare `net.Socket`, writes the request line, headers, and
 * JSON-RPC body as hand-assembled bytes -- no `http.request`, no `fetch`, no
 * MCP SDK client transport anywhere in this file -- and reads the response
 * back off the same raw socket, deterministically (by Content-Length, never
 * a fixed sleep or a polling loop). If a future change ever mounts a global
 * body parser ahead of /mcp, this is the test structurally incapable of
 * missing it, unlike every other test in this suite.
 */

function makeServerFactory() {
  return () => {
    const server = new Server(
      { name: 'raw-socket-stub', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'read_emails', description: 'read', inputSchema: { type: 'object', properties: {} } }],
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

/**
 * Sends `rawRequest` (a complete HTTP/1.1 request, request line through
 * body, as one literal string this test built by hand) over a fresh raw TCP
 * socket to `port`, and resolves with the parsed status code, headers, and
 * body once exactly `Content-Length` body bytes have been received.
 *
 * Deliberately NOT based on the socket's 'end'/'close' event or any timer:
 * completion is detected purely by byte count against the response's own
 * declared Content-Length, so this is deterministic regardless of how the
 * underlying TCP stack chooses to chunk the bytes across 'data' events, and
 * needs no sleep or retry loop to be reliable under load.
 */
function sendRawRequest(port, rawRequest) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let headerEnd = -1;
    let contentLength = -1;

    const tryResolve = () => {
      if (headerEnd === -1) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx === -1) return;
        headerEnd = idx + 4;
        const headerText = buffer.subarray(0, idx).toString('utf8');
        const match = headerText.match(/^content-length:\s*(\d+)/im);
        contentLength = match ? Number.parseInt(match[1], 10) : 0;
      }
      if (buffer.length >= headerEnd + contentLength) {
        socket.destroy();
        const headerText = buffer.subarray(0, headerEnd).toString('utf8');
        const bodyText = buffer.subarray(headerEnd, headerEnd + contentLength).toString('utf8');
        const statusLine = headerText.split('\r\n')[0];
        const statusMatch = statusLine.match(/^HTTP\/1\.1 (\d+)/);
        resolve({
          status: statusMatch ? Number.parseInt(statusMatch[1], 10) : undefined,
          headerText,
          body: bodyText,
        });
      }
    };

    socket.on('connect', () => socket.write(rawRequest));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      tryResolve();
    });
    socket.on('error', reject);
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error('raw socket request timed out waiting for a complete response'));
    });
  });
}

function buildRawHttpRequest({ host, path: reqPath, headers, body }) {
  const bodyBuffer = Buffer.from(body ?? '', 'utf8');
  const allHeaders = {
    Host: host,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'Content-Length': String(bodyBuffer.byteLength),
    Connection: 'close',
    ...headers,
  };
  const headerLines = Object.entries(allHeaders)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  return `POST ${reqPath} HTTP/1.1\r\n${headerLines}\r\n\r\n${body ?? ''}`;
}


/**
 * A running server plus a real access token for it. Every /mcp request the
 * tests below make is still hand-assembled bytes over a raw socket -- only the
 * token acquisition uses fetch (see the module comment).
 */
async function withRawServer(fn, startOptions = {}) {
  const configRoot = await makeConfigRoot();
  const running = await startHttpServer({
    endpoints: testEndpoints(makeServerFactory()),
    port: 0,
    host: '127.0.0.1',
    log: () => {},
    oauth: oauthOptions(configRoot),
    ...startOptions,
  });
  try {
    const token = await mintAccessToken('http://127.0.0.1:' + running.port);
    return await fn({ running, token });
  } finally {
    await running.close();
  }
}

test('a hand-crafted raw-socket POST /mcp (no client library, no body parser) gets a real tools/list result', async () => {
  await withRawServer(async ({ running, token }) => {
    const jsonRpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const rawRequest = buildRawHttpRequest({
      host: `127.0.0.1:${running.port}`,
      path: '/mcp',
      headers: { Authorization: 'Bearer ' + token },
      body: jsonRpcBody,
    });

    const response = await sendRawRequest(running.port, rawRequest);

    assert.equal(response.status, 200, `expected 200, got ${response.status}. Headers: ${response.headerText}`);
    const parsed = JSON.parse(response.body);
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, 1);
    assert.deepEqual(
      parsed.result.tools.map((t) => t.name),
      ['read_emails'],
      'expected the real tools/list result, not an empty or hung response',
    );
  });
});

test('a hand-crafted raw-socket POST /mcp can drive a real tools/call end to end', async () => {
  await withRawServer(async ({ running, token }) => {
    const jsonRpcBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'read_emails', arguments: {} },
    });
    const rawRequest = buildRawHttpRequest({
      host: `127.0.0.1:${running.port}`,
      path: '/mcp',
      headers: { Authorization: 'Bearer ' + token },
      body: jsonRpcBody,
    });

    const response = await sendRawRequest(running.port, rawRequest);

    assert.equal(response.status, 200, `expected 200, got ${response.status}. Headers: ${response.headerText}`);
    const parsed = JSON.parse(response.body);
    assert.equal(parsed.id, 7);
    assert.equal(parsed.result.content[0].text, 'ok:read_emails');
  });
});

test('a hand-crafted raw-socket POST /mcp with no Authorization header is a real 401, not a hang', async () => {
  await withRawServer(async ({ running, token }) => {
    const jsonRpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const rawRequest = buildRawHttpRequest({
      host: `127.0.0.1:${running.port}`,
      path: '/mcp',
      headers: {},
      body: jsonRpcBody,
    });

    const response = await sendRawRequest(running.port, rawRequest);
    assert.equal(response.status, 401);
  });
});

/**
 * Ticket 006 -- `/mcp` used to accept and fully buffer a body of any size
 * before anything looked at it (confirmed empirically with a real 30MB POST;
 * see the ticket). These three tests pin the fix, all against a raw socket
 * for the same reason the rest of this file does: `fetch`/an SDK client
 * transport builds a well-formed request for you and can't produce the
 * "declare small, send more" or "never finish the body" shapes below.
 *
 * `maxRequestBodyBytes: 200` keeps the tests fast and the crafted bodies
 * small -- the mechanism under test (a byte counter, not a size-specific
 * code path) behaves identically at 200 bytes and at the real 5MB default.
 */

test('a raw-socket POST /mcp with a Content-Length far past the limit gets 413 without the server waiting for that many bytes', async () => {
  await withRawServer(
    async ({ running, token }) => {
      // Declares 10,000 bytes of body but the socket never sends anywhere
      // near that many -- if the server still answers promptly, the 413 came
      // from the declared header, not from buffering whatever arrived.
      const rawRequest =
        `POST /mcp HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${running.port}\r\n` +
        `Content-Type: application/json\r\n` +
        `Accept: application/json, text/event-stream\r\n` +
        `Authorization: Bearer ${token}\r\n` +
        `Content-Length: 10000\r\n` +
        `Connection: close\r\n\r\n` +
        'x'.repeat(10);

      const response = await sendRawRequest(running.port, rawRequest);
      assert.equal(response.status, 413, `expected 413, got ${response.status}. Headers: ${response.headerText}`);
      const parsed = JSON.parse(response.body);
      assert.equal(parsed.error.code, -32000);
    },
    { maxRequestBodyBytes: 200 },
  );
});

test('a raw-socket POST /mcp streamed with no Content-Length is cut off as soon as real bytes cross the limit, before the body ever completes', async () => {
  await withRawServer(
    async ({ running, token }) => {
      // Transfer-Encoding: chunked, so there is no Content-Length at all for
      // the fast-path check to trust -- this is the case the ticket calls out
      // by name ("absent under chunked encoding"). One chunk alone (300
      // bytes) already exceeds the 200-byte limit, and the terminating
      // zero-length chunk is deliberately never sent: if the server still
      // responds, it reacted to the oversized chunk it already saw, not to
      // "the body finished and turned out too big".
      const chunkData = 'x'.repeat(300);
      const rawRequest =
        `POST /mcp HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${running.port}\r\n` +
        `Content-Type: application/json\r\n` +
        `Accept: application/json, text/event-stream\r\n` +
        `Authorization: Bearer ${token}\r\n` +
        `Transfer-Encoding: chunked\r\n` +
        `Connection: close\r\n\r\n` +
        `${chunkData.length.toString(16)}\r\n${chunkData}\r\n`;

      const response = await sendRawRequest(running.port, rawRequest);
      // The guard destroys its internal stream with an error rather than the
      // real connection (see transports.ts's limitRequestBodySize), which the
      // SDK's own req.json() turns into its existing clean parse-error
      // response -- so this is a real, well-formed 400, not a raw close.
      assert.equal(response.status, 400, `expected a clean 400, got ${response.status}. Headers: ${response.headerText}`);
      const parsed = JSON.parse(response.body);
      assert.equal(parsed.error.code, -32700);
    },
    { maxRequestBodyBytes: 200 },
  );
});

test('a raw-socket POST /mcp body under the configured limit is unaffected and still gets a real result', async () => {
  await withRawServer(
    async ({ running, token }) => {
      const jsonRpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      const rawRequest = buildRawHttpRequest({
        host: `127.0.0.1:${running.port}`,
        path: '/mcp',
        headers: { Authorization: 'Bearer ' + token },
        body: jsonRpcBody,
      });

      const response = await sendRawRequest(running.port, rawRequest);
      assert.equal(response.status, 200, `expected 200, got ${response.status}. Headers: ${response.headerText}`);
      const parsed = JSON.parse(response.body);
      assert.deepEqual(parsed.result.tools.map((t) => t.name), ['read_emails']);
    },
    { maxRequestBodyBytes: 200 },
  );
});
