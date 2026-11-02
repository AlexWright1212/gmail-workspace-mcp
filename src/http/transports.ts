/**
 * Transport wiring for the `/mcp` endpoint.
 *
 * `/mcp` is **stateless Streamable HTTP**: a fresh server + transport per POST,
 * `sessionIdGenerator: undefined`, `enableJsonResponse: true`. Both of those
 * are load-bearing -- a Cloudflare Tunnel cuts idle origin connections and
 * buffers streams, so nothing here may depend on a long-lived stream. The
 * `GET`/`DELETE` -> 405 rule below is the other half of that guarantee.
 *
 * The legacy stateful `/sse` + `/messages` pair was deleted in Phase 4 of
 * docs/plans/001-remote-access-migration.md; see docs/adr/012's Phase 4
 * section. Nothing in this module runs on import.
 */
import type { Request, Response } from 'express';
import { PassThrough } from 'node:stream';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { recordRpcEvent } from './request-log.js';

/**
 * The slice of `McpEndpointServer` (src/mcp-server.ts) the transport layer
 * actually needs.
 *
 * Declared structurally on purpose: nothing under src/http/ imports the
 * server class, and tests substitute a stub. `McpEndpointServer` satisfies
 * this without declaring that it does.
 */
export interface McpServerLike {
  connectTransport(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export type McpServerFactory = () => McpServerLike;

export type Logger = (message: string) => void;

const defaultLog: Logger = (message) => {
  console.error(message);
};

/**
 * DNS-rebinding controls for the Streamable HTTP transport.
 *
 * Parameterised now, left OFF by default, so Phase 1 (Cloudflare Tunnel) can
 * turn them on with configuration instead of a code change. While the server is
 * tailnet-only there is no Host/Origin worth pinning.
 */
export interface DnsRebindingOptions {
  enableDnsRebindingProtection?: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

export interface StreamableHttpEndpoint {
  /** POST /mcp — one request, one transport, one response. */
  handleRequest(req: Request, res: Response): Promise<void>;
  /**
   * GET/DELETE /mcp. Answered here rather than by the transport: a GET would
   * otherwise open a standalone SSE stream, which is exactly what the tunnel
   * cannot carry. The server initiates nothing, so there is nothing to miss.
   */
  handleUnsupportedMethod(req: Request, res: Response): void;
}

/**
 * Ticket 006's default: real tool-call payloads for this server are small
 * (the attachment workflow uses an on-disk outbox rather than base64-encoding
 * file contents into a request -- see docs/human-verification.md step 7b), so
 * a generous-but-bounded single-digit-MB cap costs legitimate traffic nothing.
 * Overridable via MCP_MAX_REQUEST_BODY_BYTES without a code change.
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;

export interface StreamableHttpOptions {
  security?: DnsRebindingOptions;
  log?: Logger;
  /** Maximum POST body size in bytes. Defaults to DEFAULT_MAX_REQUEST_BODY_BYTES. */
  maxRequestBodyBytes?: number;
  /** The endpoint path, for log lines only. Defaults to '/mcp'. */
  path?: string;
}

function tooLargeResponse(res: Response, maxBytes: number): void {
  res.status(413).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: `Payload Too Large: request body exceeds the ${maxBytes}-byte limit.` },
    id: null,
  });
}

/**
 * Wraps the raw Node request stream in a counting pass-through, positioned
 * between the socket and the MCP SDK's transport (see transport.handleRequest
 * below). The SDK reads the raw stream itself -- see this file's module
 * comment and ticket 006 -- so a standard body-parser can't be mounted in
 * front of it; this has to work below the SDK instead.
 *
 * Counts REAL bytes as they arrive rather than trusting Content-Length, which
 * is absent under chunked encoding and untrustworthy even when present.
 * Forwards chunks to the returned stream one-for-one until the running total
 * would exceed `maxBytes`, then stops forwarding and destroys the returned
 * stream with an error -- so nothing downstream of this function ever holds
 * more than `maxBytes` of body in memory, regardless of how much more the
 * client keeps sending.
 *
 * Destroying the returned stream (rather than the real `req`/socket) is
 * deliberate: the SDK's own `req.json()` call sees that error and already
 * turns it into a clean `400 Parse error` JSON-RPC response (its normal
 * malformed-body path) -- tearing down the real connection instead would
 * prevent that response from ever reaching the client. The oversized upload
 * itself is simply drained and discarded from here on, cheaply, without
 * being retained anywhere.
 *
 * The returned object is not a real `IncomingMessage` -- it is a PassThrough
 * with `method`/`url`/`headers`/`rawHeaders`/`socket` copied onto it, which is
 * exactly what @hono/node-server (the library the SDK uses to convert a Node
 * request into a Web Standard `Request`) reads off the object it's given; see
 * its `newRequestFromIncoming`/`newRequest` in
 * node_modules/@modelcontextprotocol/sdk's dependency tree. It is passed to
 * `transport.handleRequest()` in place of `req` below.
 */
function limitRequestBodySize(req: Request, maxBytes: number): Request {
  const guarded = new PassThrough();
  Object.assign(guarded, {
    method: req.method,
    url: req.url,
    headers: req.headers,
    rawHeaders: req.rawHeaders,
    socket: req.socket,
    // The SDK's StreamableHTTPServerTransport.handleRequest reads `.auth` off
    // whatever object it's given (`const authInfo = req.auth;`) to populate
    // per-request scope info for tool dispatch (src/http/scopes.ts). Without
    // copying it here, every request would silently lose its authInfo the
    // moment this wrapper stands in for the real `req` -- caught live by
    // test/oauth-http.test.mjs's scope-enforcement test failing open instead
    // of denying a write tool to a read-only token.
    auth: (req as unknown as { auth?: unknown }).auth,
  });
  // Without this, destroying `guarded` with an error before anything has
  // started reading it would be an unhandled 'error' event -- fatal to the
  // process. The SDK's own reader attaches its own listener once it starts
  // consuming, which is what actually turns the error into a response.
  guarded.on('error', () => {});

  let receivedBytes = 0;
  let limitExceeded = false;

  req.on('data', (chunk: Buffer) => {
    if (limitExceeded) return;
    receivedBytes += chunk.length;
    if (receivedBytes > maxBytes) {
      limitExceeded = true;
      guarded.destroy(new Error(`Request body exceeds the ${maxBytes}-byte limit`));
      return;
    }
    guarded.write(chunk);
  });
  req.on('end', () => {
    if (!limitExceeded) guarded.end();
  });
  req.on('error', (err) => {
    if (!limitExceeded) guarded.destroy(err);
  });

  return guarded as unknown as Request;
}

/**
 * Builds the stateless `/mcp` handler.
 *
 * Per request: one `createServer()` and one `StreamableHTTPServerTransport`,
 * both closed when the response closes. This is the mode the SDK requires —
 * a stateless transport throws if it is reused across requests.
 */
export function createStreamableHttpEndpoint(
  createServer: McpServerFactory,
  options: StreamableHttpOptions = {},
): StreamableHttpEndpoint {
  const log = options.log ?? defaultLog;
  const security = options.security ?? {};
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const endpointPath = options.path ?? '/mcp';

  const handleRequest = async (req: Request, res: Response): Promise<void> => {
    // Cheap upfront rejection when the client is honest about size -- skips
    // spinning up a server/transport entirely. Not the real defense (a
    // missing or lying Content-Length sails past this), just an optimization;
    // limitRequestBodySize below is what actually enforces the cap.
    const declaredLength = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBodyBytes) {
      tooLargeResponse(res, maxRequestBodyBytes);
      return;
    }

    const serverApp = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: security.enableDnsRebindingProtection ?? false,
      ...(security.allowedHosts !== undefined ? { allowedHosts: security.allowedHosts } : {}),
      ...(security.allowedOrigins !== undefined ? { allowedOrigins: security.allowedOrigins } : {}),
    });

    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      void Promise.allSettled([transport.close(), serverApp.close()]);
    };
    res.on('close', dispose);

    try {
      await serverApp.connectTransport(transport);

      // Request-log granularity (Phase 3, Task A), obtained the only way the
      // plan allows: `server.connect()` (inside connectTransport, above) has
      // already set transport.onmessage to the MCP Server's own dispatcher.
      // Wrapping it here observes each JSONRPCMessage AFTER the transport has
      // parsed it off the request -- this reads data the SDK already parsed,
      // it does not touch or re-read the raw stream, and it must never be
      // "fixed" into a body parser (see docs/plans/001, "Non-negotiables":
      // mounting one on /mcp breaks the transport outright).
      const originalOnMessage = transport.onmessage;
      transport.onmessage = <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo): void => {
        try {
          if (message && typeof message === 'object' && 'method' in message && typeof message.method === 'string') {
            let event = message.method;
            if (message.method === 'tools/call') {
              const params = (message as { params?: { name?: unknown } }).params;
              if (params && typeof params.name === 'string') {
                event = `${event}:${params.name}`;
              }
            }
            recordRpcEvent(res, event);
          }
        } catch {
          // A logging hook must never be the reason a real request fails.
        }
        originalOnMessage?.(message, extra);
      };

      await transport.handleRequest(limitRequestBodySize(req, maxRequestBodyBytes), res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('[ghub] ' + endpointPath + ' request failed: ' + message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      } else {
        res.end();
      }
      dispose();
    }
  };

  const handleUnsupportedMethod = (_req: Request, res: Response): void => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed. This endpoint is stateless; use POST.',
      },
      id: null,
    });
  };

  return { handleRequest, handleUnsupportedMethod };
}
