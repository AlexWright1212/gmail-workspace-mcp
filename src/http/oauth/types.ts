/**
 * Shape of everything the OAuth authorization server persists to disk.
 *
 * These are plain, JSON-serializable records -- see store.ts for how they are
 * read and written, following the same configRoot-relative-JSON-file idiom as
 * src/config.ts (accounts.json) and src/allowlist.ts (send-allowlist.json).
 */
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

/** A Dynamic Client Registration (RFC 7591) record, stored verbatim. */
export type StoredClient = OAuthClientInformationFull;

/**
 * A one-time-use authorization code, minted only after the Google identity
 * behind it has already been checked against the owner allowlist. Everything
 * needed to finish the outer OAuth 2.1 flow travels with it, so the token
 * exchange never has to re-derive anything from the pending-authorization
 * record (which is deleted the moment the code is issued).
 */
export interface StoredAuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  /** Canonical resource URI string (RFC 8707) this code was scoped to. */
  resource: string;
  /** The verified Google identity that completed login for this code. */
  googleEmail: string;
  /** Epoch ms. Codes are short-lived and single-use. */
  expiresAt: number;
}

/** An opaque, server-minted access token -- never a Google token. */
export interface StoredAccessToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource: string;
  googleEmail: string;
  /** Epoch SECONDS, matching AuthInfo.expiresAt's unit. */
  expiresAt: number;
}

/** An opaque, server-minted refresh token. Not rotated on use (see provider.ts). */
export interface StoredRefreshToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource: string;
  googleEmail: string;
}

/**
 * State held across THREE steps: the outer flow's `authorize()` call (which
 * redirects the browser to Google), the inner flow's Google callback (which
 * verifies identity and, on success, shows a consent page instead of
 * finishing immediately), and the consent decision (which redirects back to
 * the original client only on an explicit Approve). Keyed by an internal id
 * that is sent to Google as ITS `state` parameter and then reused as the
 * consent form's `pendingId` -- never confused with the outer client's own
 * `state`, which is carried inside this record as `outerState` and only
 * re-applied at the very end.
 */
export interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  outerState?: string;
  /**
   * Set by handleGoogleCallback once the Google identity has been verified
   * AND matched against the owner allowlist -- i.e. once this record has
   * moved from "awaiting Google login" to "awaiting the owner's consent
   * click". Its presence (not just the record's existence) is what
   * handleConsentDecision requires before it will ever mint a code: a
   * pending record with no googleEmail has not passed identity verification
   * and must not be approvable by posting to /oauth/consent directly.
   */
  googleEmail?: string;
  /** Epoch ms. Bounds how long a human has to complete Google login AND consent. */
  expiresAt: number;
}
