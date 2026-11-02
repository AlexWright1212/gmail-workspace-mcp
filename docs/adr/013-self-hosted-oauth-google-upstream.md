# ADR 013 — Self-Hosted OAuth 2.1 Authorization Server, Google Upstream Login

**Last edited:** 2026-09-19 (written 2026-08-28, corrected same day post-implementation; extended to two protected resources by ADR 016)
**Status:** Accepted — **Implemented and independently verified 2026-08-28**
(Phase 2 of `docs/plans/001-remote-access-migration.md`). See "Correction:
authentication is not consent" below — implementation surfaced a real flaw in
this ADR's original reasoning, fixed the same day, before any deploy.
**Origin:** `docs/plans/001-remote-access-migration.md`

---

## Context

ADR 012 made this server publicly reachable, gated by a single shared bearer
token. A shared secret doesn't scale to the owner's actual goal — many
distinct clients (Claude Code, Codex, claude.ai, ChatGPT, cloud agents), each
individually identifiable and revocable. One token means no per-client audit
trail, no way to turn off a single compromised or unwanted client without
rotating everyone's access, and no way to give a lower-trust client
(read-only ChatGPT access, say) less than full read/write reach into the
inbox.

The MCP specification's authorization spec (`2025-11-25`) defines a standard
pattern for exactly this: the MCP server acts as an OAuth 2.1 resource server,
with an authorization server issuing scoped, audience-bound, per-client
tokens.

## Options Considered

**An external identity provider** (Auth0, WorkOS, Stytch, Descope — all
offer purpose-built MCP-OAuth products). Would offload dynamic client
registration, consent, token rotation, and the security-critical parts of an
OAuth implementation to a vendor. Rejected: heavier machinery than justified
for one user's personal inbox tool, and it puts a third party in the
authorization path to the owner's own email for no benefit this project's
scale needs. Vendor risk is not hypothetical here — Stytch, one of the
candidates, was acquired by Twilio in November 2025, a live example of the
platform churn this option would inherit.

**Self-hosted authorization server, passphrase + TOTP login.** Fewer moving
parts than a Google-mediated flow, no dependency on Google Cloud Console
configuration. Rejected in favor of Google upstream: the GCP project this
server already uses for Gmail access (`email-503620`) has a **second,
already-provisioned, currently-unused OAuth web client** — reusing it costs
nothing new to set up. More importantly, "prove you're the account whose
inbox this is" is a stronger identity check than a shared passphrase the
owner would have to store and type, and reuses infrastructure that already
exists rather than adding a new one.

**Self-hosted authorization server, Google as the upstream login (chosen).**
The VPS is its own OAuth 2.1 authorization server — using the MCP TypeScript
SDK's `OAuthServerProvider` / `mcpAuthRouter` — but the actual login and
consent step delegates to Google OAuth, **hard-restricted server-side to the
owner's two addresses** (`ownerpersonal@gmail.com`,
`owner_school@tamu.edu`). The authorization server mints and owns its own
opaque access/refresh tokens; the Google identity token is used only to
verify who is logging in during that one step and is **never** passed through
to an MCP client as if it were an MCP-server-issued token.

## Decision

Build Phase 2 of `docs/plans/001-remote-access-migration.md` against these
non-negotiables — binding whichever agent implements it, not just the agent
that happens to write the first version:

- **Protected Resource Metadata (RFC 9728)** served at
  `/.well-known/oauth-protected-resource`, and every `401` response carries
  `WWW-Authenticate: Bearer resource_metadata="…"`. Without this no client can
  discover the authorization server at all.
- **Token audience validation (RFC 8707).** Accept only tokens minted for
  this server's own canonical URI. **Never pass a Google token through as an
  MCP token** — the MCP spec forbids this explicitly, and it is the
  textbook confused-deputy hole this decision is designed to avoid.
- **Dynamic Client Registration (RFC 7591), supported despite being optional**
  in the `2025-11-25` spec (which prefers Client ID Metadata Documents).
  Claude Code still requires DCR in practice as of this writing
  (`anthropics/claude-code#67258`), so it ships regardless of what the spec
  prefers.
- **Scopes (`mail:read` / `mail:write`) ship with the very first release**,
  not retrofitted later — adding a scope after clients are already registered
  forces every one of them back through consent.
- **The bearer token stays live in parallel until Phase 4.** A half-working
  OAuth rollout must never be able to lock the owner out of their own inbox
  tooling.
- **The hostname (`mcp.example.com`, from ADR 012) is permanent from this
  server's perspective** — it becomes the OAuth issuer URL and is baked into
  every client's RFC 8707 `resource` parameter at registration time. Changing
  it after clients exist means re-authorizing every one of them by hand.

## Correction: authentication is not consent

**This ADR's original text asserted:** "registering a client id gets an
attacker nothing on its own — every registered client still has to complete
the owner's real Google login to receive a usable token." **That reasoning
was wrong, and an adversarial verification pass proved it wrong with a
working exploit** before any of this was deployed.

The flaw: DCR is intentionally open (any client can self-register, by
design, so ChatGPT/Codex/claude.ai/etc. can connect without a manual step).
The original implementation redirected straight from a verified Google login
to completing the outer authorization — meaning "the owner logged into
Google" was being treated as equivalent to "the owner approved this specific
client's access." Those are different questions. An attacker can register
their own client, send the owner a link to this server's real `/authorize`
(real domain, real TLS — no spoofing needed), and the owner — who really is
who they say they are — completes a real Google login. The server then
handed a real, scoped (`mail:read mail:write` by default, since omitting
`scope` grants both) access token to the **attacker's** client, because
nothing had ever shown the owner which client was about to receive it.
Proven end-to-end against the real compiled server, not a theoretical read.

**Fix, implemented and independently re-verified the same day:** the outer
authorization no longer completes automatically on a verified Google login.
`GET /oauth/google/callback` now renders a same-origin, server-rendered
consent page — the requesting client's `client_id`, the host of its
registered `redirect_uri` (trustworthy; the client's self-reported
`client_name`, if present, is shown too but explicitly labelled
"self-reported, not verified" since DCR lets an attacker set it to anything),
and the requested scopes in plain language — requiring an explicit
`POST /oauth/consent` (Approve/Deny) before any code is issued. This is
required on every authorization, not remembered per client (a "remember this
client" shortcut was deliberately not built — it would have given a single
successful phish a lasting foothold). DCR itself stays open, unchanged — the
consent screen is the actual security boundary this design needed, not
gating who can register.

**What was independently re-verified**, by resuming the same adversarial
agent that found the original hole against its own exploit, not a fresh
read: the original phishing PoC now stops at a 200 consent page with no code
reaching the attacker's `redirect_uri`; the consent page's rendering of an
attacker-supplied `client_name` was probed directly with an XSS payload and
confirmed genuinely HTML-escaped in the served bytes, not just claimed to be;
`POST /oauth/consent` cannot be forged cross-site because it only ever acts
on a pending record whose identity-verified flag was set by a real completed
Google login — there is no unauthenticated path to that precondition;
replaying an already-decided consent returns 400; and both Approve and Deny
redirect only to the `redirect_uri` registered at DCR time, never anything
attacker-influenceable at decision time.

A second, independent bug was found and fixed in the same pass: authorization
codes could be exchanged twice under a race (read-then-delete wasn't atomic),
breaking the single-use guarantee codes rely on against interception/replay.
Fixed by making the store's code-claim operation atomic; re-verified with a
concurrent-exchange test that now shows exactly one success, not two.

**The residual risk after this fix is the ordinary one every third-party
OAuth consent screen carries**: an owner who ignores a plainly-worded warning
and approves anyway. That is the standard OAuth trust model, not a protocol
bypass — a materially different risk category from what was originally
found.

Two minor, non-blocking items noted by the final verification pass, tracked
rather than gating deployment: no regression test pins the consent page's
HTML-escaping specifically (the behavior is correct today, verified by hand,
but unguarded against a future silent regression), and expired pending/code
records are not proactively reaped (bounded by TTL, low priority at this
scale).

## What's Now Known

Implemented, tested (264/264, up from a 259 baseline before the fixes above),
typechecked clean, and passed two independent verification passes — one
functional/spec-correctness, one purely adversarial — each run by an agent
with no access to the implementer's own reasoning, against the real compiled
code, not just a reading of the diff. The functional pass mutation-tested the
RFC 8707 audience-validation test itself (neutered the real check, confirmed
the test fails, reverted) to confirm it has teeth rather than being
decorative, and cross-checked scope classification against all 23 tools in
`tools-enabled.json` programmatically, confirming every mutating tool is
correctly gated as `mail:write`.

**Deployed and live-verified 2026-08-29.** The owner completed the one-time
human step (located the second GCP web client, set its redirect URI, added
the three env vars) and then did the thing nothing automated could
substitute for: added `gmail-remote` as a real OAuth-authenticated MCP
server in Claude Code (`claude mcp add --transport http`), triggered a real
connection, completed a real Google login, saw the consent screen render
correctly (client id, redirect host, plain-language scopes — the exact fix
from the Correction above), clicked Approve, and connected successfully.
This is the only verification in this ADR's whole history that involved a
real human clicking a real consent screen rather than an agent or a test.

**Two unrelated production bugs surfaced during that live rollout, both
fixed the same day, neither caught by any prior test or agent review** —
full detail in `docs/adr/012`'s Correction section and
`docs/plans/001-remote-access-migration.md`'s "Phase 2 — what actually
happened": a `127.0.0.1` bind change (ADR 012's domain, not this one's) broke
the still-live tailnet `/sse` endpoint for a day; and the Cloudflare tunnel's
ingress allowlist didn't include every OAuth route this ADR's implementation
added (`/oauth/consent` specifically, added by the Correction above *after*
the ingress was last updated) — caught only because the owner personally hit
a dead end mid-login. That ingress-drift class is closed since 2026-09-19:
`scripts/deploy.sh` fetches every endpoint's metadata document and 401 through
the tunnel on each deploy, reading the endpoint list from `endpoints.json`.

Implementation status is tracked in `docs/plans/001-remote-access-migration.md`,
Phase 2's row in the phase table — update that, not this ADR, for anything
that happens next in this area.

## Phase 4 (2026-08-30): OAuth is now the only credential

The shared bearer token (`MCP_BEARER_TOKEN`) is deleted. This ADR's original
non-negotiable — "the bearer token stays live, unweakened, in parallel" —
existed so a half-working OAuth rollout could not lock the owner out of their
own inbox tooling. That condition is discharged: five independent clients
(Claude Code, claude.ai, the Claude phone app, Codex, and a second Claude Code
instance) completed real Google logins and real tool calls against the
deployed server before this removal.

**What removing it actually buys.** The bearer was a single static shared
secret with no expiry, no per-client identity, no revocation short of rotating
it for everyone, and — since ADR 012 — public reachability. Every property
ADR 015's per-client accountability work added was unavailable to any request
that used it. It was the weakest credential on the strongest-exposed path.

**The one thing this makes newly dangerous, and what was done about it.**
While the bearer existed, an unconfigured OAuth layer was a safe degraded
mode: `config.ts` deliberately returns `undefined` rather than throwing on a
partial bootstrap, and `/mcp` stayed gated by the bearer regardless. With
OAuth the only credential, that same degradation would have meant **no gate
mounted on `/mcp` at all** — the mount was `if (bearerToken || mountedOAuth)`.
That is the failure this phase had to get right, and it is closed twice over:

- `createMcpAuthGate()` returns a **deny-all handler** when `oauth` is absent,
  and is now mounted unconditionally. Structural: no caller of
  `createHttpApp` — a test included — can raise an ungated `/mcp`.
- `runHttpServer()` in `src/index.ts` **throws before binding a port** if
  OAuth is unconfigured. Chosen over "start and deny everything" for a
  specific reason: `deploy.sh`'s post-deploy check probes `/mcp`
  *unauthenticated* and treats a 4xx as proof the path is healthy, so a
  deny-everything server would have **passed** its own deploy check. A
  process that refuses to boot makes pm2 report the app down, which that
  check does catch, with `deploy.sh --rollback` as the escape hatch.

This is the same rule as ADR 003: a config that fails to load enables nothing,
not everything.

**A second-order consequence worth naming.** `assertToolScopeAllowed()` in
`src/http/scopes.ts` passes through with full, unscoped access when `authInfo`
is undefined. That early return used to cover two callers — the bearer path and
stdio. Only stdio remains, and stdio is reachable only by someone already on
the VPS. The early return is still correct and must stay, but it is now the
last thing between a gate bug and unscoped inbox access rather than a routine
branch, and the module comment says so.

**The request log's `authMethod` field** gains `'unknown'` and stops writing
`'bearer'`. A `/mcp` request with no `req.auth` should now be impossible;
recording it as `'bearer'` would name a credential that no longer exists, in
the one artifact ADR 015 makes the trustworthy record of who did what.
`'bearer'` stays in the type union solely so pre-Phase-4 lines still parse.

## Consequences

- **The send-allowlist (ADR 004) is not superseded, weakened, or touched by
  this in any way.** Scopes are a second, additive layer — a client granted
  `mail:write` still has every `send_message`/`create_draft` call pass
  through the exact same `assertSendAllowed()` / `deliver()` choke point as
  it does today. If a future Phase 2 diff appears to route around that
  choke point to implement scope checking, that is a bug, not a feature of
  this decision.
- **Dynamic Client Registration being open to the public internet is not a
  hole.** Registering a client id gets an attacker nothing on its own —
  every registered client still has to complete the owner's real Google login
  to receive a usable token.
- **This is genuinely dependent on ADR 012's hostname being permanent.** If
  the domain or hostname ever needs to change, that is a breaking change to
  every OAuth client registered under this decision, not a routine DNS edit.
- **There is no longer a fallback credential.** Since Phase 4, an OAuth layer
  that breaks — a revoked Google login client, a corrupted token store, an
  expired GCP consent screen — locks the owner out of their own inbox tooling
  until it is fixed on the VPS over SSH. Accepted deliberately: SSH over the
  tailnet is the recovery path, and DigitalOcean's web console is the recovery
  path for *that* (ADR 015, Phase 3). Keeping a static shared secret alive as
  insurance would have re-created exactly the weakness this phase removed.

## Extended by ADR 016 (2026-09-19)

The server now protects two resources, Mail at `/mcp` and Google Workspace
at `/workspace/mcp`, behind this one authorization server. "Accept only
tokens minted for this server's own canonical URI" is enforced per endpoint
by `verifierFor(url)`; scopes are `read`/`write` with a time-limited alias
for the names this ADR introduced. Everything else here still governs.
Reasoning: `docs/adr/016-two-endpoints-one-authorization-server.md`.

## Pointers

- `docs/plans/001-remote-access-migration.md` — "Non-negotiables" section
  (the fuller, living version of the list above) and the Phase 2 row.
- `docs/adr/012-public-streamable-http-via-cloudflare-tunnel.md` — the
  transport and hostname this OAuth layer is built on top of.
- `docs/adr/004-extend-allowlist-to-workspace-tools.md` — the send boundary
  this decision must never touch.
- `CLAUDE.md`, Environment section — GCP project `email-503620`; the "second
  web client" noted there as "unused" is the one this decision uses for the
  Google-login step, not a newly provisioned client.
- MCP authorization specification, revision `2025-11-25`
  (`modelcontextprotocol.io/specification/2025-11-25/basic/authorization`).
- `src/http/oauth/{provider,store,types,config,identity-allowlist,google,router}.ts`,
  `src/http/scopes.ts` — the implementation.
- `test/oauth-provider.test.mjs`, `test/oauth-http.test.mjs` — including the
  two tests that reproduce the original phishing and double-exchange PoCs and
  prove they now fail at the intended point.
