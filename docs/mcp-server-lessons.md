# Things we've learned so far that might be relevant to future agents building MCP servers

Raw notes, not a curated skill. Written during this project's migration from a
Tailscale-only, single-bearer-token MCP server to a publicly reachable one
behind a Cloudflare Tunnel with a self-hosted OAuth 2.1 authorization server
(`docs/plans/001-remote-access-migration.md`, `docs/adr/012`, `docs/adr/013`,
`docs/adr/014`).

**The skills this file was written for now exist** (Phase 5, 2026-09-11), as
three global skills: `building-agent-tools`, `hosting-remote-services`, and
`provisioning-agent-credentials`. They are deliberately much shorter than this
file — architectural decisions and silent traps only. This file is kept as the
archival long form: the place to look when one of those skills states something
tersely and the reasoning or evidence behind it matters.

Organized by topic, not chronologically.

## MCP transport (Streamable HTTP)

- **HTTP+SSE (two endpoints: `GET /sse` + `POST /messages`) is deprecated**
  as of MCP spec `2025-03-26`, replaced by a single-endpoint Streamable HTTP
  transport. Current stable spec at time of writing: `2025-11-25`. A
  `2026-07-28` release candidate exists (headline change: the protocol goes
  stateless at the wire level — no session handshake, no session header,
  protocol version/capabilities travel per-request in `_meta` instead) but no
  major client spoke it yet as of this writing. Design new servers stateless
  anyway (below) so that RC is a small step, not a rewrite.
- **For a server that's pure request/response tools** (no sampling, no
  server-initiated notifications), run Streamable HTTP fully stateless:
  `sessionIdGenerator: undefined`, `enableJsonResponse: true` in the MCP
  TypeScript SDK's `StreamableHTTPServerTransport`. Construct a fresh
  server+transport per request; nothing needs to be hoisted or cached across
  requests — measured cost of a fresh server instance per request was
  sub-millisecond (p50 ~0.47ms for a full `initialize`) even with a
  moderately large tool schema (23 tools). Don't assume statelessness is
  expensive; measure it.
- **`enableJsonResponse: true` alone does NOT stop the SDK client from
  opening a standalone `GET` stream.** The client still calls `GET` on the
  MCP endpoint after `notifications/initialized`, looking for a
  server-initiated-message channel. If your server doesn't want to maintain
  any long-lived stream (e.g. because it sits behind a proxy with an
  aggressive idle/read timeout), you must **also** answer `GET` and `DELETE`
  with `405 Method Not Allowed` before the transport ever handles them. This
  is spec-sanctioned — the MCP transport spec explicitly permits a server to
  return 405 for `GET` when it offers no stream — and the SDK client treats a
  405 as "this server offers no stream" and moves on silently: no error, no
  retry, no `onerror` callback fired.
- **A dead GET stream fails silently, not loudly, in the MCP TypeScript
  SDK** (open issue as of this writing: `modelcontextprotocol/typescript-sdk#2098`).
  If a GET stream that *was* opened gets cut (proxy timeout, network blip),
  the client can end up in a state where `POST`s keep returning `202
  Accepted` but the actual responses are never delivered — no error surfaces
  anywhere. This is the strongest argument for the 405-on-GET approach above:
  it's not just tidier, it eliminates an entire silent-failure class.
- **Never mount `express.json()` / `express.urlencoded()` globally** on a
  server that also serves Streamable HTTP at some path. The transport reads
  the raw request body stream itself; a global body parser consumes it
  first, and `/mcp` either hangs or sees an empty body. If you also need
  OAuth-style endpoints (`/token`, `/register`) that want form/JSON bodies,
  scope body parsing per-route (`app.post('/token', express.json(), handler)`),
  or pass an already-parsed body explicitly into `transport.handleRequest(req, res, req.body)`.
  This is exactly the kind of bug that a test posting a pre-parsed body would
  never catch — write a test that posts through the real unparsed body path.
- **No request body size limit exists by default** on a Streamable HTTP
  `POST` endpoint. A 30MB unauthenticated body was accepted, fully buffered,
  and answered in ~30ms in testing. Add an explicit limit if the server will
  ever be publicly reachable.
- **Pin Origin/Host validation ahead of the transport**, in plain Express
  middleware, if you want a rejected request to be cheap. The SDK's own
  DNS-rebinding protection (`allowedHosts`/`allowedOrigins`) runs *inside*
  `transport.handleRequest`, which is called after a full per-request server
  instance has already been constructed and connected. Measured cost of that
  wasted construction was small (~0.5ms) in this project, so this is
  amplification, not a real hole — but a gate that runs before the work is
  strictly better, and it's cheap to add.
- `app.disable('x-powered-by')` — trivial, but Express otherwise advertises
  itself on every response for no reason.

- **A test that guards raw-stream behaviour must not use an SDK client.**
  The bullet above is only half a lesson without this: every SDK client
  transport hands the server a body it has already parsed, so a suite built
  entirely on SDK clients will pass in full while a global body parser is
  silently breaking the endpoint for real clients. Write at least one test
  that opens a TCP socket and writes the request line, headers, and JSON-RPC
  body by hand, then asserts a real result comes back. Detect completion by
  parsing `Content-Length` off the raw response rather than sleeping. Confirm
  it has teeth by mounting the parser in a scratch copy and watching it fail.

## Cloudflare Tunnel (exposing a server publicly without opening a port)

- **Fully scriptable via the Cloudflare API — no `cloudflared tunnel login`
  browser flow needed.** Create the tunnel via `POST
  /accounts/{account_id}/cfd_tunnel`, which returns a `token` field; install
  it on the target machine with `cloudflared service install <token>`
  (installs and starts a systemd/launchd service). Configure ingress via
  `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations`. Create
  the public DNS record as a `CNAME` to `<tunnel_id>.cfargotunnel.com`,
  `proxied: true`. None of this requires a human to click through a browser
  OAuth-style login.
- **Never place the account-wide `cert.pem` on any managed machine.** It
  grants "create, delete, and manage every tunnel on the account." The
  per-tunnel token/credentials JSON from the API-based creation flow above
  grants only "run this one tunnel" — use that instead. If a machine running
  `cloudflared` is ever compromised, the blast radius should be "an attacker
  can intercept traffic for this one tunnel," not "an attacker controls the
  Cloudflare account's entire tunnel fleet."
- **A full zone (nameservers pointed at Cloudflare) is required** for a
  Tunnel-backed public hostname. Partial/CNAME-only zone setup (keeping DNS
  elsewhere) is a Business-plan-and-up feature; there's no lighter option on
  Free.
- **Named tunnels do not buffer Server-Sent Events. Quick Tunnels
  (`cloudflared tunnel --url ...`, no named tunnel, ephemeral) do**, as a
  deliberate demo-product guardrail — confirmed directly by a `cloudflared`
  maintainer on GitHub issue #1449 ("It works as expected with named
  tunnels... quick-tunnels... have some guardrails due to it being a demo
  product"). Almost every "Cloudflare Tunnel breaks streaming" claim found
  online traces back to someone testing with a Quick Tunnel. Use a named
  tunnel for anything real; never rely on a Quick Tunnel beyond a five-minute
  smoke test.
- **Cloudflare's proxy read timeout is 125 seconds**, not the commonly
  quoted 100 — confirmed directly against Cloudflare's own documentation
  (the connection-limits reference page and the Error 524 troubleshooting
  page both state 125s). Not configurable below the Enterprise plan.
  Whether it's an *idle* timeout (resets on any byte sent) or a *total
  request duration* cap is **not documented by Cloudflare** — strong
  community consensus (heartbeat-comment tricks fixing many people's 524
  errors) says idle, but this is unverified, not confirmed. If the server
  design has no way to emit a heartbeat mid-request (e.g.
  `enableJsonResponse: true` above, where nothing is written until the
  handler returns), treat 125s as a hard ceiling on any single request,
  full stop.
- **Cloudflare's connection-limits table, useful reference values**: Proxy
  Read Timeout 125s, Proxy Write Timeout 30s, Proxy Idle Timeout 900s
  (keep-alive reuse between Cloudflare and the origin), client↔Cloudflare
  keep-alive/idle both 400s (HTTP/1.1 and HTTP/2 respectively).
- **Cloudflare modifies some request/response headers**, documented
  explicitly: strips `X-Accel-Buffering`, `X-Accel-Charset`,
  `X-Accel-Limit-Rate`, `X-Accel-Redirect`, `Alt-Svc` from responses; modifies
  `Accept-Encoding`, `X-Forwarded-Proto`, `Connection` on requests.
  `Authorization` and `WWW-Authenticate` are not in either strip/modify list
  (documented by omission, not by an explicit "we pass these through"
  statement — high confidence, not certainty; verify with a real request if
  it matters).
- **Browser Integrity Check is ON by default on every new Cloudflare zone**
  and will challenge/block clients with an absent or non-standard
  `User-Agent` — which is exactly what a plain Node `fetch`/`undici`-based
  MCP client looks like. Surfaces as Cloudflare error 1010 and reads exactly
  like an auth bug or a network fault; the WAF/Security Events log is the
  only place it's actually named as a bot-check decision. Turn it off (zone-
  wide, or scoped to specific paths via a Configuration Rule) for any zone
  fronting a programmatic API client.
- **Bot Fight Mode, if enabled, cannot be bypassed per-path on the Free plan
  at all** — it doesn't run on the Ruleset Engine, so WAF custom rules and
  Configuration Rules can't skip it. If a zone serves non-browser clients, it
  needs to be fully off, not scoped.
- **Free-plan rate limiting is minimal**: exactly one rule, matchable on Path
  and Verified-Bot only, counted by IP only, with only a 10-second window and
  10-second mitigation available. Treat it as burst protection, not real
  abuse defense, and say so explicitly wherever it's documented — implying
  more protection than it provides is worse than not having it.
- **Zone-level API token permission groups are more granular than they
  look.** A token with "Zone Settings: Edit" (covers things like
  `browser_check`) does **not** cover the Bot Management API
  (`/zones/{id}/bot_management`) or the Rulesets API (Configuration Rules,
  rate-limiting rules) — both return 403 with a Zone-Settings-only token,
  confirmed by direct testing. These are separate permission groups; budget
  for requesting all of them up front if the deployment plan includes
  BIC + Bot Management + rate limiting, rather than discovering the gaps one
  403 at a time.
- **A tunnel's ingress allowlist is a second, independent place routes have
  to be registered**, alongside the application's own route table. This
  project hit the same failure twice in one deployment window: a new
  server-side route was live and working, but 404'd at Cloudflare's edge
  because the tunnel's ingress path list hadn't been updated to include it.
  Nothing cross-checks the two automatically. Worth building a deploy-time
  check (introspect the app's registered Express routes, diff against the
  live ingress config) for any project doing this more than once.
- **A firewall rule restricting a port to one network interface (e.g. `ufw`
  allowing port 3000 only on a `tailscale0` interface) is the actual access
  boundary — the application's own bind address is a separate, additive
  concern, and conflating the two causes real outages.** Binding an app to
  `127.0.0.1` "to be extra safe" once a tunnel is added can silently cut off
  a *different*, still-needed access path (e.g. a private mesh network like
  Tailscale) that depended on the app being reachable on that other
  interface — a loopback bind is unreachable from anywhere but the same
  machine, full stop, regardless of what any firewall allows. Before binding
  more narrowly than "all interfaces," check whether anything else still
  needs to reach the app on some other interface.

## Self-hosted OAuth 2.1 authorization server, delegating login to an upstream IdP

This is the single highest-value lesson in this document. A server acting as
its own OAuth 2.1 authorization server, but delegating the actual login step
to a third-party identity provider (Google, GitHub, etc.), is a common and
reasonable pattern — and it has a subtle, easy-to-miss vulnerability class if
built naively.

**Authentication is not consent, and conflating them is a real, exploitable
vulnerability, not a theoretical one.** If Dynamic Client Registration (RFC
7591) is open — any client can self-register without prior approval, which
is desirable so that arbitrary MCP clients (ChatGPT, Codex, a new tool
nobody's configured yet) can connect without a manual provisioning step —
and the "authorization" step is simply "redirect to the upstream IdP, verify
the resulting identity, then immediately complete the OAuth flow for
whichever client initiated it," this is phishable:

1. An attacker registers their own OAuth client via the open DCR endpoint,
   with their own `redirect_uri`.
2. The attacker sends the real user a link to the *server's own real*
   `/authorize` endpoint (real domain, real TLS — nothing about the URL
   itself is suspicious) carrying the attacker's `client_id`.
3. The user, believing they're reconnecting a legitimate client, clicks
   through and logs into the upstream IdP for real — because they genuinely
   are who they say they are. This step provides no signal about which
   client initiated the flow.
4. With nothing in between, the server redirects the user's browser straight
   to the **attacker's** `redirect_uri` with a real, valid authorization
   code.
5. The attacker exchanges the code and receives a fully valid access token
   scoped to the real user's account.

Every individual piece of this looks correct in isolation — real domain,
real TLS, real IdP login, spec-compliant OAuth code — which is exactly why a
single "review this code, does it look right" pass is likely to miss it. It
requires someone (or something) actively trying to exploit the design, not
just reading it, because the vulnerability is an *omission* (a missing
consent step), not a bug in code that exists.

**The fix**: a mandatory, server-rendered consent screen, shown *after* the
upstream identity is verified and *before* the outer OAuth flow completes.
It must show:
- The requesting client's `client_id`.
- The **host of its registered `redirect_uri`** — this is the trustworthy
  identifier (verified at DCR time, unlike a free-text field).
- Any self-reported "app name" or similar free-text metadata *if shown at
  all*, clearly labelled as self-reported/unverified — DCR lets a client set
  this to anything, including something designed to look legitimate.
- The specific permissions/scopes being requested, in plain language.
- An explicit approval action (a real button/POST, not just page presence)
  before any authorization code is issued. A decision (approve or deny)
  should be single-use — claim it atomically so it can't be replayed.

Do not build a "remember this client, skip consent next time" shortcut
without deliberately weighing the cost: it turns one successful phishing
attempt into a permanent foothold, since the attacker's client would then be
silently pre-approved.

**Other things that mattered building this:**

- **Never pass an upstream IdP's token through as if it were the server's
  own token.** Mint your own opaque access/refresh tokens; use the upstream
  token only internally, only during the login step, to establish identity.
  This is the textbook "confused deputy" prevention, and the MCP
  authorization spec is explicit that a server must not pass through tokens
  it didn't itself issue.
- **RFC 8707 (Resource Indicators) audience validation is the actual
  technical defense against token misuse across resources** — validate that
  a presented token was minted specifically for *this* server's canonical
  resource URI (exact string match on the canonical form) and reject
  anything else. This is cheap to implement and easy to verify by
  construction: mint a token against one resource URI, try to use it against
  a server configured with a different one, confirm it's rejected.
- **RFC 9728 (Protected Resource Metadata)** — serve at
  `/.well-known/oauth-protected-resource`, or, when the actual protected
  resource has a path component (e.g. the MCP endpoint is at `/mcp`, not
  root), at the path-suffixed location
  `/.well-known/oauth-protected-resource/mcp` per the spec's "insert before
  path" rule. A bare-path alias alongside the correct one is harmless
  defensive redundancy if you're unsure a given client implements the
  path-suffix rule correctly. Every `401` response should carry
  `WWW-Authenticate: Bearer resource_metadata="<url>"` pointing at this
  document — without it, a client has no way to discover the authorization
  server at all.
- **RFC 8414 (Authorization Server Metadata)** — serve at
  `/.well-known/oauth-authorization-server`. Minimum fields clients actually
  check: `issuer`, `authorization_endpoint`, `token_endpoint`,
  `registration_endpoint` (if DCR is supported),
  `response_types_supported`, `code_challenge_methods_supported`.
- **RFC 7591 (Dynamic Client Registration)** — the MCP authorization spec
  (`2025-11-25`) formally demotes DCR to optional, preferring "Client ID
  Metadata Documents" (a client identifies itself via an HTTPS URL serving
  its own metadata) — but real clients haven't all caught up. Claude Code
  specifically still required DCR in practice as of this writing (tracked
  upstream: `anthropics/claude-code#67258`). Support DCR regardless of what
  the spec prefers, until client support for the newer mechanism is
  confirmed broadly.
- **Authorization codes need genuinely atomic single-use semantics.** A
  naive "read the code record, validate it, then delete it" is vulnerable to
  a race: two concurrent exchange attempts for the same code can both pass
  validation before either delete lands, both succeeding and minting two
  independent token sets from one supposedly single-use code. Fix by making
  "claim" (read-and-invalidate) one atomic operation relative to concurrent
  callers — e.g., a per-resource serialized queue where claim is a single
  step, not two. Test this directly: fire two concurrent exchanges of one
  code, assert exactly one succeeds.
- **Keep multiple OAuth-related client registrations clearly distinct in
  documentation if a project uses more than one.** It's easy and
  high-consequence to conflate "the client that grants this server access to
  some external resource" with "the client used purely to verify a login
  during the authorization flow" — they can live in the same third-party
  project (e.g. the same Google Cloud project) as two separate registered
  OAuth clients with very different purposes and blast radii if confused.
- **The MCP TypeScript SDK (`@modelcontextprotocol/sdk`, 1.26.x at time of
  writing) ships most of the OAuth machinery already** —
  `server/auth/router.js` (`mcpAuthRouter`, `createOAuthMetadata`,
  `mcpAuthMetadataRouter`), `server/auth/provider.js` (the
  `OAuthServerProvider` interface an implementer fills in: `clientsStore`,
  `authorize`, `challengeForAuthorizationCode`, `exchangeAuthorizationCode`,
  `exchangeRefreshToken`, `verifyAccessToken`, optional `revokeToken`),
  `server/auth/middleware/bearerAuth.js` (`requireBearerAuth`, the resource-
  server-side middleware that validates a token and attaches
  `req.auth: AuthInfo`). Its own handlers enforce PKCE mandatorily (S256
  required, checked in `token.js`) and ship built-in per-IP rate limits on
  `/authorize`, `/token`, `/register` (observed defaults: roughly
  100/15min, 50/15min, 20/hour respectively). Prefer these over hand-rolling
  OAuth wire-protocol code — hand-rolled OAuth is exactly the kind of code
  most likely to carry a subtle, spec-violating security bug, and the SDK's
  version has presumably had more eyes on it.
- **`AuthInfo` (scopes, client id, audience/resource, expiry) reaches an MCP
  server's tool-call request handler as a second argument** —
  `server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {...})`
  — populated in `extra.authInfo` when the transport middleware set
  `req.auth`. It's `undefined` for requests authenticated by some other
  means (e.g. a legacy shared bearer token kept as a fallback during
  migration). This is a clean hook point for scope-based tool authorization
  layered on top of MCP dispatch, and the `undefined` case is a natural way
  to let two auth schemes coexist without duplicating logic — treat
  "no `AuthInfo`" as one clearly-defined access level (e.g. full legacy
  access), not as an error state, if that's the intended migration design.
- **But that `undefined` branch is a trapdoor once the migration finishes.**
  When the legacy scheme is deleted, "no `AuthInfo` means full access" is
  still sitting in the dispatch path — correct only because nothing can reach
  it any more, and silently catastrophic if anything ever does again. Keep it
  if a genuinely unauthenticated transport remains (stdio, reachable only by
  someone already on the host); say so at the branch, in those words, so the
  next reader knows it is load-bearing rather than vestigial.

### Deleting one of several accepted credentials can un-mount the gate entirely

The highest-severity trap found in this whole project, and it is reached by
*deleting* a line rather than adding one.

While two credentials were accepted, the auth gate was mounted conditionally:

```js
if (legacyToken || oauth) {
  app.use('/mcp', createGate({ legacyToken, oauth }));
}
```

Reasonable at the time — with no credential configured there was nothing to
check. Now delete `legacyToken` and leave the condition alone. The gate mounts
only when OAuth is configured, and OAuth config *deliberately* degrades to
`undefined` on an incomplete bootstrap (a partial set of env vars is treated as
"not configured", not as an error). So one missing environment variable means
**no gate is mounted at all** on a publicly-routed endpoint, and every test
that asserts a `401` still passes, because they all configure auth.

Two fixes, and use both — they fail in different ways:

- **The gate mounts unconditionally and returns a deny-all handler when it has
  nothing to check.** Structural: no caller can construct an ungated app.
- **The process refuses to start.** Because a deny-everything server is
  indistinguishable from a healthy one to any unauthenticated health probe —
  see the next point.

**Prefer refuse-to-boot over boot-and-deny-everything.** A post-deploy check
that POSTs unauthenticated and asserts `401` proves DNS, proxy, routing and
gate are all alive — and a server that rejects *everyone* returns exactly that
`401`. It would pass its own deploy check while serving nobody. A process that
exits non-zero makes the process manager report it down, which the same check
does catch, leaving rollback available.

Generalize: when removing an authentication path, the thing to audit is not
the credential check. It is every `if` that decides whether the check runs.

## Clients differ far more than the protocol suggests

- **One application can host several agent surfaces, and configuring a server
  in one exposes nothing to the others.** The server side looks flawless
  throughout: repeated clean `initialize` + `tools/list` handshakes returning
  every tool, and **zero `tools/call`, ever**. Read that signature as "wired to
  a different surface", not "server broken". The client itself reports only
  that the tools are unavailable, so **server-side logging is the only thing
  that can tell those two apart** — a strong argument for building the request
  log before onboarding, not after. Detail on exactly how this plays out per
  client family below.
- **A client's product tier can block custom MCP entirely**, independent of
  anything about the server. Establish that a given plan *can* do what you're
  attempting before debugging why it isn't working — detail below.

### Where each client family actually stores its MCP configuration

Four client ecosystems this project onboarded a real server to, and they
differ on an axis the Streamable HTTP spec never mentions: whether "configure
once" means once per **account** or once per **device**, and whether a single
app can host more than one execution surface that doesn't share config with
the others. Getting this wrong looks identical from the model's side in every
case — it declines to use a tool, or silently substitutes a different,
narrower built-in integration — so the client's actual configuration model has
to be known going in, not inferred from symptoms.

- **Claude family (claude.ai, Claude Desktop, Claude mobile) — one
  account-level registration.** Add a custom connector once, from claude.ai
  web (Settings → Connectors → Add custom connector); it becomes usable from
  Claude Desktop and the Claude iOS/Android apps automatically, with no
  per-device step. The mobile apps cannot originate a new custom connector
  themselves — they only consume ones already added on web/desktop. This is
  the only one of the four with genuine "add once, everywhere" behavior; treat
  it as the convenient exception, not the default to expect elsewhere.

- **Claude Code — separate from the account above, and per-device.**
  `claude mcp add --transport http <name> <url>` writes into that specific
  machine's local config; a second machine needs its own `claude mcp add`,
  completes its own `/mcp` browser login, and gets its own OAuth client
  registration (its own row in the server's client list, distinguishable by
  name and redirect URI). Retiring a machine means revoking that one client,
  not touching the others — the same shape as an SSH `authorized_keys` entry.

- **ChatGPT Work / Codex — per-device, and the sharpest trap found in this
  project.** As of OpenAI's July 2026 desktop-app merge, one application
  exposes three modes from a single selector: **Chat, Work, Codex.** Only
  **Work** and **Codex** run on the Codex agent runtime and read that
  machine's `~/.codex/config.toml`, including its `[mcp_servers.*]` table —
  **Chat does not**, despite sharing the same window and looking like just
  another mode next to it. Adding a server via the desktop app's Settings →
  Plugins/MCPs writes into that same shared `config.toml`; it silently
  configures Work and Codex together, and never Chat. When it's genuinely
  ambiguous which surface is actually running, the reliable test is to ask the
  model directly — "are you Codex, ChatGPT Work, or ChatGPT chat" — which
  self-reports the real execution surface accurately, independent of which UI
  label happened to be clicked; this was confirmed directly against a live
  instance, matching what `config.toml` said it should be able to reach.
  `config.toml` is a local file with no account-level sync of its own — a
  server added on one machine's Work/Codex is not available on another
  machine's (e.g. a phone's) Work/Codex unless something else provisions that
  device's config independently. A product tier can also block a surface
  outright, on top of all this: regular Chat mode's own custom-MCP path
  requires OpenAI's "Developer Mode," documented for Business/Enterprise/Edu
  (full) and Pro (read-only), with no path at all on Plus — but Work/Codex
  sidesteps that restriction entirely, since it never goes through Chat's
  plugin system in the first place.

- **Cursor — per-device via `mcp.json`**, either project-scoped
  (`.cursor/mcp.json`) or global (`~/.cursor/mcp.json`); Settings → Tools &
  MCP → New MCP Server writes there. Defaults to OAuth with dynamic client
  registration when the server supports it (this project's does); falls back
  to static client credentials pasted into `mcp.json` only for servers that
  don't support DCR. **One connection attempt can register two OAuth clients,
  not one** — observed directly: a first DCR registration with zero completed
  tokens (an aborted or retried leg of the same flow) sat alongside a second,
  seconds later, that completed and was actually used. Harmless — DCR alone
  grants nothing without finishing consent — but worth knowing before reading
  a client list and assuming duplicate same-named entries mean two different
  real integrations.

**The general shape**: "configure once" can mean per-account (Claude),
per-device (Claude Code, Cursor, and ChatGPT's `config.toml`), or
per-device-*and*-per-surface-within-that-device (ChatGPT Work/Codex vs. Chat,
sharing one window but not one config). Establish which of these shapes the
client in front of you actually has before debugging why a newly-added server
"isn't showing up" — and verify with a real tool call plus the server's own
request log, never by trusting what the client's UI claims about itself.

- **The redirect URI a client registers reveals what kind of client it is.**
  A hosted `https://…/callback` means the vendor's servers complete the flow;
  a loopback `http://127.0.0.1:<random-port>/callback/<nonce>` means a native
  app spawned a local listener. Useful for telling several clients apart in a
  store when their names are unhelpful.
- **The `client_name` sent during registration often names the real consumer**,
  which may not be the application the user thinks they are configuring.
- **Don't assume a browser-branded client calls from the browser.** A web
  client may well call server-side, in which case missing CORS headers never
  matter. This is cheap to settle empirically once a real client connects, and
  guessing either way wastes work.
- **Onboard one client at a time and verify each against real data**, because
  each of the above differs per client and the failures do not look like
  failures — they look like the model declining to use a tool.

## Per-client identity: logging and revocation

- **The moment more than one client holds credentials, a shared secret becomes
  the wrong boundary.** Revoking it disconnects everything, so in practice
  nobody revokes it. Per-client tokens make revocation targeted — but only if
  something records which client did what.
- **Mount the request log after the auth gate**, so unauthenticated requests
  never reach it. That is correct for accountability (a rejected request has no
  client to attribute) but means the log is **not** an intrusion-detection
  surface, and repeated failed auth is invisible in it. Know which of the two
  you are building.
- **Log no secrets, and treat session identifiers as secrets.** Tokens, codes,
  PKCE verifiers and client secrets are obvious; session ids are the one people
  miss, because they travel in query strings and are therefore captured by
  anything that logs full URLs — including a CDN or proxy in front of you.
- **Get RPC method and tool names from messages the transport has already
  parsed, never by adding a parser.** See the body-parser trap above; wanting
  richer logs is exactly the motivation that reintroduces that bug.
- **Verify that revocation actually revokes, against a running server, with no
  restart.** The decisive question is whether the server caches its token store
  in memory: if it does, revocation silently does nothing until the next
  deploy, and the control is cosmetic. Test it — mint a token, confirm it
  works, revoke, and confirm the *same running process* now rejects it, plus
  that the refresh token can't mint a replacement.
- **Revocation belongs to the operator, never to a tool.** An MCP tool that
  revokes clients is reachable by any authorized client, so a compromised one
  could revoke the others — or itself — over the channel the attacker already
  holds. Keep it in a script on the operator's side.
- **Fire-and-forget log writes are lost on restart.** "Never block the request"
  and "never lose the record" are different properties: writing on response
  completion without awaiting the write means a process-manager restart — i.e.
  every deploy — can exit with writes still queued. Serialize writes onto a
  per-file promise chain and drain it during shutdown. A flaky test under
  parallel load is what exposes this; treat that flake as a finding, not noise.
- **Anything registered via open DCR is attacker-controlled free text, and it
  ends up in your operator tooling.** A hostile `client_name` printed raw into
  a terminal can carry escape sequences that clear the screen, retitle it, or
  scroll a real entry out of view — defeating the one tool meant to show who
  is connected. **Stripping C0 control bytes is not sufficient:** Unicode bidi
  overrides (U+202E and friends) reorder a line visually using no control byte
  at all, U+2028 can fabricate an apparent second entry, and U+009B is a
  single-byte C1 escape introducer. Escape disallowed code points to a visible
  marker rather than deleting them — deletion leaves a plausible-looking name
  with no trace that anything was removed.

## Verifying a remote MCP server

Testing a server that talks HTTP to strangers is a different discipline than
testing a library. What held up across every phase of this migration:

- **One implementer, one adversarial reviewer, every phase.** The reviewer
  gets no access to the implementer's reasoning and is told to break the work,
  not confirm it. This found a real bug in every phase it ran — three of them
  cases where the implementer's own report said the work was fine. A single
  "review this" pass reads code and agrees with it; an adversarial pass tries
  to defeat it and reports what survived.
- **Send a finding back to the agent that wrote the code, not a fresh one.**
  It already holds the context. Re-verify the fix with the *same* reviewer
  that found the bug — it already has the exploit built and can re-run it
  directly against the patch.
- **Deleting a shared credential deletes the test harness that used it.**
  Every test that authenticated with a constant bearer string breaks the
  moment that credential is retired — not because the tests are wrong, but
  because OAuth has no equivalent constant to paste. Budget for rewriting the
  auth fixture itself (mint a real token through the real flow) as part of the
  migration, not as cleanup after.
- **Mutate the gate to prove the suite isn't vacuous.** Make the auth check
  unconditionally pass and re-run everything. A suite that still passes almost
  entirely was never testing auth in the first place — this caught it directly
  (19 of 42 tests failed once the gate was bypassed, confirming the rest guard
  something else).
- **A raw-socket test is the only thing that catches a body-parser
  regression.** Every SDK client and every `fetch` call constructs a
  well-formed HTTP request, which means none of them can ever observe a global
  body parser silently consuming the stream a raw-mode transport needs to read
  itself. Write at least one test that assembles bytes on a `net.Socket` by
  hand.
- **A health check whose failure mode is indistinguishable from success is not
  a check.** An unauthenticated probe asserting `401` proves the network path
  is alive — and a server whose auth is completely broken, denying everyone,
  returns the same `401`. Pair any such probe with a second one made using a
  real credential, or accept it only ever proves reachability.
- **Checksum the deployed artifact against the one you built; don't infer
  parity from behavior.** Every functional probe agreed before and after a
  real divergence between local and remote `dist/` — the extra files were
  inert, so nothing behavioral revealed them. `diff` the file list, then hash
  the contents. Behavior tests confirm the server works; they do not confirm
  it's running what you think it's running.

**What this file does not cover, and Phase 5 should say so rather than imply
otherwise:** load under real concurrent traffic; a second client onboarded
that behaves like a browser calling cross-origin (CORS was settled only for
server-side callers); rate limiting under an actual abuse attempt, not a
configured intention. Silence on a topic here means untested, not safe.

## Operational lessons (not MCP-specific, but proven directly across this project)

- **A compiler does not delete output for a source file you removed.** `tsc`
  leaves the orphaned `.js` in place indefinitely. If deployment ships a built
  directory wholesale — tar, rsync, a container COPY — deleted code keeps
  reaching production long after it is gone from source. Observed directly: a
  deleted auth module's compiled output landed on the server in the very deploy
  meant to remove it. It was inert (nothing imported it), which is exactly why
  nothing caught it: tests passed, the module graph resolved, the source was
  clean. Make the build clear its output directory first. Deleting the one
  stale file fixes one instance; cleaning the build fixes the class.
- **A plan's own record of what shipped is not evidence.** One migration
  document carried three claims of resolved work that had never been
  implemented — including a security control described in the past tense. Each
  was written in good faith at the moment a decision was made, and never
  reconciled against the code. Grep before trusting any document's account of
  its own completeness, most of all your own project's.
- **macOS `tar` ships junk to a Linux server, silently.** By default it emits
  an AppleDouble `._<name>` sidecar per file to carry extended attributes —
  invisible locally, and it lands on the remote host as one extra file next to
  every real one. Harmless (nothing resolves them), but the deployed tree no
  longer matched the built one, for a reason nothing in the deploy pipeline
  surfaced. `COPYFILE_DISABLE=1` before `tar` stops it at the source; excluding
  `._*` in the tar invocation catches any that predate the fix. Found only by
  checksumming the remote tree against the local one — see "Verifying a remote
  MCP server" below.
- **`pm2 restart <name> --update-env` merges new environment values onto
  pm2's *cached* process environment — it does not clear a key that's now
  simply absent from the new config.** Removing an env var and restarting
  (even by config-file path, see below) is not enough; the stale value
  persists. To genuinely unset something, stop and start fresh:
  `pm2 delete <app> && pm2 start <ecosystem-file>`.
- **`pm2 restart <app-name> --update-env` (by process name) does not
  re-execute a JS-based ecosystem config file's own top-level code** — e.g.
  logic that reads a `.env` file at require-time to build the `env` object
  passed to pm2. It only restarts the already-registered process record
  using whatever pm2 already has cached. To pick up a *new or changed*
  value, restart by the config file's path instead of the app's name:
  `pm2 restart ecosystem.config.cjs --update-env`. (To pick up a *removed*
  value, see the point above — restarting by file is still not enough.)
- **An env-forwarding layer that hand-picks which keys to forward is a
  silent trap.** If a custom `ecosystem.config.cjs`-style wrapper parses
  `.env` and then builds the process's `env` object by naming specific keys
  (`{ PORT: env.PORT, TOKEN: env.TOKEN }`), any new key added to `.env`
  later is invisible to the process until the wrapper is also updated.
  Spread the whole parsed object (`{ ...env }`) instead of allowlisting.
- **"Deployed" should mean "the actual delivered path was proven
  reachable," not "the process manager reports the process as running."** A
  process can be online and perfectly configured while completely
  unreachable from the outside — firewall rules, DNS, tunnel/proxy routing,
  and reverse-proxy config are all separate failure points from "does the
  process exist." Build the strongest cheap end-to-end check available into
  a deploy script: an unauthenticated request to the real public endpoint,
  checking for the specific expected response (e.g. a `401` from an
  auth-gated route, not just "got *a* response"), is a good low-cost proof
  of the whole chain working, and it caught real problems in this project
  that "pm2 says online" did not.
- **Mutation-test a test's own claim when it's meant to guard something
  load-bearing**, especially in adversarial/security verification: comment
  out or neuter the actual check the test is supposed to be protecting,
  re-run just that test, confirm it now fails, then revert. This is
  cheap and catches the difference between a test that has real teeth and
  one that passes regardless of whether the underlying protection exists.

- **Closing a network path breaks every tool that hardcoded the old address,
  and they fail in ways that look like something else.** Before removing a
  route — closing a port, moving a service, changing a hostname — grep the
  whole working tree for the old address, not just the obvious deploy script.
  Permission allowlists, editor/agent config, and helper wrappers all hardcode
  addresses and all fail silently: a permission rule that no longer matches
  reads as "permission denied" rather than "this rule is now dead". The
  existing rule "re-test every path that worked before" is usually applied to
  network endpoints; it applies to configuration just as much.

## Credential-scoping patterns that held up in practice

- **Request the narrowest permission scope that unblocks the specific task
  in front of you, and extend it only when a real, specific need appears —
  never speculatively, even when offered broader access.** This held up
  concretely: a Cloudflare API token scoped to exactly "manage this one
  tunnel, edit DNS for this one zone" was sufficient for initial setup; a
  second, still-narrow grant (adding "edit zone settings") was requested
  only once a specific blocked task needed it. Each round-trip cost a
  little friction; neither cost more than that.
- **Store durable credentials outside the project repository**, in a
  fixed, predictable, narrowly-permissioned location (e.g.
  `~/.config/<project>/*.env`, mode 600), read automatically by a small
  wrapper script rather than pasted into a session repeatedly. This makes a
  credential genuinely reusable across sessions without re-exposing the raw
  secret value each time, and keeps it out of the repo's git history by
  construction rather than by discipline (`.gitignore` alone is one mistake
  away from a leak; "lives somewhere the repo never touches" is not).
- **When a project accumulates more than one class of credential** (an SSH
  key, a shared API token, a cloud provider's API token, an OAuth client
  secret...), keep each one's scope and purpose separately and explicitly
  documented — which one grants what, and why it's scoped the way it is.
  It's easy to reach for the wrong one, or to widen one "while you're at it"
  without noticing it's actually a different credential with a different
  blast radius.
