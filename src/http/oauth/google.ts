/**
 * The inner flow: talking to Google for the login step only.
 *
 * Uses google-auth-library's OAuth2Client, already a direct dependency of
 * this project (src/gmail-client.ts uses it for the separate, unrelated
 * server-to-Gmail OAuth relationship -- see CLAUDE.md's "Two independent
 * authentication layers"). This is a second, distinct OAuth2Client, built
 * from a second, previously-unused GCP web client -- never the one Gmail
 * access uses.
 *
 * The Google identity token obtained here is used for exactly one thing: to
 * read the verified email claim during the callback. It is never stored,
 * never returned to a caller, and never forwarded anywhere as if it were an
 * MCP-server-issued credential -- see provider.ts's handleGoogleCallback.
 */
import { OAuth2Client } from 'google-auth-library';

export interface GoogleLoginConfig {
  clientId: string;
  clientSecret: string;
  /** This server's own callback URL, e.g. https://mcp.example.com/oauth/google/callback */
  redirectUri: string;
}

export interface VerifiedGoogleIdentity {
  email: string;
  emailVerified: boolean;
}

/**
 * Exchanges a Google authorization code for the caller's verified identity.
 * Production always uses {@link createGoogleIdentityVerifier}; tests inject a
 * fake implementation instead, since there is no way to reach real Google
 * from an automated test.
 */
export type GoogleIdentityVerifier = (authorizationCode: string) => Promise<VerifiedGoogleIdentity>;

function buildClient(config: GoogleLoginConfig): OAuth2Client {
  return new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
}

/**
 * Builds the URL the browser is redirected to for the Google consent screen.
 * Pure string construction -- google-auth-library does not make a network
 * call for this, so `authorize()` in provider.ts stays a synchronous-feeling,
 * network-free redirect.
 *
 * `state` here is OUR internal pending-authorization id, not the outer MCP
 * client's `state` parameter -- see PendingAuthorization in types.ts.
 */
export function buildGoogleAuthorizationUrl(config: GoogleLoginConfig, state: string): string {
  return buildClient(config).generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email'],
    prompt: 'select_account',
    state,
  });
}

/**
 * The real implementation. Exchanges the code server-side for Google tokens,
 * verifies the returned id_token's signature and audience against our own
 * client id, and reads the email claim out of the verified payload. The
 * access/id tokens themselves are discarded immediately after -- nothing
 * about them is persisted or reused.
 */
export function createGoogleIdentityVerifier(config: GoogleLoginConfig): GoogleIdentityVerifier {
  return async (authorizationCode: string): Promise<VerifiedGoogleIdentity> => {
    const client = buildClient(config);
    const { tokens } = await client.getToken(authorizationCode);
    if (!tokens.id_token) {
      throw new Error('Google token exchange did not return an id_token.');
    }
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.email) {
      throw new Error('Google identity token had no email claim.');
    }
    return { email: payload.email, emailVerified: payload.email_verified === true };
  };
}
