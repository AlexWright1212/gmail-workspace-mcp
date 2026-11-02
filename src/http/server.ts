/**
 * Express app assembly and the listen/close pair.
 *
 * The HTTP surface: one stateless, OAuth-gated Streamable HTTP endpoint per
 * entry in endpoints.json (`/mcp` for Mail, `/workspace/mcp` for Google
 * Workspace -- plan 002 Phase 2), the OAuth authorization server's own
 * routes, and an ungated `GET /`.
 *
 * `createHttpApp()` returns a fully wired app without binding a port, so a test
 * can drive it in-process. `startHttpServer()` is the thin wrapper that
 * `src/index.ts` calls. Nothing here runs on import.
 */
import express, { type Express, type Request, type Response } from 'express';
import type { Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createStreamableHttpEndpoint,
  type DnsRebindingOptions,
  type Logger,
  type McpServerFactory,
} from './transports.js';
import { buildOAuth, createMcpAuthGate, type MountedOAuth } from './oauth/router.js';
import { resolveOAuthConfigFromEnv, type OAuthEnvConfig } from './oauth/config.js';
import type { GoogleIdentityVerifier } from './oauth/google.js';
import { createRequestLog, type RequestLogOptions } from './request-log.js';

/**
 * One mountable MCP endpoint. The OAuth resource it is protected as is
 * `issuerUrl + path`, derived here so the mount, the gate, the PRM and the
 * consent page can never disagree about what an endpoint is called or where
 * it lives.
 */
export interface HttpEndpointSpec {
  /** e.g. '/mcp'. Must start with '/'. Endpoints must not nest (src/endpoints.ts enforces this at boot). */
  path: string;
  /** e.g. 'Mail' -- shown on the consent page and in the endpoint's PRM. */
  displayName: string;
  /** Builds one MCP server instance. Called once per request to this endpoint. */
  createServer: McpServerFactory;
}

/** The OAuth config createHttpApp takes: OAuthRuntimeConfig minus `resources`, which it derives from `endpoints`. */
export interface HttpOAuthOptions {
  configRoot: string;
  issuerUrl: URL;
  google: OAuthEnvConfig['google'];
  /** Overridable only for tests; production always exchanges with real Google. */
  verifyGoogleIdentity?: GoogleIdentityVerifier;
  log?: Logger;
}

export interface HttpAppOptions {
  /** Every endpoint to mount, in wire order. Must be non-empty. */
  endpoints: HttpEndpointSpec[];
  /** DNS-rebinding controls for every endpoint. Off unless Phase 1 turns them on. */
  streamableHttpSecurity?: DnsRebindingOptions;
  /** Maximum POST body size in bytes on every endpoint (ticket 006). Defaults inside transports.ts. */
  maxRequestBodyBytes?: number;
  /**
   * OAuth 2.1 authorization server (ADR 013). Since Phase 4 deleted the shared
   * bearer token this is the ONLY way into any endpoint, so omitting it does
   * not produce an open server: every gate below still mounts and denies
   * everything. `src/index.ts` refuses to start the HTTP transport in that
   * state at all.
   */
  oauth?: HttpOAuthOptions;
  /**
   * Per-client request log (Phase 3, Task A of the migration plan). Omit to
   * disable logging entirely -- e.g. tests that don't want log files written.
   */
  requestLog?: RequestLogOptions;
  log?: Logger;
}

export interface HttpApp {
  app: Express;
  /**
   * Resolves once every request-log write enqueued so far has settled. A
   * no-op when no `requestLog` was configured. `startHttpServer`'s `close()`
   * calls this AFTER the HTTP server has stopped accepting connections and
   * drained anything in flight -- see request-log.ts's module doc comment
   * for the data-loss bug this ordering closes (a write still queued when
   * the process exits, e.g. on the `pm2 restart` every deploy triggers, used
   * to be silently lost).
   */
  flushRequestLog(): Promise<void>;
  /**
   * Releases the OAuth provider's background expired-record sweep timer (see
   * GmailOAuthProvider.close, ticket 007). A no-op when no `oauth` was
   * configured. The timer is already `unref()`'d so skipping this never hangs
   * a process, but a caller that constructs more than one HttpApp in the same
   * process (as several test files do) should still call it to avoid
   * accumulating live timers for the rest of that process's life.
   */
  closeOAuth(): void;
}

const defaultLog: Logger = (message) => {
  console.error(message);
};

export function createHttpApp(options: HttpAppOptions): HttpApp {
  const log = options.log ?? defaultLog;
  const app = express();

  if (options.endpoints.length === 0) {
    // Same rule as endpoints.json's loader: a server with nothing to serve
    // must not come up looking healthy.
    throw new Error('createHttpApp: at least one endpoint is required.');
  }
  for (const endpoint of options.endpoints) {
    if (!endpoint.path.startsWith('/')) {
      throw new Error(`createHttpApp: endpoint path "${endpoint.path}" must start with "/".`);
    }
  }

  // Registered before the request log, as it always has been: the health probe
  // is not interesting and is not gated.
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).type('text/plain').send('ghub MCP server');
  });

  app.use((req: Request, _res: Response, next: () => void) => {
    log('[ghub] HTTP ' + req.method + ' ' + req.path);
    next();
  });

  let mountedOAuth: MountedOAuth | undefined;
  if (options.oauth) {
    const issuerUrl = options.oauth.issuerUrl;
    mountedOAuth = buildOAuth({
      ...options.oauth,
      // The protected resources ARE the endpoints: one RFC 8707 audience per
      // mounted path, named for the consent page. Derived from the same list
      // the mounts below iterate, so the two cannot drift.
      resources: options.endpoints.map((endpoint) => ({
        url: new URL(endpoint.path, issuerUrl),
        name: endpoint.displayName,
      })),
      log,
    });
    // MUST be mounted at the application root (the SDK's own requirement) and
    // before any endpoint's routes, so /authorize, /token, /register,
    // /revoke, and /.well-known/* are reachable. Every handler here mounts
    // its own per-route body parser internally — nothing global is added.
    app.use(mountedOAuth.router);
  }

  const requestLog = options.requestLog ? createRequestLog(options.requestLog) : undefined;

  for (const endpoint of options.endpoints) {
    const mcp = createStreamableHttpEndpoint(endpoint.createServer, {
      security: options.streamableHttpSecurity,
      maxRequestBodyBytes: options.maxRequestBodyBytes,
      path: endpoint.path,
      log,
    });

    // Mounted UNCONDITIONALLY, unlike the `if (bearerToken || mountedOAuth)`
    // this replaces. That condition was safe only while a second credential
    // existed; with OAuth the sole gate, a missing config must deny rather
    // than skip the gate. createMcpAuthGate returns a deny-all handler when
    // `oauth` is absent. When it is present, the gate is THIS endpoint's:
    // its verifier accepts tokens minted for this path and no other.
    app.use(
      endpoint.path,
      createMcpAuthGate({
        oauth: mountedOAuth,
        resourceUrl: options.oauth ? new URL(endpoint.path, options.oauth.issuerUrl) : undefined,
      }),
    );

    // Mounted immediately after the gate, never before: only a request the
    // gate has already let through reaches here, which is what makes this
    // "log per AUTHENTICATED request" rather than "log every attempt" for
    // free — an unauthenticated call 401s at the gate above and is never
    // written here. The log line's `path` is what tells the endpoints apart.
    if (requestLog) {
      app.use(endpoint.path, requestLog.middleware);
    }

    app.post(endpoint.path, mcp.handleRequest);
    app.get(endpoint.path, mcp.handleUnsupportedMethod);
    app.delete(endpoint.path, mcp.handleUnsupportedMethod);
  }

  return {
    app,
    flushRequestLog: requestLog?.flush ?? ((): Promise<void> => Promise.resolve()),
    closeOAuth: (): void => mountedOAuth?.provider.close(),
  };
}

export interface HttpServerOptions extends HttpAppOptions {
  port: number;
  /**
   * Interface to bind. Omitted means "whatever Node defaults to" — dual-stack,
   * every interface — which is what the server has always done: the old code
   * read HOST into a variable and then never passed it to listen(). Honouring
   * it is what lets Phase 1 bind 127.0.0.1 behind the tunnel without a code
   * change; leaving it unset keeps today's bind byte-for-byte.
   */
  host?: string;
}

export interface RunningHttpServer {
  app: Express;
  httpServer: NodeHttpServer;
  /** The port actually bound. Differs from the requested one when port 0 is used. */
  port: number;
  /** Stops listening, then flushes the request log. */
  close(): Promise<void>;
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const { app, flushRequestLog, closeOAuth } = createHttpApp(options);

  const httpServer = await new Promise<NodeHttpServer>((resolve, reject) => {
    const onListening = (): void => {
      server.off('error', reject);
      resolve(server);
    };
    const server =
      options.host === undefined
        ? app.listen(options.port, onListening)
        : app.listen(options.port, options.host, onListening);
    server.once('error', reject);
  });

  const address = httpServer.address();
  const boundPort =
    address !== null && typeof address === 'object' ? (address as AddressInfo).port : options.port;

  return {
    app,
    httpServer,
    port: boundPort,
    close: async (): Promise<void> => {
      // httpServer.close()'s callback fires only once every connection has
      // actually finished -- including whatever /mcp request was in flight
      // at the moment close() was called (Node keeps accepted connections
      // alive to let them complete; it only refuses NEW ones). That request
      // already fired 'finish' and enqueued its log write by the time this
      // callback runs, so flushing AFTER this promise resolves, not before,
      // is what makes flushRequestLog() actually see it -- flushing earlier
      // would race the very last request of the server's life.
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await flushRequestLog();
      closeOAuth();
    },
  };
}

export interface HttpConfig {
  port: number;
  host?: string;
  streamableHttpSecurity: DnsRebindingOptions;
  /** Maximum POST /mcp body size in bytes (ticket 006). Undefined means transports.ts's default. */
  maxRequestBodyBytes?: number;
  /**
   * OAuth env config (issuer/Google client), WITHOUT configRoot —
   * deliberately, to keep this function pure over its `env` argument rather
   * than reaching into getConfigRoot()'s real-process-env/home-dir lookup.
   * The caller (src/index.ts's runHttpServer) attaches configRoot before
   * passing this through to startHttpServer; the protected resources come
   * from the endpoint list, not from env. Undefined means the one-time
   * GCP + PUBLIC_URL bootstrap (docs/adr/013) has not happened yet, which
   * since Phase 4 is a fatal misconfiguration rather than a degraded mode —
   * runHttpServer refuses to start on it.
   */
  oauth?: OAuthEnvConfig;
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length > 0 ? items : undefined;
}

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Pure env → config. Kept a function of its argument rather than of
 * `process.env` so a test can pin it without mutating the process.
 */
export function resolveHttpConfigFromEnv(env: NodeJS.ProcessEnv): HttpConfig {
  const port = Number.parseInt(env.PORT ?? env.RAILWAY_PORT ?? '3000', 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('Invalid PORT value: ' + (env.PORT ?? '(missing)'));
  }

  return {
    port,
    host: env.HOST?.trim() || undefined,
    // All three default off. Phase 1 sets them in the environment; no code
    // change is needed to put /mcp behind a fixed Host/Origin.
    streamableHttpSecurity: {
      enableDnsRebindingProtection: isTruthyFlag(env.MCP_DNS_REBINDING_PROTECTION),
      allowedHosts: splitList(env.MCP_ALLOWED_HOSTS),
      allowedOrigins: splitList(env.MCP_ALLOWED_ORIGINS),
    },
    maxRequestBodyBytes: parsePositiveInt(env.MCP_MAX_REQUEST_BODY_BYTES),
    oauth: resolveOAuthConfigFromEnv(env),
  };
}
