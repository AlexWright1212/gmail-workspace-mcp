/**
 * The OAuth scope vocabulary, in one place. Plan 002 Phase 2 renamed the
 * scopes from `mail:read`/`mail:write` to `read`/`write` because the same two
 * scopes now cover both endpoints (Mail at /mcp, Google Workspace at
 * /workspace/mcp) -- see docs/specs/002-google-workspace-server.md, "Scopes".
 *
 * Both src/http/scopes.ts (the per-tool gate) and src/http/oauth/provider.ts
 * (the authorization server) import from here, so the two can never disagree
 * about what a scope is called. This module deliberately imports nothing:
 * provider.ts must stay loadable without pulling in the tool registry.
 */

export const READ_SCOPE = 'read';
export const WRITE_SCOPE = 'write';
export const SUPPORTED_SCOPES = [READ_SCOPE, WRITE_SCOPE] as const;
export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

export function isSupportedScope(scope: string): scope is SupportedScope {
  return (SUPPORTED_SCOPES as readonly string[]).includes(scope);
}

/**
 * Plain-language wording for the consent page. Deliberately generic across
 * both endpoints: the page names the endpoint being authorized separately,
 * so "mail, files, documents, spreadsheets and calendar" reads as "whatever
 * this endpoint exposes" rather than as a promise that a Mail token reaches
 * Drive.
 */
export const SCOPE_DESCRIPTIONS: Readonly<Record<SupportedScope, string>> = {
  [READ_SCOPE]: 'Look at your mail, files, documents, spreadsheets and calendar',
  [WRITE_SCOPE]: 'Change them: send, create, edit, label, move and delete',
};

/**
 * Drops duplicates, preserving first-seen order. Nothing is translated: the
 * pre-2026-09-19 names `mail:read`/`mail:write` were carried by an alias
 * here from plan 002 Phase 2 until Phase 6 (2026-09-20), when every stored
 * token still spelled the old way was rewritten to the current names by
 * `bash scripts/clients.sh migrate-scopes --yes` and the alias deleted. A
 * stored or requested name outside SUPPORTED_SCOPES is now refused at the
 * point it is read (src/http/oauth/provider.ts), never mapped -- a second
 * spelling of the same permission is exactly what the alias was, and it
 * must not come back "as a fallback".
 */
export function dedupeScopes(scopes: readonly string[]): string[] {
  const out: string[] = [];
  for (const scope of scopes) {
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

/**
 * True when every name in the list is one this server issues. Used to fail
 * closed on a stored record: a token or refresh token carrying any other
 * name (a retired one, a hand-edited file, a restored backup) is refused so
 * the client re-authorizes, rather than reaching the per-tool gate under a
 * name it does not know and being denied everything with no way out.
 */
export function allScopesSupported(scopes: readonly string[]): scopes is readonly SupportedScope[] {
  return scopes.every(isSupportedScope);
}
