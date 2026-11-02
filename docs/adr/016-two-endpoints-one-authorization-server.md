# ADR 016 — Two endpoints behind one authorization server, and the `read`/`write` scope model

**Last edited:** 2026-09-19
**Status:** Accepted — implemented, adversarially reviewed, deployed and live-verified 2026-09-19 (commit `c22cfdc`)
**Origin:** `docs/plans/002-google-workspace-endpoint.md`, Phase 2

---

## Context

Spec 002 turns one MCP server into two: Mail at `/mcp`, unchanged for every
client that already uses it, and Google Workspace at `/workspace/mcp`. ADR 013
built the OAuth 2.1 authorization server around exactly one protected
resource — its RFC 8707 audience check compared every token against a single
canonical URL, and its scopes were named for mail (`mail:read`,
`mail:write`). Both assumptions had to change without disturbing the four
clients that held live tokens on the day of the change.

## Options considered

**A second server** — fork the codebase, run a second process, register a
second subdomain (`workspace.example.com`). Rejected in the plan's owner
decisions: it doubles deploys, audit logs and OAuth stores, the file-based
token store assumes one writer, and a second issuer means every mail client
re-registers from scratch. The spec's "one login, one owner" would have been
two logins.

**One endpoint, scope-filtered** — keep `/mcp`, expose Workspace tools only to
a `workspace` scope. Rejected: clients cannot choose scopes in their UI, they
can choose URLs. Per-client tool caps (Cursor's ~40) also make one endpoint
carrying 60+ tools unusable. Recorded in the plan; not re-argued here.

**One authorization server, one resource per endpoint (chosen).** The
authorization server stays exactly as ADR 013 built it — one issuer, one
Google login, one client store, one consent flow — and gains a *list* of
protected resources instead of one. Everything resource-shaped becomes per
endpoint: the RFC 9728 metadata document, the `resource_metadata` hint in
each 401, and the token verifier behind each gate.

**Scope names: keep `mail:*` and add `workspace:*`** versus **rename to
`read`/`write` on both endpoints.** Chosen: rename. A token already names its
endpoint through its audience, so an endpoint prefix in the scope name
carries nothing. Two scopes, same meaning everywhere, is what the consent
page has to explain to a human.

**Rename with a hard cutover** (every client re-consents on the day) versus
**rename with a translation layer.** Chosen: translation. Every live refresh
token on the VPS carried the old names, and refresh tokens never expire on
their own, so a hard cutover would have broken the owner's daily Claude Code,
claude.ai, Codex and Cursor connections at once, each needing a manual
re-login to recover.

## Decision

- **Each entry in `endpoints.json` is one OAuth protected resource.** Its
  `path` under `PUBLIC_URL` is the token audience; its new required
  `displayName` is what the consent page shows. `src/http/server.ts` derives
  the resource list from the same endpoint list it mounts, so the mount, the
  gate, the metadata and the consent page cannot name different things.
- **`GmailOAuthProvider.verifierFor(url)` is the only verifier.** It accepts a
  token whose stored `resource` equals that URL, exactly, and nothing else.
  The SDK-required `verifyAccessToken` on the provider itself deliberately
  throws: on a two-audience server "is this token valid?" has no answer
  without "for which endpoint?", and a gate wired to the provider by mistake
  now fails with a 500 on its first request instead of silently accepting a
  Mail token at Workspace.
- **The consent page names the endpoint** ("your **Google Workspace**
  endpoint", with its URL) alongside the client id and redirect host that
  ADR 013's correction already required. With two endpoints behind one login,
  "this app wants my files" and "this app wants my mail" must look different
  before Approve is clicked.
- **Nested endpoint paths are refused at boot.** Express's `app.use(path)` is
  a prefix match, so `/mcp` and `/mcp/x` would share a gate and the one
  mounted first would win. Same fail-closed rule as ADR 003, same place
  (`src/endpoints.ts`).
- **A client that sends no `resource` gets a token for the first endpoint
  (Mail).** This is the pre-change behaviour exactly. The MCP SDK client
  always sends `resource`, copied from the endpoint's own metadata document,
  so the default reaches only a client that ignores RFC 9728, and its failure
  is a visible 401 at Workspace, not silent access.
- **Scopes are `read` and `write`**, defined once in
  `src/http/scope-names.ts` and imported by both the authorization server and
  the per-tool gate. From Phase 2 to Phase 6 an alias in that file mapped
  `mail:read` and `mail:write` to the new names at the three points a stored
  or requested scope list is read (`authorize`, refresh, the verifier), so a
  client that never re-consented converged on the new names at its first
  refresh while its refresh-token record kept the old names as evidence.
  **Deleted 2026-09-20 (plan 002 Phase 6):** `bash scripts/clients.sh
  migrate-scopes --yes` rewrote every stored record (117, read back clean)
  and the three read points now fail closed — `invalid_grant` at refresh, 401
  at the verifier, `invalid_scope` at authorize — for any name outside the
  two, so the client re-authorizes.

## What's now known

- **Adversarial review found no cross-endpoint path.** A separate agent,
  with no access to the implementer's reasoning, tried `resource` values
  differing by trailing slash, case, query, fragment, scheme, port and
  percent-encoding; different values at `/authorize` and `/token`; refresh
  grants naming the other endpoint; records planted directly in
  `tokens.json` with near-miss audiences; and raw-socket path variants
  (`/mcp/`, `/MCP`, `/workspace/mcp/../mcp`). Every attempt was a 401 naming
  the refusing endpoint's own metadata URL. Both load-bearing checks — the
  audience comparison in `verifierFor` and the nested-path refusal — were
  mutation-tested: neutered, the tests fail; restored, they pass.
- **The rename was invisible to existing clients**, which contradicted the
  spec's expectation. The owner's Mail client refreshed within minutes of the
  deploy and its log lines switched to `read write` with no login. Spec 002
  was reworded 2026-09-19 to say so.
- **The MCP SDK client takes both `scope` and `resource` from the endpoint's
  metadata document** (`scopes_supported` joined; `resource` verbatim). The
  metadata document is therefore what steers a client's re-consent — a wrong
  `resource` there would mint tokens for the wrong endpoint and have them
  refused at the gate. `scripts/deploy.sh` now fetches each endpoint's
  metadata through the tunnel and checks `resource` names that endpoint, and
  checks each 401's `WWW-Authenticate` names the same URL. A wrong gate at a
  path still 401s; this is what catches it.
- Live on 2026-09-19: both endpoints gated through the tunnel, `dist/` hashes
  identical local and VPS, the owner completed a real Workspace consent whose
  page named "Google Workspace", and that client's token has the Workspace
  audience only.

## Consequences

- **ADR 013's "accept only tokens minted for this server's own canonical
  URI" is now per endpoint**, enforced by `verifierFor`, not weakened. ADR
  004's allowlist and ADR 013's consent boundary are untouched.
- **Adding a third endpoint is an `endpoints.json` entry** (path,
  displayName, tools) plus a Cloudflare ingress edit. The deploy script probes
  it automatically; nothing in `src/http/` needs to change.
- **The legacy alias's removal gate could never close on its own.** "Delete
  once `clients.sh list` shows no LEGACY client" assumed clients would
  re-consent, but the alias made re-consent unnecessary, refresh tokens never
  expire, and refresh deliberately left the record under the old names — so
  the owner's daily mail clients would have stayed LEGACY forever. Resolved
  by rewriting the stored names in place (the same grant, same audience,
  same Google identity, nothing widened) rather than by three owner
  re-logins. A migration gate should be stated in terms of state the plan
  itself can bring about.
- **The bare-path metadata alias (`/.well-known/oauth-protected-resource`
  with no suffix) can only ever name one resource**, and names Mail. A client
  that ignores the suffixed URL in `WWW-Authenticate` will always be steered
  to Mail; this is a defensive fallback, not a discovery path anything
  spec-following uses.

## Pointers

- `docs/plans/002-google-workspace-endpoint.md`, "Phase 2 — what actually
  happened" — the build record and deviations from the design.
- `docs/adr/013-self-hosted-oauth-google-upstream.md` — the authorization
  server this extends; its consent-screen correction still governs.
- `docs/adr/015-per-client-accountability.md` — `clients.sh list` now also
  prints each client's token audience, scope names (flagging a RETIRED
  spelling, which the server refuses) and the endpoints it has been seen on;
  `clients.sh migrate-scopes` is the in-place fix.
- `src/http/scope-names.ts`, `src/http/oauth/provider.ts` (`verifierFor`,
  `resolveResource`, `renderConsentPage`), `src/http/oauth/router.ts`,
  `src/http/server.ts`, `src/endpoints.ts`, `endpoints.json`.
- `test/two-endpoints.test.mjs` — the cross-endpoint, metadata and consent
  pins, and (since Phase 6) that a retired scope name fails closed at the
  verifier, at refresh and at authorize.
