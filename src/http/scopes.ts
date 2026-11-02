/**
 * Classifies every enabled tool as requiring `read` or `write`, and gates
 * dispatch on it for OAuth-authenticated requests. See
 * docs/adr/013-self-hosted-oauth-google-upstream.md.
 *
 * This module is deliberately small, separate, and additive:
 *  - It is called ONCE, at the top of the CallToolRequestSchema handler in
 *    src/index.ts, before the existing dispatch switch -- never interleaved
 *    into any individual `case '<tool>':` body.
 *  - It never touches, duplicates, or weakens assertSendAllowed() in
 *    src/allowlist.ts or deliver() in src/gmail-client.ts. A write-scoped
 *    OAuth token still has every send pass through that exact same choke
 *    point, unchanged -- this is a second, additive layer in front of it, not
 *    a replacement.
 *  - It passes through unchanged (full access) whenever `authInfo` is
 *    undefined. Since Phase 4 removed the shared bearer token, the ONLY
 *    remaining caller in that state is the stdio transport, which has no HTTP
 *    auth layer at all and is reachable only by someone already on the VPS.
 *    Every /mcp request now carries authInfo, because the gate that admits it
 *    (createMcpAuthGate) accepts nothing but an OAuth token. Do not "simplify"
 *    this early return away: stdio depends on it. Do not widen it either --
 *    it is now the last thing between a gate bug and unscoped access.
 *
 * Plan 002 Phase 1: classification used to live in a hand-maintained
 * TOOL_SCOPES map here, which could drift from the tool definitions it was
 * describing. It now lives on the tool definition itself
 * (`annotations.readOnlyHint`, set alongside the schema in src/tools/*.ts) so
 * it cannot be forgotten separately -- this module just reads it back out of
 * TOOL_REGISTRY.
 *
 * Plan 002 Phase 2: the scope NAMES are `read`/`write` (src/http/scope-names.ts,
 * shared with the authorization server). The OAuth verifier refuses a stored
 * token carrying any other name (the retired `mail:read`/`mail:write`
 * spelling included, since Phase 6) before it reaches `authInfo.scopes`, so
 * this module only ever sees current names.
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { TOOL_REGISTRY } from '../tools/registry.js';
import { READ_SCOPE, WRITE_SCOPE, type SupportedScope } from './scope-names.js';

export { READ_SCOPE, WRITE_SCOPE } from './scope-names.js';
export type McpScope = SupportedScope;

/**
 * A tool name absent from TOOL_REGISTRY -- or present but without a boolean
 * `readOnlyHint` -- returns undefined and is denied to every
 * OAuth-authenticated caller by assertToolScopeAllowed below, regardless of
 * which scopes its token holds. Fail closed on anything not deliberately
 * classified, rather than guess a default.
 */
export function scopeForTool(toolName: string): McpScope | undefined {
  const entry = TOOL_REGISTRY.get(toolName);
  if (!entry) return undefined;
  const readOnlyHint = entry.definition.annotations?.readOnlyHint;
  if (typeof readOnlyHint !== 'boolean') return undefined;
  return readOnlyHint ? READ_SCOPE : WRITE_SCOPE;
}

export class ScopeDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeDeniedError';
  }
}

/**
 * Call once, before dispatch, for every tool call. Throws ScopeDeniedError to
 * deny; returns normally to allow.
 */
export function assertToolScopeAllowed(toolName: string, authInfo: AuthInfo | undefined): void {
  if (!authInfo) return;

  const required = scopeForTool(toolName);
  if (!required) {
    throw new ScopeDeniedError(
      `This OAuth token cannot call "${toolName}": no scope requirement is defined for this tool, so it is denied by default.`,
    );
  }
  if (!authInfo.scopes.includes(required)) {
    const granted = authInfo.scopes.length > 0 ? authInfo.scopes.join(', ') : '(none)';
    throw new ScopeDeniedError(
      `This OAuth token cannot call "${toolName}": it requires the "${required}" scope. Granted scopes: ${granted}.`,
    );
  }
}
