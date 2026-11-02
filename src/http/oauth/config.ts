/**
 * Pure env -> config for the OAuth authorization server, same idiom as
 * resolveHttpConfigFromEnv in ../server.ts.
 *
 * Returns undefined -- meaning "OAuth is not configured" -- rather than
 * throwing, whenever the one-time GCP bootstrap this needs has not happened
 * yet. That was originally a safe degraded mode: the shared bearer token still
 * gated /mcp, so an incomplete bootstrap cost nothing.
 *
 * **Phase 4 changed what `undefined` means, without changing this function.**
 * OAuth is now the only credential, so callers treat it as a fatal
 * misconfiguration: src/index.ts's runHttpServer THROWS before binding a port,
 * and createMcpAuthGate denies every request if one is somehow built anyway.
 * This function stays non-throwing so it remains a pure, testable env -> config
 * mapping; the policy about what a missing config MEANS belongs to its callers,
 * and both of them fail closed. Do not "fix" this by making it throw without
 * checking what that does to the tests that call it with a bare env.
 *
 * Plan 002 Phase 2: the protected resource URLs are no longer derived here.
 * They come from endpoints.json (one per endpoint, `issuerUrl + path`) and
 * are attached by src/http/server.ts, which is the one place that knows both
 * the issuer and the endpoint list.
 */
import type { GoogleLoginConfig } from './google.js';

export interface OAuthEnvConfig {
  /** The permanent public issuer URL, e.g. https://mcp.example.com (ADR 012). */
  issuerUrl: URL;
  google: GoogleLoginConfig;
}

export function resolveOAuthConfigFromEnv(env: NodeJS.ProcessEnv): OAuthEnvConfig | undefined {
  const publicUrlRaw = env.PUBLIC_URL?.trim();
  const clientId = env.GOOGLE_LOGIN_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_LOGIN_CLIENT_SECRET?.trim();

  // All three or none: a partial set is treated the same as "not configured"
  // rather than a misconfiguration error, so an incomplete bootstrap degrades
  // to "OAuth routes are not mounted", not a crash.
  if (!publicUrlRaw || !clientId || !clientSecret) {
    return undefined;
  }

  let issuerUrl: URL;
  try {
    issuerUrl = new URL(publicUrlRaw);
  } catch {
    throw new Error(
      `Invalid PUBLIC_URL value: "${publicUrlRaw}". Expected a full URL, e.g. https://mcp.example.com`,
    );
  }

  return {
    issuerUrl,
    google: {
      clientId,
      clientSecret,
      redirectUri: new URL('/oauth/google/callback', issuerUrl).href,
    },
  };
}
