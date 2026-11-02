/**
 * Assembles the OAuth authorization server's Express surface: the SDK's
 * standard AS endpoints (mcpAuthRouter: /authorize, /token, /register,
 * /revoke, /.well-known/oauth-authorization-server, and RFC 9728 Protected
 * Resource Metadata for the FIRST endpoint at its spec-correct path) plus the
 * things the SDK does not provide -- a PRM route per additional endpoint, the
 * Google-upstream callback, and a bare-path PRM alias (see the inline comment
 * on the `/.well-known/oauth-protected-resource` route below for why it
 * exists).
 *
 * Also builds each endpoint's auth gate. Phase 4 (docs/plans/001) deleted the
 * legacy shared-bearer alternative, so OAuth is now the only way in and the
 * gate's job is correspondingly narrow -- including the case where OAuth is
 * not configured at all, which denies everything rather than falling through.
 *
 * Plan 002 Phase 2: ONE authorization server (one issuer, one client store,
 * one Google login) fronts TWO protected resources -- Mail at /mcp and Google
 * Workspace at /workspace/mcp. The AS metadata is shared; everything
 * resource-shaped (PRM, the 401's resource_metadata hint, the verifier) is
 * per endpoint. See docs/adr/013 and the plan's Phase 2 section.
 */
import express, { type Request, type RequestHandler, type Response } from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { GmailOAuthProvider, SUPPORTED_SCOPES, type Logger, type ProtectedResource } from './provider.js';
import { createGoogleIdentityVerifier, type GoogleIdentityVerifier, type GoogleLoginConfig } from './google.js';

export interface OAuthRuntimeConfig {
  configRoot: string;
  issuerUrl: URL;
  /** Every endpoint this server issues tokens for, first = default audience. Non-empty. */
  resources: ProtectedResource[];
  google: GoogleLoginConfig;
  /** Overridable only for tests; production always exchanges with real Google. */
  verifyGoogleIdentity?: GoogleIdentityVerifier;
  log?: Logger;
}

export interface MountedOAuth {
  /** Mount at the application root -- the SDK's handlers assume this. */
  router: RequestHandler;
  provider: GmailOAuthProvider;
  resources: ProtectedResource[];
}

function resourceName(resource: ProtectedResource): string {
  return `${resource.name} MCP server`;
}

/** The RFC 9728 PRM URL to advertise in WWW-Authenticate on a 401 for this endpoint. */
export function prmUrlFor(resourceUrl: URL): string {
  return getOAuthProtectedResourceMetadataUrl(resourceUrl);
}

export function buildOAuth(config: OAuthRuntimeConfig): MountedOAuth {
  const log = config.log ?? ((): void => {});

  if (config.resources.length === 0) {
    throw new Error('buildOAuth: at least one protected resource is required.');
  }
  const [primary, ...others] = config.resources;

  const provider = new GmailOAuthProvider({
    configRoot: config.configRoot,
    resources: config.resources,
    google: config.google,
    verifyGoogleIdentity: config.verifyGoogleIdentity ?? createGoogleIdentityVerifier(config.google),
    log,
  });

  const router = express.Router();

  // Installs GET/POST /authorize, POST /token, POST /register, POST /revoke,
  // GET /.well-known/oauth-authorization-server, and GET
  // /.well-known/oauth-protected-resource/mcp (RFC 9728's "insert before the
  // resource's path" location, since our resource is .../mcp, not the bare
  // origin). Each handler mounts its own per-route body parser internally --
  // nothing here adds a global express.json()/urlencoded().
  //
  // The SDK router can advertise exactly one protected resource, so it gets
  // the primary (Mail); the others get hand-mounted PRM routes below that
  // serve the same shape.
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.issuerUrl,
      resourceServerUrl: primary.url,
      scopesSupported: [...SUPPORTED_SCOPES],
      resourceName: resourceName(primary),
    }),
  );

  const prmBody = (resource: ProtectedResource): Record<string, unknown> => ({
    resource: resource.url.href,
    authorization_servers: [config.issuerUrl.href],
    scopes_supported: [...SUPPORTED_SCOPES],
    resource_name: resourceName(resource),
  });

  // One PRM per additional endpoint, at the RFC 9728 path-suffixed location
  // (`/.well-known/oauth-protected-resource/workspace/mcp` for
  // `/workspace/mcp`). This is what tells a spec-following client which
  // `resource` to request a token for: the MCP SDK's client takes the
  // `resource` value from this document, so a wrong value here would mint
  // tokens for the wrong endpoint and have them refused at the gate.
  for (const resource of others) {
    const prmPath = new URL(prmUrlFor(resource.url)).pathname;
    router.get(prmPath, (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(prmBody(resource));
    });
  }

  // RFC 9728 PRM is already served above at the spec-correct, path-suffixed
  // location. This alias serves byte-identical metadata for the PRIMARY
  // resource at the bare, no-suffix path some client implementations assume
  // instead of constructing the "insert before path" URL themselves. Every
  // 401 this server sends states the exact PRM URL in WWW-Authenticate (see
  // createMcpAuthGate below), so a spec-correct client never needs this
  // alias at all -- it exists only as a defensive compatibility fallback, and
  // it can only ever name one resource, so it names Mail, as it always has.
  router.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(prmBody(primary));
  });

  // The inner flow's landing point (see docs/adr/013). Must exactly match the
  // redirect URI registered on the GOOGLE_LOGIN_CLIENT_ID web client in GCP
  // Console: `${PUBLIC_URL}/oauth/google/callback`. Renders the consent page
  // on success rather than completing the outer flow directly -- see
  // provider.ts's class doc comment for why.
  router.get('/oauth/google/callback', (req: Request, res: Response) => {
    void provider.handleGoogleCallback(req.query as Record<string, unknown>, res).catch((error: unknown) => {
      log(`[oauth] Unhandled error in Google callback: ${(error as Error).message}`);
      if (!res.headersSent) {
        res.status(500).type('text/plain').send('Internal error completing Google login.');
      }
    });
  });

  // The consent page's form target (see provider.ts's handleConsentDecision).
  // A plain HTML form POST, hence its own urlencoded body parser scoped to
  // exactly this one route -- never mounted globally, same rule every other
  // OAuth endpoint here already follows.
  router.post('/oauth/consent', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    void provider.handleConsentDecision(req.body as Record<string, unknown>, res).catch((error: unknown) => {
      log(`[oauth] Unhandled error in consent decision: ${(error as Error).message}`);
      if (!res.headersSent) {
        res.status(500).type('text/plain').send('Internal error completing authorization.');
      }
    });
  });

  return { router, provider, resources: config.resources };
}

export interface McpAuthGateOptions {
  /**
   * Present only when OAuth is configured (PUBLIC_URL + GOOGLE_LOGIN_*).
   * Absent means the one-time bootstrap in docs/adr/013 has not happened --
   * see the fail-closed note on createMcpAuthGate below.
   */
  oauth?: MountedOAuth;
  /**
   * Which endpoint this gate guards. Required when `oauth` is present: the
   * verifier it builds accepts tokens for this resource and no other, and
   * the 401 it sends names this resource's own metadata URL.
   */
  resourceUrl?: URL;
}

/**
 * One endpoint's gate: a valid OAuth access token minted FOR THAT ENDPOINT,
 * or nothing. Since Phase 4 there is no second accepted credential -- the
 * shared bearer token is gone (ADR 007's amendment, ADR 013's Phase 4
 * section).
 *
 * **Fails closed when `oauth` is absent.** While the bearer token existed, an
 * unconfigured OAuth layer was harmless: the bearer still gated /mcp. It is
 * now the only gate, so "OAuth not configured" must mean "nothing gets in",
 * never "no gate is mounted". This mirrors ADR 003's rule for
 * endpoints.json: a config that failed to load enables nothing, not
 * everything. src/index.ts additionally refuses to boot the HTTP transport at
 * all in that state -- this is the second, structural half of the same
 * guarantee, so that any caller of createHttpApp (a test included) cannot
 * accidentally raise an ungated endpoint.
 *
 * A request that gets through carries `req.auth`, set by the SDK's
 * requireBearerAuth, which is what makes the per-tool scope gate
 * (src/http/scopes.ts) apply at dispatch. Nothing reaching tool dispatch over
 * HTTP has `authInfo: undefined` any more.
 */
export function createMcpAuthGate(options: McpAuthGateOptions): RequestHandler {
  const oauth = options.oauth;
  if (!oauth) {
    return (_req: Request, res: Response): void => {
      res.status(503).type('text/plain').send('Unauthorized: this server has no authorization server configured.');
    };
  }
  if (!options.resourceUrl) {
    throw new Error('createMcpAuthGate: resourceUrl is required when OAuth is configured.');
  }

  // Handles its own 401 (with WWW-Authenticate: Bearer resource_metadata="...")
  // for a missing/invalid/expired/wrong-audience token. No `requiredScopes` is
  // passed here on purpose -- per-tool scope enforcement happens later, at
  // dispatch (src/http/scopes.ts), not at the transport gate, since the gate
  // has no idea yet which tool the request is calling.
  return requireBearerAuth({
    verifier: oauth.provider.verifierFor(options.resourceUrl),
    resourceMetadataUrl: prmUrlFor(options.resourceUrl),
  });
}
