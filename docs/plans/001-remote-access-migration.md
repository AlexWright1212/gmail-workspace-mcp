# Plan 001 — Remote access migration: Streamable HTTP, Cloudflare Tunnel, self-hosted OAuth

**Spec:** `docs/specs/001-email-tool.md`
**Status:** **Complete.** Phases 0–4 landed 2026-08-28 – 2026-08-30; Phase 5
(the skill) landed 2026-09-11. Nothing in this plan is outstanding. Phase 5 was
documentation work only and changed nothing in the running system.

**ADRs recorded 2026-08-28:** `docs/adr/012-public-streamable-http-via-cloudflare-tunnel.md`
(supersedes `007`), `docs/adr/013-self-hosted-oauth-google-upstream.md`
(decision only — this is what Phase 2 below implements), and
`docs/adr/014-cloudflare-api-access-scoped-token.md`. Read 013 before touching
Phase 2 — it is the canonical, binding reference for the non-negotiables
below; this plan doc is the living/tactical version, the ADR is the
decision-of-record. · **Opened:** 2026-08-28 · **Owner decisions recorded:** 2026-08-28

A multi-phase migration, run across sessions. This file is the context transfer
between them: what was decided, why, what phase we are in, and what is still
only a guess. Update the status line and the phase table as work lands.

## Start here if you're a new session picking this up

**Read, in order:** `CLAUDE.md` (project invariants — always read this first
regardless of task), this document in full (it's long because each section
earned its place; skimming it is how the "Left undone" dangling-reference bug
happened once already), then the ADR(s) relevant to what you're about to
touch — `docs/adr/012` for anything touching transport/tunnel/bind config,
`docs/adr/013` for anything touching OAuth, `docs/adr/014` for anything
touching the Cloudflare API token. Then skim `docs/tickets/README.md`'s Minor
list for anything relevant to the phase you're starting.

**Nothing is next — every phase is done and live-verified; don't re-do or
re-litigate them.** **Every access path this plan describes is now one path**:
`https://mcp.example.com/mcp`, OAuth only. There is no bearer token, no
`/sse`, and no fallback credential.

**A correction to what this document previously told you about Phase 4.** It
warned that removing the bearer would break `deploy.sh`'s post-deploy check
"and every ad-hoc verification in this document". That was **wrong**:
`deploy.sh` probes `/mcp` *unauthenticated* and asserts a 401, so it never used
the bearer and needed no change. The real hazard was the opposite shape and
this document did not name it — see Phase 4's results below.

**SSH is now tailnet-only — read this before you touch the VPS.**
`scripts/vps.sh` and `scripts/deploy.sh` default to `root@100.64.0.10`, the
**tailnet** address; the public IP no longer answers on port 22 at all. A
machine must be joined to the tailnet to deploy. **If Tailscale ever fails on
the VPS, the only way in is DigitalOcean's web console** — the owner set a
root password on 2026-08-30 (in their password manager) and confirmed by hand
that the console gives a real root shell. That password is not a network
exposure: `sshd` has `passwordauthentication no`, verified, so it works only
at the out-of-band console.

**The working pattern that got Phases 0–2 through clean, use it again:**

1. **Delegate implementation to one background subagent per coherent unit of
   work**, with an exhaustively precise brief — cite exact file paths, SDK
   facts already discovered (don't make it rediscover what this doc or an ADR
   already knows), the exact fences (which files it must never touch), and
   what "done" means. A vague brief on security-critical work produces
   security-critical guesses.
2. **Never trust a single self-report, ever, even a detailed one.** Every
   phase here that shipped clean did so because an *independent* agent — no
   access to the implementer's reasoning, told to verify or break it, not to
   confirm it — re-ran the real numbers and re-tried the real thing. For
   anything security-relevant, split this into two separate agents: one
   functional/spec-correctness, one purely adversarial. That split is what
   found the Phase 2 phishing hole; a single "review this" agent likely
   would've read the code and called it fine.
3. **When verification finds something real, send it back to the same
   implementing agent** (`SendMessage` to its agent id, not a fresh brief) —
   it already holds the context of its own code. **Then re-verify the fix
   with the same verification agent that found the original issue** — it
   already has the exploit/harness built and can re-run it directly against
   the fix, which is strictly better evidence than a fresh read.
4. **The single most expensive lesson from this phase: after any change to
   `.env`, bind address, or routing config, re-test every *existing* access
   path, not just the one you changed.** Twice in Phase 2 alone: a `HOST`
   change made for the tunnel silently broke the unrelated tailnet endpoint;
   Cloudflare's ingress allowlist wasn't updated for a new route, twice, and
   only the owner hitting a dead end live caught it. Before declaring
   anything done, hit every endpoint that existed *before* your change, not
   just the new one.
5. **`pm2 restart <name-or-file> --update-env` merges new env values onto the
   cached ones — it does not clear a variable that's now simply absent.** To
   unset something, `pm2 delete <app> && pm2 start ecosystem.config.cjs`, not
   restart.
6. **Deploy and do live production verification yourself, not delegated** —
   it's the one irreversible-ish step in the loop, after independent
   re-verification has already passed.
7. **Credentials:** store durably outside the repo
   (`~/.config/gmail-mcp/*.env`, mode 600), never print a full secret value
   back more than once, and request the *narrowest* scope that unblocks the
   task in front of you — extend only when a real, specific need is blocked,
   never speculatively, even if offered more. This is the owner's explicit
   standing preference (see the global `CLAUDE.md`, "Prioritize Agency and
   Autonomy"), and it held up in practice: two Cloudflare tokens, each scoped
   to exactly what was needed at the time, cost one extra round-trip each and
   nothing else.
8. **Anything requiring a live human action** (a real login, a real click, a
   real dashboard toggle GCP/Cloudflare console) — do not attempt to
   substitute automated verification for it, and do not let it block
   everything else. Finish every other part first, then ask for exactly that
   one thing, precisely.

## The goal

Make this server reachable, safely, by every MCP client the owner actually
wants to use it from — Claude Code on the MacBook, Codex, Cursor, claude.ai
(and therefore the Claude mobile apps), ChatGPT, and cloud agents running on
machines nobody owns in advance. Today it is reachable from exactly one place:
a Tailscale tailnet, over plain HTTP, behind a single shared bearer token.

## Decisions already made by the owner (2026-08-28)

| Question | Decision | Rejected |
|---|---|---|
| Who is the OAuth authorization server | **Self-hosted on the VPS**, using the MCP SDK's `mcpAuthRouter`. The consent step delegates login to Google, hard-restricted to the owner's two addresses. The server mints its own opaque tokens. | External IdP (Auth0/WorkOS/Stytch/Descope) — heavier machinery than one user justifies, and puts a third party in the path to the owner's own inbox. Passphrase+TOTP — reasonable, but Google reuses an OAuth client that already exists. |
| How the server is exposed | **Cloudflare Tunnel.** `cloudflared` dials outward; zero inbound ports. | Caddy + Let's Encrypt on the droplet (recommended by the agent, declined by the owner). Caddy behind a Cloudflare proxy. |
| How the work is executed | **One resident session driving subagents**, implementation and verification, phase by phase. | One chat per phase. Phases 0–1 only, then re-decide. |

**The confidentiality cost of the Tunnel choice was stated and accepted:**
Cloudflare decrypts message content in memory to route it, so the owner's email
passes through a third party in the clear. Bought in exchange for zero open
inbound ports, a hidden origin IP, and managed certs/DDoS/WAF.

## What changes about the threat model

Today the MCP port is unreachable from the internet; the bearer token is a
second lock on a door nobody can find. Afterwards, the OAuth endpoints are
publicly reachable and any authorized client can drive the inbox. This is a
real downgrade in one dimension, accepted as the price of the phone and
cloud-agent goals. Three things hold the line:

- **The send-allowlist does not change.** Scopes are a second layer, never a
  replacement. Nothing in this plan may touch the invariants in ADR 004 or the
  `assertSendAllowed()` / `deliver()` choke point.
- **Scopes** (`mail:read` / `mail:write`) let a low-trust client be read-only.
- **Per-client logging** makes revocation targeted rather than global.

Open DCR is *not* a hole: registering a client gets an attacker nothing,
because consent still requires proving they are the owner via Google.

## Non-negotiables

- Target MCP spec **2025-11-25**. Not the 2026-07-28 RC — no client speaks it
  yet. Design stateless so the RC is a small step, not a rewrite.
- **Stateless transport** (`sessionIdGenerator: undefined`, `enableJsonResponse: true`),
  **plus answering `GET`/`DELETE /mcp` with 405 before the transport sees them.**
  Required, not preferred: Cloudflare's proxy read timeout is **125s** and is not
  configurable below Enterprise, so nothing should depend on a long-lived
  stream surviving behind the tunnel. This server is pure request/response tools and loses nothing.
  **Corrected 2026-08-28:** the two transport options alone are *not* sufficient.
  `enableJsonResponse` gates only the POST path; the SDK still opens a
  `Connection: keep-alive` stream on `GET /mcp` regardless. The 405 rule is what
  actually delivers "no long-lived streams", and it is load-bearing for the tunnel.
- **Protected Resource Metadata (RFC 9728)** served, and `WWW-Authenticate:
  Bearer resource_metadata="…"` on every 401. Without it no client can discover
  the AS.
- **Never mount `express.json()` (or `urlencoded`) globally.** Every OAuth
  endpoint Phase 2 adds (`/token`, `/register`) wants a body parser, and the
  Streamable HTTP transport reads the **raw stream**. Mount either globally and
  `/mcp` hangs or sees an empty body. Mount per-route, or pass the parsed body
  explicitly via `transport.handleRequest(req, res, req.body)`. This is exactly
  the class of bug that passes a test which posts a pre-parsed body.
- **Token audience validation (RFC 8707).** Accept only tokens minted for this
  server's canonical URI. Never pass a Google token through as an MCP token —
  the spec forbids it and it is the confused-deputy hole.
- **Support DCR (RFC 7591)** even though 2025-11-25 demotes it: Claude Code
  still requires it in practice (anthropics/claude-code#67258).
- ~~Node binds `127.0.0.1`, never `0.0.0.0`, once the tunnel fronts it.~~
  **Reversed 2026-08-29 — this was wrong and broke production.** `127.0.0.1`
  binding is unreachable from *any* other host, including tailnet peers —
  it silently took the still-live `/sse` endpoint off the tailnet entirely
  (real-world impact: the owner's daily Claude Code connection over Tailscale
  failed with "Unable to connect" until this was caught and reverted). `ufw`
  already restricts port 3000 to the `tailscale0` interface only (ADR 007) —
  that firewall rule, not the app's own bind address, was always the actual
  boundary keeping port 3000 off the public internet, and it was never
  loosened or at risk. Binding to `127.0.0.1` added no real protection beyond
  what `ufw` already provided, while breaking something that worked. Node
  now binds all interfaces (`0.0.0.0`, the default — `HOST` is unset),
  exactly as before Phase 1. Verified after reverting: tailnet `/sse` → 401
  (restored), public `/mcp` via the tunnel → still 23 tools (unaffected),
  direct request to the public IP on :3000 → times out (`ufw` still blocking
  it). See `docs/adr/012`, Correction section.
- **The hostname is permanent.** The OAuth issuer URL and every client's RFC
  8707 `resource` value bake to it. Changing it later invalidates every
  registered client. Pick it before writing auth code.
- **Scopes ship with the first OAuth release.** Adding one later forces every
  client back through consent.
- **The bearer token stays as a fallback until Phase 4.** A half-working OAuth
  rollout must not lock the owner out of their own inbox tooling.

## Phases

Each leaves a working system. Nothing in 0–2 is publicly reachable.

| # | Work | Done when |
|---|---|---|
| **0** ✅ | Extract the HTTP/transport layer out of `src/index.ts` into importable `src/http/*` modules with tests. Add stateless Streamable HTTP at `/mcp` alongside the existing `/sse`. Still tailnet, still bearer. | **Done 2026-08-28.** Deployed and read back: `/mcp` returns 23 tools as `application/json` with no `mcp-session-id`; unauthenticated `/mcp` is 401 over the tailnet; legacy `/sse` intact. 243/243 tests, independently verified. |
| **1** ✅ | Domain onto Cloudflare nameservers. `cloudflared` on the VPS, tunnel + hostname. Tunnel reachable but still bearer-gated. | **Done 2026-08-28** (bind approach corrected 2026-08-29 — see "Non-negotiables" above). `https://mcp.example.com/mcp` round-tripped live from this MacBook, through Cloudflare, through the tunnel, to the real server: 401 with no token, 200 + 23 tools with one. `/sse`, `/messages`, `/` all 404 through the public hostname (ingress-restricted, `/sse` never published). See `docs/machine-setup.md` § "The public `/mcp` endpoint". |
| **2** ✅ | OAuth AS: `OAuthServerProvider`, persistent client/token stores, Google upstream login with owner-email allowlist, PRM endpoint, DCR, revocation, audience validation, `mail:read`/`mail:write`. Bearer accepted in parallel. | **Built and independently re-verified 2026-08-28** — see `docs/adr/013`. A real, working phishing exploit was found by adversarial review and fixed (mandatory consent screen) before deployment, not after. **Deployed and live-tested for real 2026-08-29** — the owner completed an actual Google login through a real Claude Code client (`gmail-remote`, added via `claude mcp add --transport http`), saw the consent screen render correctly, approved, and connected. Two Cloudflare tunnel ingress gaps were found and fixed live in production during this — see "Phase 2 — what actually happened" below. `/code-review ultra` still recommended before Phase 3 opens real outside clients; it remains user-triggered, not something this session can launch. |
| **3** ✅ | Close all inbound ports (`ufw`), move SSH to the tailnet. Per-client request log + `scripts/clients.sh list\|revoke`. Onboard claude.ai → phone → ChatGPT → Codex → Cursor, one at a time. | **Logging + revocation done 2026-08-30** (`docs/adr/015`), deployed and read back in production. **Onboarding done** — claude.ai and the phone work, Codex works, ChatGPT chat is blocked by OpenAI plan tiering (see below). **Lockdown done 2026-08-30** — SSH is tailnet-only and the VPS now has **zero publicly-reachable inbound ports**; verified by a real connection attempt to the public IP timing out. |
| **4** ✅ | Delete the bearer path, delete `/sse`, drop `MCP_BEARER_TOKEN`. Amend ADR 007; record the transport and auth decisions. | **Done 2026-08-30.** `src/http/auth.ts` deleted; `/sse` + `/messages` gone from the code, not merely unpublished; `MCP_BEARER_TOKEN` no longer read anywhere. `/mcp`'s gate now mounts unconditionally and fails closed. Recorded by **editing** ADR 012 and 013 in place and amending 007's status, not by writing new ADRs — the ADR index's rule is group-by-topic, and 012/013 already *are* the transport and auth decisions. 279 tests green. |
| **5** ✅ | The skill covering the operational half: transport, auth, exposure, client identity, and how a remote MCP server is verified. | **Done 2026-09-11.** Landed as three *global* skills, not one — split so the non-MCP halves stay reachable from unrelated work: `building-agent-tools` (+ `references/mcp-servers.md`, `references/remote-mcp-servers.md`), `hosting-remote-services` (+ `references/vps.md`, `references/cloudflare-tunnel.md`), and `provisioning-agent-credentials`. Verified via `verifying-skills`. `designing-agent-tools` was superseded and deleted. |

## Structural work that must come first (Phase 0)

`src/index.ts` is 4,130 lines and self-executes on import, so **nothing about
the transport or auth is testable today**. An OAuth authorization server —
token issuance, code exchange, audience checks — must not go into a file no
test can import. The extraction is the highest-leverage change in the plan and
is what makes the Phase 2 diff reviewable.

## Additions the owner did not originally list

- **`deploy.sh` needs a real post-deploy check.** "Deployed" must stop meaning
  "pm2 says online" and start meaning "an MCP `initialize` over the real public
  hostname returned a tool list." Same gap `list_accounts` fell into.
- **Client/token persistence** must survive a pm2 restart or every client
  silently re-auths on every deploy. Stores live under
  `/root/.gmail-multi-mcp/` — the directory agents are fenced out of — so
  `scripts/clients.sh list|revoke <client_id>` ships alongside, letting an agent
  enumerate and revoke without ever reading a secret. Same carve-out shape as
  ADR 010.
- **Rate limiting** on `/mcp`, `/register`, `/token` via Cloudflare WAF rules.
- **Every client must be re-added by hand at cutover**, and clients cache tool
  lists. Client-by-client onboarding, never big-bang.
- **No CORS handling exists at all**; `OPTIONS /mcp` currently returns 401 and
  no `Access-Control-Allow-*` header is emitted anywhere. claude.ai and ChatGPT
  connectors call server-side so this probably does not bite — but it is an
  *assumption*, not a verified fact. It belongs on the Phase 3 onboarding
  matrix, discovered deliberately rather than at cutover.
- **`GET /` still answers `ghub SSE server`** — reads wrong once Phase 4 deletes
  `/sse`.
- **SSH moves to the tailnet** in Phase 3. Net result of the whole project is
  *fewer* exposed surfaces than today, not more.

## Decided during Phase 0 (2026-08-28)

Three things surfaced during the extraction that Phase 1 must carry:

- **`POST /messages` has no bearer gate** and never has — the unguessable
  session id (`randomUUID()`, 122 bits, CSPRNG) is its only secret. Verified
  calibration: possession of a live session id is **not** information
  disclosure, it injects arbitrary JSON-RPC into an already-authenticated MCP
  session — full tool execution, still bounded by `assertSendAllowed()` on the
  final MIME bytes. Two things bound it: a session only exists *after* a
  bearer-authenticated `GET /sse`, so an unauthenticated attacker cannot cause
  one to exist; and the id never reaches the request log (`req.path` only).
  **Severity today: negligible** (tailnet, port closed). **If `/sse` is ever
  published: high** — and note the id travels in a *query string*, so any
  intermediary logging full URLs records it, which would include Cloudflare.
  Resolution: the tunnel's ingress rules route **only** `/mcp` and the OAuth
  paths; `/sse` + `/messages` are never published, and the bearer gate is
  extended to `/messages` as defence in depth.
- **No request body size limit on `POST /mcp`.** Confirmed empirically: a 30MB
  body was accepted, buffered and answered 200. `/messages` is **not** affected
  — `SSEServerTransport` caps it at 4mb and 404s an unknown session before
  reading the body at all. `/mcp` is the only uncapped path. A limit ships in
  Phase 1.
- **`HOST` was read but never passed to `listen()`** — dead code, so the server
  has always bound dual-stack. Preserved deliberately: `host` is now optional
  and omitted when `HOST` is unset. **The plan to use this for a `127.0.0.1`
  bind (below) was reversed 2026-08-29** — see the "Non-negotiables" section.
  `HOST` stays unset in production; this Phase 0 change is what makes that the
  default rather than requiring code changes to restore it.


## Phase 1 — Cloudflare configuration (researched 2026-08-28, sourced)

Two things the research corrected outright:

- **The timeout is 125s, not the 100s widely quoted** (Cloudflare's Proxy Read
  Timeout; not configurable below Enterprise). Whether it is idle-based or
  total is **not documented by Cloudflare** — strong community consensus says
  idle, unverified. Treat 125s as a hard ceiling on any single MCP request,
  because `enableJsonResponse` means nothing is written until the handler
  returns and there is no heartbeat escape hatch.
- **Named tunnels do not buffer SSE.** The universal "Cloudflare Tunnel breaks
  SSE" folklore traces to *Quick* Tunnels, which have deliberate demo
  guardrails — confirmed by a cloudflared maintainer on issue #1449. So the
  stateless/405 design is no longer justified as "the tunnel would break
  streaming"; it is justified because it removes the dependency entirely, and
  because SDK issue #2098 makes the failure mode *silent* (POSTs return 202,
  responses vanish) if a GET stream ever does die. Use a **named tunnel only**;
  never a Quick Tunnel beyond a smoke test.

### Server-side

1. Lock in `/mcp` stateless + `enableJsonResponse: true` + `GET`/`DELETE` → 405,
   **with a test asserting the 405**, so a future "but the spec allows GET"
   change fails loudly.
2. **Do not publish `/sse` or `/messages` through the tunnel.** Beyond the
   missing bearer gate, the SDK's `SSEServerTransport` has no keepalive at all
   (no `setInterval`/ping in `server/sse.js`), so an idle SSE session *will* be
   cut. Tunnel ingress publishes only `/mcp` and the OAuth paths.
3. **Add a request body size limit** to `POST /mcp` (the only uncapped path).
3b. **Pin Origin/Host checking in Express middleware, ahead of the transport.**
   The SDK validates Host/Origin *inside* `handleRequest`, which runs after the
   per-request `GmailMultiInboxServer` is constructed and connected — so a
   rejected request still pays full construction. Cheap (~0.5ms) so this is
   amplification, not a hole, but a gate that runs before the work is the point.
3c. **`app.disable('x-powered-by')`** — one line, currently advertising Express
   on every response.
4. Know which handlers could approach 125s (large attachment fetches are the
   candidate). A slow Gmail call becomes a 524 the client cannot distinguish
   from a crash.
5. Send explicit `Cache-Control: no-store` on `/token`, `/register`, `/revoke`,
   and explicit `Cache-Control` on both `/.well-known/*` documents. Edge caching
   defaults are extension-based and would not cache them anyway; this removes
   the ambiguity for free.

### Cloudflare zone settings

6. **Turn Browser Integrity Check OFF** for `/mcp`, `/authorize`, `/token`,
   `/register`, `/revoke`, `/.well-known/*` via a Configuration Rule (available
   on Free). **This is the single most likely day-one breakage:** BIC is ON by
   default on every zone and challenges clients with absent or non-standard
   user agents — exactly a Node-based MCP client. It surfaces as Cloudflare
   error 1010, which will look like an auth bug or a network error, not a WAF
   decision. Cloudflare's Security Events log is the only place it is named.
7. **Verify Bot Fight Mode is OFF.** It cannot be skipped per-path on Free — it
   does not run on the Ruleset Engine, so WAF rules and Page Rules cannot bypass
   it. Whether it defaults on for new Free zones is **unverified**; check the
   dashboard.
8. **Disable compression / auto-minify** for this hostname, or confirm it is
   off. Cloudflare silently enabling compression has broken streaming for
   `fetch`-based clients with no change on the origin side.
9. **One** rate-limiting rule is all Free provides: Path + IP only, 10-second
   window, 10-second mitigation. Spend it on **`/register`** — unauthenticated
   by definition and creates state. This is burst protection and nothing more;
   say so in the ADR rather than implying it is real abuse defence.
10. **Do not put Cloudflare Access in front of this.** It would bounce
    non-browser MCP clients at `/authorize` and gate the `/.well-known`
    documents, colliding with our own OAuth. Edge auth, if ever wanted, is a
    separate decision.

### Provisioning and credentials

11. **Full zone required** — the domain's nameservers must point at Cloudflare.
    Partial/CNAME setup is Business+ only, so there is no lighter option.
12. **Script the whole tunnel over the API**; no `cloudflared tunnel login`, no
    browser. One human step: create an API token scoped to
    `Account → Cloudflare Tunnel → Edit` and `Zone → DNS → Edit`. Then
    `scripts/tunnel-setup.sh` is agent-runnable forever — the same shape as the
    SSH deploy key.
13. **Never place `cert.pem` on the droplet.** It is account-wide (create,
    delete and manage *all* tunnels). Ship only the per-tunnel credentials JSON
    or token, which grants "run this one tunnel" and nothing else. Realistic
    abuse of a stolen tunnel credential is a rogue connector siphoning inbound
    requests — which is exactly why the OAuth gate, not the tunnel, is the
    security boundary.
14. **Read the routing back.** A documented failure mode is a tunnel that runs
    while the Public Hostname never routes. `curl` of
    `/.well-known/oauth-protected-resource` through the public hostname is the
    cheap end-to-end check, and belongs in `deploy.sh`.

### Unverified — do not build load-bearing logic on these

- Whether the 125s timeout is idle-based or total (no Cloudflare statement).
- Whether Bot Fight Mode defaults on for new Free zones.
- Whether `Authorization` / `WWW-Authenticate` pass through untouched —
  documented only by *omission* from Cloudflare's strip/modify lists. High
  confidence, not certainty. Verify with a real 401 through the tunnel.


## Phase 1 — what actually happened (2026-08-28)

Domain: `example.com`, registered and zoned directly on Cloudflare (no
transfer wait). Hostname: `mcp.example.com`, permanent per the non-negotiable
above. Tunnel provisioned entirely via the Cloudflare API with a token scoped
to `Account → Cloudflare Tunnel → Edit` + `Zone → DNS → Edit` — no
`cloudflared tunnel login`, no browser, no account-wide `cert.pem` ever placed
on the VPS. Ingress restricts the public hostname to `/mcp` and the not-yet-
built OAuth paths only; `/sse`, `/messages`, `/` all 404 publicly, matching
the "decided during Phase 0" resolution above.

**A real bug was found and fixed, not just the intended config change.**
Setting `HOST=127.0.0.1` in `.env` and restarting had no effect — `ss -tlnp`
kept showing `*:3000` after a full `deploy.sh` run. Root cause, in two parts:

1. `ecosystem.config.cjs` forwarded only `PORT`, `MCP_TRANSPORT`, and
   `MCP_BEARER_TOKEN` from the parsed `.env` into the pm2 process's `env` — a
   hand-picked allowlist that silently drops anything else, the same failure
   shape as the `dist/` tracking bug described at the top of `deploy.sh`.
   Fixed: it now spreads the entire parsed `.env` object.
2. **`pm2 restart <app-name> --update-env` does not re-execute
   `ecosystem.config.cjs`'s own JS** (the part that reads `.env`) — it restarts
   the already-registered process record. It reported success while nothing
   changed. Fixed: `deploy.sh` now restarts with `pm2 restart
   ecosystem.config.cjs --update-env` (by file, not by name), in both the
   normal path and `--rollback`.

Both fixes were verified against the live process (`ss -tlnp` before/after,
through a real `deploy.sh` run, not a manual workaround) before being trusted.
`ecosystem.config.cjs` was also missing from `deploy.sh`'s shipped file list
entirely — it lived on the VPS out-of-band. Both gaps are now closed.

`deploy.sh` also gained the post-deploy check the plan called for: every
deploy now curls `https://mcp.example.com/mcp` unauthenticated and confirms
a live 401, so "deployed" means the public path is proven reachable, not just
that pm2 reports online.

**Zone-security follow-up (2026-08-28):** the owner granted a second,
still-narrow Cloudflare token (Tunnel/DNS edit + Zone Settings edit) so this
could be finished without a dashboard click. Browser Integrity Check is now
**off**, confirmed via the API and re-verified against the live public
`/mcp` round-trip afterward. Two things remain genuinely blocked, confirmed by
testing rather than assumed: Bot Management and the Rulesets API (Configuration
Rules, rate limiting) both 403 with this token — a distinct permission group
neither "Zone Settings Edit" nor the two original scopes cover. Worth folding
into a future token alongside the `/register` rate-limit permission Phase 2
already needs, rather than requesting it in isolation. Full detail in
`docs/machine-setup.md` under "The Cloudflare API token" and "The public
`/mcp` endpoint".

## Phase 2 — what actually happened (2026-08-28)

Delegated to subagents end to end: one implementation pass, two independent
parallel verification agents (functional-correctness and pure-adversarial),
a fix pass sent back to the original implementing agent once the adversarial
agent found a real, working exploit, and a final re-verification pass by the
same adversarial agent against its own original attack. Full narrative and
the corrected reasoning live in `docs/adr/013-self-hosted-oauth-google-upstream.md`
— read that before touching this area again, it is now the canonical record,
this section is the short version.

**The headline finding:** the original design's core assumption — "a real
Google login is sufficient proof of consent" — was wrong, and adversarial
review proved it wrong with a working exploit before anything was deployed,
not after. Fixed with a mandatory, server-rendered consent screen. Closed and
independently re-verified, including direct probing of the fix itself (XSS
via the attacker-controlled client name, CSRF on the approve action, replay,
open redirect) — not just re-reading the patch.

**A second, unrelated bug** — an authorization code redeemable twice under a
race — was found and fixed in the same pass.

**Final numbers:** 264/264 tests (started at 243 after Phase 0/1, +16 for the
initial OAuth build, +5 for the two fixes), typecheck clean, zero fenced
files touched across the whole phase (`src/allowlist.ts`, `src/compose.ts`,
`deliver()` in `src/gmail-client.ts`, `tools-enabled.json`,
`src/http/transports.ts`, and every pre-existing dispatch-switch case body) —
verified independently by both verification agents, not just claimed by the
implementer.

**Two small, non-blocking items tracked, not gating deployment:** no
regression test pins the consent page's HTML-escaping specifically (correct
today, verified by hand, unguarded against a silent future regression); and
expired OAuth records (`pending.json`/`codes.json`) aren't proactively
reaped — bounded by TTL, low priority at current scale.

**Live end-to-end verification, 2026-08-29:** the owner added `gmail-remote`
via `claude mcp add --transport http gmail-remote https://mcp.example.com/mcp`,
triggered a real connection via `/mcp`, completed a real Google login, saw
the consent screen (client id, redirect host, plain-language scopes) render
correctly, approved, and connected successfully. This is the first real human
verification anything in Phase 2 received — everything before this was
automated tests and adversarial agents.

**Two separate production bugs were found and fixed live during this window,
neither caught by any test or agent review beforehand:**

1. **The `127.0.0.1` bind (see "Non-negotiables" above) broke the tailnet
   `/sse` endpoint** the day after Phase 1 shipped it — surfaced when the
   owner's daily Claude Code connection failed. Reverted; `ufw`, not the
   app's bind, was always the real boundary. Full story in `docs/adr/012`.
2. **The Cloudflare tunnel's ingress allowlist didn't include every OAuth
   route the app actually exposes — twice.** `/oauth/google/callback` was
   missing initially (caught before the owner's first attempt); `/oauth/consent`
   was missing on the owner's actual first live attempt (the security-fix
   round added that route *after* the ingress was last updated, and nothing
   cross-checked the two). Both fixed live, confirmed reachable, no other
   regression. **This is now a repeated failure pattern, not a one-off** — see
   the ticket note below.

## Phase 3 — what actually happened (2026-08-30)

Same loop as Phase 2: one implementation subagent, one independent adversarial
reviewer, fixes sent back to the *original* implementer, re-verified by the
*same* reviewer against its own exploit. Deploy and live production
verification done by the resident session, not delegated. Decision record:
`docs/adr/015-per-client-accountability.md`.

**Shipped:** the per-client request log, `scripts/clients.sh list|revoke`, a
raw-socket `/mcp` test, OAuth input validation, and a consent-page escaping
regression test. 264 → 282 tests. Deployed and read back in production: the
log records real client ids and tool names, `clients.sh list` names every live
client, and every pre-existing access path was re-tested after each deploy
(public `/mcp` 401/200-with-23-tools, tailnet `/sse` 401, `GET`/`DELETE /mcp`
405, PRM 200, public IP `:3000` still blocked by `ufw`).

**Three things the reviewer caught that the implementer's own report claimed
were fine.** This is the third phase in a row where that split earned its cost:

1. **Log lines were being dropped on every deploy.** Fire-and-forget writes,
   nothing awaiting them, `process.exit(0)` on SIGTERM. Surfaced only as a
   ~25% flaky test under full-suite load — a single green run would have
   shipped it.
2. **A working Unicode spoofing exploit in `clients.sh`.** The first fix
   stripped C0/DEL; U+202E RIGHT-TO-LEFT OVERRIDE walked straight through and
   can make a hostile client render as an innocuous one, in the very tool
   meant to be the trustworthy view of who is connected.
3. **The suite could not catch the body-parser regression this plan warns
   about most.** Every `/mcp` test drove an SDK client posting pre-parsed
   bodies. Now closed by a raw-socket test, proven to fail when
   `express.json()` is mounted.

### The client onboarding matrix — results

| Client | Result |
|---|---|
| **claude.ai** | ✅ Working. DCR + Google login + consent + 4 real `tools/call:search_emails`. Redirect: `https://claude.ai/api/mcp/auth_callback`. |
| **Phone (Claude app)** | ✅ Working — inherits the claude.ai connector via the account, no separate setup. **This was the headline goal of the whole migration.** |
| **Claude Code** (`gmail-remote`) | ✅ Working, since Phase 2. |
| **Codex** (in ChatGPT desktop, Codex mode) | ✅ Working — reads from both inboxes. Redirect: loopback `http://127.0.0.1:<port>/callback/<nonce>`. |
| **ChatGPT chat** | ❌ **Blocked by OpenAI plan tiering, not by anything here.** Do not attempt to fix this server-side. |
| **Cursor** | ✅ Working. Connected as a custom connector 2026-09-11, DCR + Google login + consent, live access and refresh tokens issued and confirmed in `clients.sh list`. |

**The ChatGPT finding, so nobody re-runs this investigation.** Adding an MCP
server via the ChatGPT **desktop** app's Settings → Plugins → MCPs writes it
into `~/.codex/config.toml` — it configures **Codex**, not the ChatGPT chat
model. OpenAI documents the desktop app, Codex CLI, and IDE extension as
sharing one MCP configuration for the same Codex host. The client
self-registers with `client_name: "Codex"`, which is the giveaway in
`clients.sh list`.

Consequence: the server connects perfectly and the chat model still says the
tools are "not exposed to this chat session" — the observed signature was **10
clean `initialize` + `tools/list` handshakes returning all 23 tools, and zero
`tools/call`, ever.** Switching the desktop app into **Codex mode** makes it
work immediately. Custom MCP in *regular* ChatGPT chat requires OpenAI's
"Developer Mode", documented for Business/Enterprise/Edu (full) and Pro
(read/fetch only); **Plus is not listed at any tier**, which is why the web
Plugins page offers no way to add a custom server at all. Owner's decision
(2026-08-30): don't pursue Developer Mode — use Codex chats within the OpenAI
ecosystem, which works fine.

**A caution for whoever reads this next:** during the investigation this
signature was briefly attributed to an open Codex bug (`openai/codex#20009`,
"authenticates OAuth MCP server but never imports tools into threads"). That
attribution was **wrong** — the tools were simply never offered to the chat
surface, and Codex mode calls them without incident. The mechanism above is
the complete explanation; no upstream bug is involved.

**Also settled here:** the CORS question this plan flagged as an unverified
assumption. claude.ai calls the server **server-side**, so the total absence of
`Access-Control-*` headers never mattered. No CORS work is needed for it.
Whether a future browser-side client needs it remains open.


## Phase 4 — what actually happened (2026-08-30)

**Shipped:** `src/http/auth.ts` deleted; `/sse` + `POST /messages` and the
whole stateful session map removed from `src/http/transports.ts`;
`MCP_BEARER_TOKEN` removed from every type, from `resolveHttpConfigFromEnv`,
and from the VPS `.env` (backed up at `.env.pre-phase4.bak`); `GET /` stopped
claiming to be an "SSE server"; `runSseServer` renamed `runHttpServer`.
Recorded by editing ADR 012 and 013 in place and amending 007's status — not
by writing new ADRs, since the index's rule is group-by-topic and 012/013
already *are* the transport and auth decisions. 282 → 279 tests (five
bearer/SSE tests deleted, three new ones added).

**The one thing that had to be got right, and nearly wasn't obvious.** The
`/mcp` gate was mounted as `if (bearerToken || mountedOAuth)`. Deleting the
bearer without touching that condition would have meant **an unconfigured
OAuth layer mounts no gate at all** — a wide-open inbox on a publicly-routed
hostname, reached by deleting a line rather than adding one. `config.ts`
returns `undefined` on a partial OAuth bootstrap *by design* (documented as a
safe degraded mode, which it genuinely was while the bearer existed), so this
was one missing env var away from live. Closed twice: `createMcpAuthGate`
returns a deny-all handler when `oauth` is absent and mounts unconditionally,
and `runHttpServer` throws before binding a port.

**Why "refuse to boot" rather than "boot and deny everything".**
`deploy.sh`'s post-deploy check POSTs to `/mcp` **unauthenticated** and treats
a 401 as proof the whole path is healthy. A deny-everything server returns
401 to exactly that probe — it would have **passed its own deploy check while
serving nobody**. A process that refuses to start makes pm2 report the app
down, which the check *does* catch, with `--rollback` available. This is the
same shape as `list_accounts` reporting `ready` for two weeks: a health check
that cannot distinguish "working" from "uniformly broken" is not a health
check.

**A stale warning in this document, corrected.** The Phase 4 preamble claimed
removing the bearer would break `deploy.sh`'s post-deploy check "and every
ad-hoc verification in this document". False — that check never used the
bearer. Worth noting because the warning was *confidently specific* and still
wrong, and it pointed attention away from the real hazard above. Verify a
claim about tooling against the tooling.

**Also resolved by deletion rather than by fixing it:** Phase 0's notes
recorded that the bearer gate would be "extended to `/messages` as defence in
depth". **It never was** — `createBearerAuthMiddleware` was only ever mounted
on `/sse`. That gap sat open, unnoticed, from Phase 0 to Phase 4, recorded in
this document as though it were done. Bounded the whole time (tailnet + `ufw`,
and a session had to exist first), but the lesson stands: a resolution written
into a plan is not a resolution shipped into code.

**Verified in production after each of the two restarts** (deploy, then the
`pm2 delete` + `start` needed to actually clear the env var): public `/mcp`
401 unauthenticated *and* with the retired bearer; PRM and AS metadata 200;
`/register` and `/authorize` reachable (400, not 404 — ingress intact);
tailnet `/sse` and `/messages` 404; tailnet `/mcp` 401; `GET /` says
`ghub MCP server`; public IP :3000 and :22 both time out. Then the real
proof: a live `search_emails` across both inboxes through a real OAuth client,
attributed by name in `clients.sh list` and logged with `authMethod: oauth`.
The request log holds zero `unknown` lines.

**Client cutover:** the owner's local `gmail-mcp` server (tailnet SSE +
bearer) was removed from `~/.claude.json`; `gmail-remote` is the only entry
and reconnected clean.

### What the adversarial reviewer found that the implementation missed

Fourth phase running, same result: the independent pass earned its cost.

**`dist/http/auth.js` survived the deletion of `src/http/auth.ts`, and had
already shipped to the VPS.** `tsc` does not remove output for a source file
that no longer exists, `npm run build` never cleaned `dist/`, and
`scripts/deploy.sh` only does `rm -rf dist` on the **remote** side before
untarring the *local* `dist/` over it — so the file was copied to production,
containing the complete `isAuthorizedBearer` comparison, in the very deploy
that was supposed to delete it. **Inert** (nothing imports it, verified), so
no live exposure — but "the bearer is deleted" was, for about forty minutes,
true of the source and false of the running server. That is precisely this
project's founding bug class: *a thing that looks right in one representation
silently differs in the one that actually runs.* Fixed at the root — `npm run
build` now clears `dist/` first — rather than by deleting the one file. Every
future orphan is covered; deleting the file by hand would have covered one.
Re-deployed and read back: gone, and `grep -rl isAuthorizedBearer dist/`
returns nothing on the VPS.

**Two stale comments** describing the bearer path as live, including the one
directly above the scope-gate call in `src/index.ts` — the single most
important place for that comment to be accurate — and `src/http/oauth/config.ts`'s
module doc, whose stated rationale ("must never crash the server or put the
legacy bearer-token path at risk") had become false in a file Phase 4's diff
never opened. Both corrected.

**What it could not break**, having tried: `/mcp/`, `/MCP`, `/mcp%2f`,
`/mcp/../mcp`, `/mcp;foo=bar`, method overrides, and every OAuth route — none
reach tool dispatch. Fail-closed verified end to end by running the real
`dist/index.js` with no OAuth env: it threw and exited 1 **before any port
bound** (`nc -z` closed, curl refused). The `authInfo` propagation path —
the thing that would be a full unscoped-access bug if it leaked — was traced
through the SDK *and* attacked with batched JSON-RPC arrays, a
notification-plus-request batch, and a bare `tools/call` notification with no
`id`: scope checks held on every message, and the id-less notification
executed zero tools. `authMethod: 'unknown'` proved unreachable. And the
suite is not vacuous: mutating `createMcpAuthGate` to unconditionally
`next()` failed **19 of 42** tests across all four rewritten files.

**One pre-existing gap it surfaced, out of scope here:** Phase 0's notes say
"a limit ships in Phase 1" about the missing request-body size cap on
`POST /mcp`. Checked directly — **no such limit exists anywhere in the code.**
That is the *third* item this plan recorded as resolved that was never
implemented (with the `/messages` gate above, and the stale `deploy.sh`
warning). Filed in `docs/tickets/README.md`'s Minor list.

## Owner actions that cannot be automated

- ~~Register / point a domain at Cloudflare nameservers~~ **Done 2026-08-28** — `example.com`.
- **Two Cloudflare zone-security items, both blocked on token scope, not on
  the owner's time:** confirming Bot Fight Mode is off, and (once `/register`
  actually needs it) a rate-limit rule — see `docs/machine-setup.md` §"The
  Cloudflare API token" for the exact permissions to add. Browser Integrity
  Check, the third original item, is already done (2026-08-28).
- Approve the Google OAuth web client's redirect URI in GCP once the hostname
  exists. (Phase 2)
- ~~Add the connector by hand in claude.ai and ChatGPT.~~ **Done 2026-08-30.**
  claude.ai, the phone, and Codex all connected and verified against real
  mail. ChatGPT chat is closed to us by plan tiering — see the onboarding
  matrix above; no owner action would change it.
- **Set a root password + test the DigitalOcean console.** ~~Pending~~
  **Done 2026-08-30** — password in the owner's password manager, console
  login confirmed to give a real root shell. This is the prerequisite for
  the `ufw` lockdown.

## Still only a guess — verify before relying on it

- ~~Cloudflare's origin-timeout and stream-buffering behaviour.~~ **Researched
  2026-08-28** — see the Phase 1 section. Residual unknowns listed there.
- ~~Per-request construction cost of a stateless `GmailMultiInboxServer`.~~
  **Closed 2026-08-28.** Measured against the real built server, 200 samples:
  full `initialize` p50 0.47ms / p90 0.76ms, `tools/list` p50 0.49ms,
  `ensureConfigLayout` 17µs. Nothing needs hoisting.
- ~~Whether CORS handling is needed.~~ **Settled 2026-08-30** — claude.ai calls
  server-side, so the absent `Access-Control-*` headers never mattered.
  `OPTIONS /mcp` still 401s with no CORS headers; if a genuinely browser-side
  client is ever onboarded, this reopens.
- ~~Whether Claude Code's DCR handling has changed since #67258.~~ **Settled
  2026-08-29** — the owner's real `claude mcp add --transport http` connection
  completed DCR, PKCE, the Google redirect, and the consent flow successfully
  end to end. Whatever changed or didn't since that issue, it works today.
