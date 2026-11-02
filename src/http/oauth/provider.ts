/**
 * The OAuthServerProvider implementation: this server's own OAuth 2.1
 * authorization server, with the actual login step delegated to Google.
 *
 * THREE steps, deliberately kept distinct (see docs/adr/013, and its
 * phishing-prevention correction):
 *
 *  - The OUTER flow is standard OAuth 2.1 + PKCE between an MCP client (Claude
 *    Code, etc.) and this server: DCR, `authorize`, `token`. Driven by the SDK's
 *    mcpAuthRouter, which calls the methods on this class.
 *  - AUTHENTICATION: `authorize()` does not render a login form; it redirects
 *    to Google. Google then redirects back to `handleGoogleCallback`, which is
 *    NOT part of OAuthServerProvider -- it is a plain Express route mounted by
 *    oauth/router.ts -- and which is the only place that ever sees a Google
 *    token. That token is used once, to read a verified email claim, and is
 *    then discarded. It is never minted into, stored as, or returned as an MCP
 *    access token; this server always mints its own opaque tokens.
 *  - CONSENT: proving WHO is logging in (Google's job) is a different question
 *    from WHAT CLIENT gets to act on their behalf. `handleGoogleCallback`, once
 *    the identity checks out, does NOT immediately complete the outer
 *    authorization -- it renders a consent page naming the requesting client
 *    (client_id and registered redirect_uri host, both trustworthy; a
 *    self-reported client_name too, marked as such, since DCR lets an
 *    attacker set it to anything). Only an explicit Approve, submitted to
 *    `handleConsentDecision`, causes an authorization code to be minted.
 *    Skipping this step is exactly the confused-user vulnerability closed
 *    here: an attacker-registered client could otherwise walk `/authorize`
 *    with no `scope` param and silently receive a full-access token the
 *    moment the real owner completed a real Google login, since nothing
 *    previously showed the owner which app was about to receive access.
 *
 * Every method that can accept a `resource` parameter (RFC 8707) validates it
 * against the set of resources this server protects and refuses anything
 * else. Since plan 002 Phase 2 that set has two members -- the Mail endpoint
 * (/mcp) and the Google Workspace endpoint (/workspace/mcp) -- and a token is
 * bound to exactly ONE of them. `verifierFor(resource)` builds the verifier
 * each endpoint's gate uses; it re-checks the audience independently at the
 * one place every authenticated request must pass through, so a token minted
 * for one endpoint is refused by the other even though both share this
 * provider, this login, and the same on-disk token store.
 */
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type {
  AuthorizationParams,
  OAuthServerProvider,
  OAuthTokenVerifier,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

import { JsonRecordStore } from './store.js';
import type {
  PendingAuthorization,
  StoredAccessToken,
  StoredAuthorizationCode,
  StoredClient,
  StoredRefreshToken,
} from './types.js';
import { isOwnerGoogleIdentity } from './identity-allowlist.js';
import { buildGoogleAuthorizationUrl, type GoogleIdentityVerifier, type GoogleLoginConfig } from './google.js';
import {
  SCOPE_DESCRIPTIONS,
  SUPPORTED_SCOPES,
  allScopesSupported,
  dedupeScopes,
  isSupportedScope,
  type SupportedScope,
} from '../scope-names.js';

export { SUPPORTED_SCOPES } from '../scope-names.js';

export type Logger = (message: string) => void;

/**
 * One MCP endpoint this authorization server issues tokens for. `url` is the
 * RFC 8707 resource identifier (the endpoint's full public URL); `name` is
 * what the owner sees on the consent page and in the endpoint's RFC 9728
 * metadata ("Mail", "Google Workspace").
 */
export interface ProtectedResource {
  url: URL;
  name: string;
}

// Ten minutes to complete the Google login step AND the consent click; a
// pending authorization sitting for longer than that is far more likely
// abandoned than a slow human.
const PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
// Sixty seconds and single-use, standard authorization-code hygiene.
const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
// One hour access tokens; refresh tokens do not expire on their own and are
// only invalidated by explicit revocation (see revokeToken below).
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

// How often the background sweep drops expired pending.json/codes.json
// entries (ticket 007). Disk hygiene only -- an expired record is already
// treated as absent everywhere it's read, this just stops the files from
// growing forever. tokens.json/refresh-tokens.json are deliberately not
// swept here: access tokens are already deleted on first expired read
// (verifyAccessToken), and refresh tokens don't expire on their own at all.
const EXPIRED_RECORD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function describeScopes(scopes: string[]): string[] {
  return scopes.map((scope) => (isSupportedScope(scope) ? `${scope}: ${SCOPE_DESCRIPTIONS[scope]}` : scope));
}

/**
 * The consent page. Deliberately plain, self-contained HTML -- no external
 * assets, nothing script-driven. `clientId`, `redirectUriHost` and the
 * endpoint (`resourceName`/`resourceUrl`, both server-side config) are
 * trustworthy; `clientName` is attacker-controlled via DCR and is both
 * labelled as self-reported AND HTML-escaped before being embedded, so a
 * malicious client_name can neither spoof legitimacy convincingly nor inject
 * markup.
 *
 * Naming the endpoint is plan 002 Phase 2's addition: with two endpoints
 * behind one login, the owner must be able to tell "this app is asking for
 * my files" from "this app is asking for my mail" before clicking Approve.
 */
function renderConsentPage(options: {
  pendingId: string;
  clientId: string;
  clientName?: string;
  redirectUriHost: string;
  resourceName: string;
  resourceUrl: string;
  scopes: string[];
}): string {
  const scopeItems = describeScopes(options.scopes)
    .map((description) => `<li>${escapeHtml(description)}</li>`)
    .join('');
  const clientNameLine = options.clientName
    ? `<p>App name (self-reported by the app, not verified): <strong>${escapeHtml(options.clientName)}</strong></p>`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Authorize application</title>
</head>
<body style="font-family: -apple-system, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5;">
<h1>Authorize this application?</h1>
<p>You signed in with Google as the owner of this server. An application is now asking for access to your <strong>${escapeHtml(options.resourceName)}</strong> endpoint (<code>${escapeHtml(options.resourceUrl)}</code>):</p>
<p>Client ID: <code>${escapeHtml(options.clientId)}</code></p>
<p>Will receive your access token at: <strong>${escapeHtml(options.redirectUriHost)}</strong></p>
${clientNameLine}
<p>Requested access:</p>
<ul>${scopeItems}</ul>
<form method="POST" action="/oauth/consent">
<input type="hidden" name="pendingId" value="${escapeHtml(options.pendingId)}">
<button type="submit" name="decision" value="approve" style="padding: 0.5rem 1.5rem; margin-right: 0.5rem;">Approve</button>
<button type="submit" name="decision" value="deny" style="padding: 0.5rem 1.5rem;">Deny</button>
</form>
<p>If you did not initiate this from your own MCP client, click Deny.</p>
</body>
</html>
`;
}

export interface GmailOAuthProviderOptions {
  configRoot: string;
  /**
   * The endpoints this server issues tokens for, in the order endpoints.json
   * declares them. Must be non-empty. The FIRST entry is the default audience
   * for a client that sends no RFC 8707 `resource` parameter at all -- which
   * keeps every pre-Phase-2 behaviour intact, since Mail at /mcp is always
   * first. A spec-following client (the MCP SDK, Claude Code, Codex) always
   * sends `resource`, taken from the endpoint's own RFC 9728 metadata, so
   * the default only ever applies to a client that ignores that metadata.
   */
  resources: ProtectedResource[];
  google: GoogleLoginConfig;
  /** Overridable only for tests; production always exchanges with real Google. */
  verifyGoogleIdentity: GoogleIdentityVerifier;
  now?: () => number;
  log?: Logger;
}

export class GmailOAuthProvider implements OAuthServerProvider {
  private readonly clients: JsonRecordStore<StoredClient>;
  private readonly pending: JsonRecordStore<PendingAuthorization>;
  private readonly codes: JsonRecordStore<StoredAuthorizationCode>;
  private readonly accessTokens: JsonRecordStore<StoredAccessToken>;
  private readonly refreshTokens: JsonRecordStore<StoredRefreshToken>;
  private readonly resources: ProtectedResource[];
  private readonly google: GoogleLoginConfig;
  private readonly verifyGoogleIdentity: GoogleIdentityVerifier;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly sweepInterval: NodeJS.Timeout;

  /** Local PKCE validation stays on -- Google is not the party validating it. */
  readonly skipLocalPkceValidation = false;

  constructor(options: GmailOAuthProviderOptions) {
    this.clients = new JsonRecordStore<StoredClient>(options.configRoot, 'clients.json');
    this.pending = new JsonRecordStore<PendingAuthorization>(options.configRoot, 'pending.json');
    this.codes = new JsonRecordStore<StoredAuthorizationCode>(options.configRoot, 'codes.json');
    this.accessTokens = new JsonRecordStore<StoredAccessToken>(options.configRoot, 'tokens.json');
    this.refreshTokens = new JsonRecordStore<StoredRefreshToken>(options.configRoot, 'refresh-tokens.json');
    if (options.resources.length === 0) {
      throw new Error('GmailOAuthProvider needs at least one protected resource; refusing to issue tokens for nothing.');
    }
    const seen = new Set<string>();
    for (const resource of options.resources) {
      if (seen.has(resource.url.href)) {
        throw new Error(`GmailOAuthProvider: resource "${resource.url.href}" is listed twice.`);
      }
      seen.add(resource.url.href);
    }
    this.resources = options.resources.map((resource) => ({ url: new URL(resource.url.href), name: resource.name }));
    this.google = options.google;
    this.verifyGoogleIdentity = options.verifyGoogleIdentity;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((): void => {});

    // Fire once at startup (a process that restarts often, e.g. every
    // deploy, would otherwise never run the interval's first tick for a
    // while) and then on a low-frequency interval. `unref()` so this timer
    // never keeps a process that never calls close() (below) alive on its
    // own; `close()` is the deliberate way to release it, for a caller that
    // constructs more than one provider in one process (e.g. this file's own
    // tests, or a future config-reload path).
    void this.sweepExpiredRecords();
    this.sweepInterval = setInterval(() => {
      void this.sweepExpiredRecords();
    }, EXPIRED_RECORD_SWEEP_INTERVAL_MS);
    this.sweepInterval.unref();
  }

  /**
   * Drops expired entries from `pending.json` and `codes.json` (ticket 007).
   * Public so a test can trigger a sweep deterministically instead of waiting
   * on the real interval. Each store's own `sweepExpired` goes through the
   * same write queue as every live mutation, so this can never race a
   * concurrent `claim()`.
   *
   * The two files are swept independently, each with its own try/catch,
   * rather than via a single `Promise.all` -- a `Promise.all` would let one
   * store's failure discard the other store's already-persisted result from
   * both the return value and the log, and would log a single message with
   * no way to tell which of the two files actually failed.
   */
  async sweepExpiredRecords(): Promise<{ pending: number; codes: number }> {
    const now = this.now();
    const pending = await this.sweepOneStore('pending', this.pending, (record) => record.expiresAt < now);
    const codes = await this.sweepOneStore('codes', this.codes, (record) => record.expiresAt < now);
    return { pending, codes };
  }

  private async sweepOneStore<T extends { expiresAt: number }>(
    name: string,
    store: JsonRecordStore<T>,
    isExpired: (record: T) => boolean,
  ): Promise<number> {
    try {
      const removed = await store.sweepExpired(isExpired);
      if (removed > 0) {
        this.log(`[oauth] Swept ${removed} expired ${name} record(s).`);
      }
      return removed;
    } catch (error) {
      this.log(`[oauth] Expired-record sweep of ${name}.json failed: ${(error as Error).message}`);
      return 0;
    }
  }

  /** Releases the background sweep timer. See the constructor's doc comment. */
  close(): void {
    clearInterval(this.sweepInterval);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.clients.get(clientId),
      registerClient: async (client) => {
        // clientRegistrationHandler has already generated client_id (and
        // client_secret, unless the client asked for `token_endpoint_auth_method:
        // "none"`) before calling this -- we only need to persist what it built.
        const full = client as OAuthClientInformationFull;
        await this.clients.set(full.client_id, full);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const scopes = this.resolveRequestedScopes(params.scopes);
    const resource = this.resolveResource(params.resource);

    const id = randomToken(24);
    const record: PendingAuthorization = {
      id,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes,
      resource: resource.href,
      outerState: params.state,
      expiresAt: this.now() + PENDING_AUTHORIZATION_TTL_MS,
    };
    await this.pending.set(id, record);

    // Google's own `state` carries OUR pending-authorization id -- not the MCP
    // client's `state`, which travels inside the pending record instead and is
    // only reattached once the consent decision redirects back to the client.
    res.redirect(302, buildGoogleAuthorizationUrl(this.google, id));
  }

  private resolveRequestedScopes(requested: string[] | undefined): SupportedScope[] {
    if (!requested || requested.length === 0) {
      // No scope requested: grant both. This is a single-owner personal
      // server, not a multi-tenant one -- the interesting scope decision is
      // "read-only vs full access", which a client makes by requesting
      // `read` explicitly, not by omitting scope entirely. The consent
      // screen always shows the ACTUAL resolved scopes (including this
      // default) before anything is granted, so "omit scope" can no longer
      // silently walk away with more access than the owner saw and approved.
      return [...SUPPORTED_SCOPES];
    }
    const normalized = dedupeScopes(requested);
    for (const scope of normalized) {
      if (!isSupportedScope(scope)) {
        throw new InvalidScopeError(
          `Unsupported scope "${scope}". This server supports: ${SUPPORTED_SCOPES.join(', ')}.`,
        );
      }
    }
    return normalized as SupportedScope[];
  }

  private findResource(href: string): ProtectedResource | undefined {
    return this.resources.find((resource) => resource.url.href === href);
  }

  private resolveResource(requested: URL | undefined): URL {
    if (!requested) return this.resources[0].url;
    const match = this.findResource(requested.href);
    if (!match) {
      throw new InvalidTargetError(
        `This authorization server only issues tokens for the resource ${this.resources
          .map((resource) => `"${resource.url.href}"`)
          .join(' or ')}, not "${requested.href}".`,
      );
    }
    return match.url;
  }

  private sendErrorRedirect(
    res: Response,
    redirectUri: string,
    outerState: string | undefined,
    error: string,
    description: string,
  ): void {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (outerState) url.searchParams.set('state', outerState);
    res.redirect(302, url.href);
  }

  private async issueAuthorizationCodeRedirect(
    record: PendingAuthorization & { googleEmail: string },
    res: Response,
  ): Promise<void> {
    const authorizationCode = randomToken(32);
    const codeRecord: StoredAuthorizationCode = {
      code: authorizationCode,
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      codeChallenge: record.codeChallenge,
      scopes: record.scopes,
      resource: record.resource,
      googleEmail: record.googleEmail,
      expiresAt: this.now() + AUTHORIZATION_CODE_TTL_MS,
    };
    await this.codes.set(authorizationCode, codeRecord);

    const url = new URL(record.redirectUri);
    url.searchParams.set('code', authorizationCode);
    if (record.outerState) url.searchParams.set('state', record.outerState);
    res.redirect(302, url.href);
  }

  /**
   * The inner flow's landing point. Not part of OAuthServerProvider --
   * mounted as a plain Express GET route by oauth/router.ts at
   * /oauth/google/callback, which must match the redirect URI registered on
   * the Google web client (GOOGLE_LOGIN_CLIENT_ID) exactly.
   *
   * Confirms the Google identity and, if it is the owner, renders the
   * consent page instead of completing the outer authorization directly --
   * see the class-level doc comment for why that split is load-bearing.
   */
  async handleGoogleCallback(query: Record<string, unknown>, res: Response): Promise<void> {
    const pendingId = typeof query.state === 'string' ? query.state : undefined;
    const record = pendingId ? await this.pending.get(pendingId) : undefined;

    if (!record || record.expiresAt < this.now()) {
      if (pendingId) await this.pending.delete(pendingId);
      res
        .status(400)
        .type('text/plain')
        .send('This login attempt has expired or is invalid. Go back to your MCP client and try connecting again.');
      return;
    }

    if (typeof query.error === 'string') {
      await this.pending.delete(pendingId!);
      this.sendErrorRedirect(
        res,
        record.redirectUri,
        record.outerState,
        'access_denied',
        `Google login failed or was declined: ${query.error}`,
      );
      return;
    }

    const code = typeof query.code === 'string' ? query.code : undefined;
    if (!code) {
      await this.pending.delete(pendingId!);
      this.sendErrorRedirect(
        res,
        record.redirectUri,
        record.outerState,
        'invalid_request',
        'Google did not return an authorization code.',
      );
      return;
    }

    let identity;
    try {
      identity = await this.verifyGoogleIdentity(code);
    } catch (error) {
      await this.pending.delete(pendingId!);
      this.log(`[oauth] Google identity exchange failed: ${(error as Error).message}`);
      this.sendErrorRedirect(
        res,
        record.redirectUri,
        record.outerState,
        'server_error',
        'Could not verify the Google identity. Try connecting again.',
      );
      return;
    }

    // The hard restriction ADR 013 exists for: any authenticated Google
    // identity other than the owner's two addresses is refused here, before
    // any consent screen is even shown. Nothing downstream of this check ever
    // runs for a non-owner identity.
    if (!identity.emailVerified || !isOwnerGoogleIdentity(identity.email)) {
      await this.pending.delete(pendingId!);
      this.log(`[oauth] Refused Google identity not on the owner allowlist: ${identity.email}`);
      this.sendErrorRedirect(
        res,
        record.redirectUri,
        record.outerState,
        'access_denied',
        'This Google account is not authorized to use this server.',
      );
      return;
    }

    // Identity confirmed as the owner. Do NOT complete the outer
    // authorization yet: record the verified identity on the pending
    // authorization and show an explicit consent screen naming the
    // requesting client. Only handleConsentDecision (below), reached by an
    // explicit Approve, ever mints an authorization code from here on.
    const verifiedRecord: PendingAuthorization = { ...record, googleEmail: identity.email };
    await this.pending.set(pendingId!, verifiedRecord);

    const client = await this.clients.get(record.clientId);
    let redirectUriHost: string;
    try {
      redirectUriHost = new URL(record.redirectUri).host;
    } catch {
      redirectUriHost = record.redirectUri;
    }

    // The pending record's resource was validated against the configured set
    // in authorize(); a record naming an unknown resource could only come from
    // a config change mid-flight. Fall back to the raw URL rather than crash,
    // and let the owner see exactly what they'd be approving.
    const resource = this.findResource(record.resource);

    res
      .status(200)
      .type('text/html')
      .send(
        renderConsentPage({
          pendingId: pendingId!,
          clientId: record.clientId,
          clientName: client?.client_name,
          redirectUriHost,
          resourceName: resource?.name ?? '(unknown endpoint)',
          resourceUrl: record.resource,
          scopes: record.scopes,
        }),
      );
  }

  /**
   * The consent page's form target. Not part of OAuthServerProvider --
   * mounted as a plain Express POST route by oauth/router.ts at
   * /oauth/consent.
   *
   * `pendingId` is claimed atomically (JsonRecordStore.claim -- read and
   * delete as one step), so a decision can be acted on at most once: neither
   * a double-submitted form nor a replayed request can approve twice or flip
   * a denial into an approval after the fact.
   */
  async handleConsentDecision(body: Record<string, unknown>, res: Response): Promise<void> {
    // `body` is whatever oauth/router.ts's per-route express.urlencoded()
    // parsed -- which is `undefined`, not `{}`, when the request carries no
    // Content-Type it recognizes (e.g. a bare `curl -X POST` with no body at
    // all). Reading `.pendingId` off `undefined` throws, and that throw was
    // escaping as an unhandled rejection into router.ts's catch block, which
    // has no way to tell "malformed request" apart from "real server bug" and
    // answers both with a raw 500. Normalizing here turns a missing/wrong-shaped
    // body into the same "nothing legitimate to approve" path a known-bad
    // pendingId already takes below -- a clean 400, not a crash. A
    // well-formed request (the only kind the real rendered consent form ever
    // sends) is completely unaffected.
    const safeBody = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const pendingId = typeof safeBody.pendingId === 'string' ? safeBody.pendingId : undefined;
    const decision = typeof safeBody.decision === 'string' ? safeBody.decision : undefined;

    const record = pendingId ? await this.pending.claim(pendingId) : undefined;

    if (!record || record.expiresAt < this.now() || !record.googleEmail) {
      // No googleEmail means this pendingId never passed identity
      // verification (or was already consumed) -- there is nothing legitimate
      // to approve, so this fails closed exactly like an expired/unknown id.
      res
        .status(400)
        .type('text/plain')
        .send(
          'This approval link is invalid, expired, or was already used. Go back to your MCP client and try connecting again.',
        );
      return;
    }

    if (decision !== 'approve') {
      this.sendErrorRedirect(
        res,
        record.redirectUri,
        record.outerState,
        'access_denied',
        'The owner declined to authorize this application.',
      );
      return;
    }

    await this.issueAuthorizationCodeRedirect(record as PendingAuthorization & { googleEmail: string }, res);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = await this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAt < this.now()) {
      throw new InvalidGrantError('Authorization code is invalid, expired, or was issued to a different client.');
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // Atomic claim, not get()-then-delete(): two concurrent exchange attempts
    // of the SAME code must not both be able to read it before either delete
    // lands. See store.ts's JsonRecordStore.claim() -- this is the fix for
    // the proven double-exchange race. A code is burned by the first call
    // that claims it, successful or not (client-id mismatch, expiry), which
    // is a stricter and safer default than only burning on success.
    const record = await this.codes.claim(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAt < this.now()) {
      throw new InvalidGrantError('Authorization code is invalid, expired, or was issued to a different client.');
    }

    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the value used to obtain this authorization code.');
    }
    if (resource && resource.href !== record.resource) {
      throw new InvalidTargetError(`This code was issued for resource "${record.resource}", not "${resource.href}".`);
    }

    return this.issueTokens(client.client_id, record.scopes, record.resource, record.googleEmail);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = await this.refreshTokens.get(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token is invalid, revoked, or was issued to a different client.');
    }
    if (resource && resource.href !== record.resource) {
      throw new InvalidTargetError(
        `This refresh token was issued for resource "${record.resource}", not "${resource.href}".`,
      );
    }

    // Fail closed on the stored grant: a refresh-token record carrying a name
    // this server does not issue (the retired `mail:read`/`mail:write`
    // spelling, a hand-edited file, a restored pre-2026-09-20 backup) is an
    // invalid grant, so the client re-authorizes. It is NOT translated -- the
    // alias that used to do that was deleted in plan 002 Phase 6 after
    // `clients.sh migrate-scopes` rewrote every stored record -- and it is not
    // passed through either, because an access token minted under an unknown
    // name would be denied at every tool with no path back to consent.
    const previouslyGranted = dedupeScopes(record.scopes);
    if (!allScopesSupported(previouslyGranted)) {
      throw new InvalidGrantError(
        'Refresh token was granted under scope names this server no longer issues; re-authorize to obtain a current grant.',
      );
    }
    let grantedScopes: string[] = previouslyGranted;
    if (scopes && scopes.length > 0) {
      const requested = dedupeScopes(scopes);
      const notPreviouslyGranted = requested.filter((scope) => !previouslyGranted.includes(scope));
      if (notPreviouslyGranted.length > 0) {
        throw new InvalidScopeError(
          `Cannot widen scope on refresh -- not previously granted: ${notPreviouslyGranted.join(', ')}.`,
        );
      }
      grantedScopes = requested;
    }

    // Refresh tokens are not rotated: the same opaque value keeps working
    // across refreshes. A deliberate simplicity trade-off for a single-owner
    // server with a handful of long-lived clients, not an oversight -- see the
    // Phase 2 build report for the rotation hardening this leaves on the table.
    return this.issueTokens(client.client_id, grantedScopes, record.resource, record.googleEmail, refreshToken);
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: string,
    googleEmail: string,
    existingRefreshToken?: string,
  ): Promise<OAuthTokens> {
    // Belt and braces: every caller already validates, but a new access-token
    // record must never be written under a name the verifier would refuse.
    scopes = dedupeScopes(scopes);
    if (!allScopesSupported(scopes)) {
      throw new InvalidScopeError(`Refusing to issue a token under unsupported scope names: ${scopes.join(', ')}.`);
    }
    const accessToken = randomToken(32);
    const expiresAt = Math.floor(this.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    await this.accessTokens.set(accessToken, {
      token: accessToken,
      clientId,
      scopes,
      resource,
      googleEmail,
      expiresAt,
    });

    const refreshToken = existingRefreshToken ?? randomToken(32);
    if (!existingRefreshToken) {
      await this.refreshTokens.set(refreshToken, { token: refreshToken, clientId, scopes, resource, googleEmail });
    }

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: scopes.join(' '),
      refresh_token: refreshToken,
    };
  }

  /**
   * The verifier for ONE endpoint's auth gate. Accepts only a token minted
   * for exactly `resourceUrl`; a token for the other endpoint is refused with
   * a 401, whose WWW-Authenticate then points the client at THIS endpoint's
   * metadata so it re-authorizes for the right audience.
   *
   * This is the RFC 8707 audience check -- independent of the resource check
   * already done at exchange time, so a stored record that somehow carries
   * the wrong resource is still caught here, at the one place every
   * authenticated request must pass through. It is the load-bearing line
   * ADR 013's confused-deputy concern exists to require, and plan 002's
   * non-negotiable "a token minted for one endpoint is rejected by the other"
   * is enforced by nothing else.
   */
  verifierFor(resourceUrl: URL): OAuthTokenVerifier {
    const resource = this.findResource(resourceUrl.href);
    if (!resource) {
      throw new Error(
        `verifierFor: "${resourceUrl.href}" is not one of this provider's protected resources (${this.resources
          .map((r) => r.url.href)
          .join(', ')}).`,
      );
    }
    const expected = resource.url.href;

    return {
      verifyAccessToken: async (token: string): Promise<AuthInfo> => {
        const record = await this.accessTokens.get(token);
        if (!record) {
          throw new InvalidTokenError('Access token is invalid, expired, or was revoked.');
        }
        if (record.expiresAt < Math.floor(this.now() / 1000)) {
          await this.accessTokens.delete(token);
          throw new InvalidTokenError('Access token has expired.');
        }
        if (record.resource !== expected) {
          throw new InvalidTokenError(
            `Token was minted for resource "${record.resource}", not this endpoint's resource "${expected}".`,
          );
        }

        // Fail closed, same reasoning as refresh: a stored access token under
        // a name the per-tool gate does not know is a 401 (so the client
        // refreshes, gets invalid_grant, and re-authorizes), not a 403 at
        // every tool forever. This is the ONLY check on the access-token
        // path -- refresh has issueTokens() behind it, this does not. Remove
        // it and `initialize`/`tools/list` still succeed (no scope check
        // there) while every `tools/call` is denied: an apparently-connected
        // client with no way back to consent. Mutation-tested 2026-09-20.
        if (!allScopesSupported(record.scopes)) {
          throw new InvalidTokenError('Access token carries scope names this server no longer issues; re-authorize.');
        }

        return {
          token,
          clientId: record.clientId,
          scopes: record.scopes,
          expiresAt: record.expiresAt,
          resource: new URL(record.resource),
          extra: { googleEmail: record.googleEmail },
        };
      },
    };
  }

  /**
   * Required by the OAuthServerProvider interface, but deliberately NOT a
   * working verifier. There is no single answer to "is this token valid?"
   * on a server with two audiences -- only "valid for which endpoint?", which
   * is `verifierFor()`'s question. If some future mount wires a gate to the
   * provider itself (`requireBearerAuth({ verifier: provider })`), this makes
   * every request through that gate fail with a 500 on the first try, rather
   * than silently accepting a Mail token at the Workspace endpoint. Nothing in
   * the SDK's own handlers calls this; only the bearer-auth middleware does,
   * and ours is always built from `verifierFor()`.
   */
  async verifyAccessToken(_token: string): Promise<AuthInfo> {
    throw new Error(
      'GmailOAuthProvider.verifyAccessToken is not usable directly: tokens are bound to one endpoint, so build a verifier with verifierFor(resourceUrl).',
    );
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const accessRecord = await this.accessTokens.get(request.token);
    if (accessRecord && accessRecord.clientId === client.client_id) {
      await this.accessTokens.delete(request.token);
      return;
    }
    const refreshRecord = await this.refreshTokens.get(request.token);
    if (refreshRecord && refreshRecord.clientId === client.client_id) {
      await this.refreshTokens.delete(request.token);
    }
    // An unknown, already-revoked, or wrong-client token is silently ignored,
    // per the OAuthServerProvider.revokeToken contract.
  }
}
