# ADR 012 — Public Streamable HTTP Endpoint via Cloudflare Tunnel

**Last edited:** 2026-08-30
**Status:** Accepted — supersedes ADR 007. **Phase 4 landed 2026-08-30**: the
`/sse` + `/messages` endpoints this ADR kept alive are now deleted, and `/mcp`
is the server's only MCP transport. See "Phase 4" below.
**Origin:** `docs/plans/001-remote-access-migration.md`

---

## Context

The owner wants this server usable from Claude Code, Codex, and Cursor on the
MacBook; from claude.ai and ChatGPT (and, through claude.ai, the Claude mobile
apps); and eventually from cloud agents running on infrastructure nobody owns
in advance. ADR 007's Tailscale-only design cannot satisfy this, structurally,
not as a matter of degree: a cloud agent generally cannot run `tailscaled` or
be added to a private tailnet ahead of time, and claude.ai / ChatGPT's
connector infrastructure reaches a server from *their* IP ranges over the
public internet — no tailnet arrangement lets that happen. Tailscale is
disqualified by the phone and cloud-agent goals alone, independent of any
cloud-agent-specific reasoning.

Separately, the MCP transport this server used — HTTP+SSE, two endpoints
(`GET /sse`, `POST /messages`) — was deprecated by the protocol itself as of
spec revision `2025-03-26`, replaced by a single-endpoint Streamable HTTP
transport. Current stable is `2025-11-25`. New MCP clients (ChatGPT's
connector infrastructure, current Codex) are built against Streamable HTTP,
not HTTP+SSE.

## Options Considered

**Caddy + Let's Encrypt on the VPS.** Terminates TLS on the owner's own
hardware; nobody but the VPS ever sees plaintext. One open port (443), VPS IP
public, DDoS/rate-limiting the owner's own responsibility. Recommended by the
agent as the option that keeps the server's confidentiality architecturally
simple. **Declined by the owner** in favor of Cloudflare Tunnel.

**Caddy behind a Cloudflare proxy.** Gets Cloudflare's edge protections
(rate-limiting, hidden origin) without giving up local TLS control. Rejected:
it keeps port 443 open (Caddy's own downside) **and** still routes plaintext
through Cloudflare's edge (the Tunnel's downside) — the costs of both options
with the escape-hatch benefit of neither.

**Cloudflare Tunnel (chosen).** `cloudflared` on the VPS dials *outward* to
Cloudflare; the tunnel is outbound-only, so `ufw` can deny all inbound traffic
to port 3000 and the VPS's origin IP never needs to be reachable at all.
Managed TLS, DDoS protection, and WAF come included. **The real cost, stated
plainly and accepted by the owner:** Cloudflare decrypts message content in
memory to route it, so the owner's email passes through a third party in the
clear during transit — a genuine confidentiality trade the Caddy option would
not have required. Bought for zero open inbound ports, a hidden origin IP, and
not having to run or patch an edge server.

**Stay Tailscale-only indefinitely.** Rejected — it is the status quo this
phase exists to move past; none of the target clients (claude.ai, ChatGPT,
mobile, cloud agents) can reach a private tailnet.

## Decision

Expose a **stateless Streamable HTTP** endpoint at `/mcp`, reachable publicly
at `https://mcp.example.com/mcp` through a named Cloudflare Tunnel, still
gated by the existing shared bearer token (until ADR 013's OAuth layer lands).
The original `/sse` + `/messages` endpoints are kept, unchanged, tailnet-only
— not deleted until Phase 4. (**They were deleted on 2026-08-30; see "Phase 4"
below.** The rest of this section describes the state between 2026-08-28 and
that date, and is kept because the reasoning for the `0.0.0.0` bind and the
ingress restriction both turn on `/sse` still existing at the time.)

**Node binds all interfaces (`0.0.0.0:3000`), unchanged from before this ADR.**
An earlier draft of this decision bound to `127.0.0.1` instead, reasoning that
only `cloudflared` on the same machine needed to reach it — that reasoning
missed that `/sse` (above) still needs to be reachable from other tailnet
devices over `100.64.0.10`, which a loopback-only bind makes categorically
impossible regardless of `ufw`. This was deployed on 2026-08-28 and broke the
owner's live Tailscale connection the next day before being caught and
reverted. **`ufw`, not the app's bind address, is and was always the actual
boundary** keeping port 3000 off the public internet (ADR 007) — it already
restricts the port to the `tailscale0` interface only, so binding to all
interfaces adds no exposure the firewall doesn't already prevent. Confirmed
after reverting: a direct request to the public IP on :3000 still times out.
See "Correction" below.

**The tunnel's ingress restricts the public hostname to `/mcp` and future
OAuth paths only** (`/authorize`, `/token`, `/register`, `/revoke`,
`/.well-known/*`). `/sse`, `/messages`, and `/` all 404 through the public
hostname, by design, for two independent reasons: `POST /messages` has never
had a bearer gate of its own — an unguessable session id (`randomUUID()`) is
its only secret, and that id travels in a URL query string, which any
intermediary that logs full URLs (Cloudflare included) would then record.
Separately, `SSEServerTransport` has no keepalive at all, so an idle `/sse`
session would be killed outright by Cloudflare's proxy read timeout the first
time it went quiet.

**The transport itself had to be redesigned, not just re-exposed.** Two
requirements, both load-bearing, not preference:

- `sessionIdGenerator: undefined` and `enableJsonResponse: true` — stateless,
  request/response only. Necessary because Cloudflare's proxy read timeout is
  **125 seconds** (confirmed against Cloudflare's own docs; not configurable
  below Enterprise on any plan), so nothing can depend on a long-lived stream
  surviving. This server is pure request/response tools — no sampling, no
  server-initiated notifications — so statelessness costs nothing
  functionally.
- **`GET`/`DELETE /mcp` answered with `405` before the transport ever sees
  them.** `enableJsonResponse` alone does **not** stop the MCP SDK client from
  opening a standalone `GET /mcp` stream for server-initiated messages
  regardless — that stream is what a proxy timeout would eventually kill, and
  a dead GET stream fails *silently* in the SDK (a known upstream bug,
  `modelcontextprotocol/typescript-sdk#2098`: subsequent POSTs keep returning
  202 while responses are lost). The 405 is spec-sanctioned — the MCP
  transport spec explicitly permits a server to answer `GET` with 405 when it
  offers no stream — and removes the failure mode entirely rather than
  mitigating it.

## What's Now Known

Verified live, from a real client, over the actual public internet — not
assumed from local testing:

- `POST https://mcp.example.com/mcp` with no token → `401`. With a valid
  token → `200`, all 23 tools returned, `Content-Type: application/json`, no
  `mcp-session-id` header (statelessness confirmed at the wire, not just in
  code).
- `/sse`, `/messages`, and `/` → `404` through the public hostname, confirming
  the ingress restriction actually holds.

**A real bug was found and fixed in the deploy path while wiring this up, not
just the intended config change:** setting `HOST=127.0.0.1` in `.env` had no
effect after a full `deploy.sh` run — `ss -tlnp` still showed `*:3000`. Root
cause, two parts: `ecosystem.config.cjs` forwarded only three hand-picked
env vars into the pm2 process (now forwards the whole parsed `.env`), and
`pm2 restart <app-name> --update-env` restarts the already-registered process
without ever re-executing `ecosystem.config.cjs`'s own JS — the part that
reads `.env` — so a changed value silently never reached the process even
though the restart reported success. Fixed by restarting with `pm2 restart
ecosystem.config.cjs --update-env` (by config-file path, not by name) in both
the normal and `--rollback` paths of `deploy.sh`. Verified through a real
full deploy afterward, not a manual workaround.

**Browser Integrity Check** (Cloudflare's default-on challenge for
non-standard user agents — exactly what a Node-based MCP client looks like)
was confirmed `on` by default, then turned **off** for this zone after
explicit owner confirmation (the auto-mode classifier independently stopped
the change pending that confirmation, correctly). The live `/mcp` round-trip
was re-verified afterward. See ADR 014 for the credential this used.

## Correction (2026-08-29): the `127.0.0.1` bind was wrong

Deployed 2026-08-28 alongside everything else in this ADR: Node was set to
bind `127.0.0.1:3000` only, reasoning that since `cloudflared` reaches the
app over `localhost`, nothing else needed to reach it directly. That reasoning
didn't account for the still-live `/sse` endpoint (kept explicitly, above,
until Phase 4) needing to be reachable from other devices on the Tailscale
tailnet at `100.64.0.10` — a loopback-only bind is unreachable from *any*
other host by definition, tailnet included, independent of any firewall
rule.

**Real-world impact:** the owner's day-to-day Claude Code connection over
Tailscale failed the next day with "SSE error: Unable to connect" — caught
during a live session, not by any test, since nothing in this project's test
suite exercises the deployed tailnet path. Diagnosed by checking the actual
bind (`ss -tlnp` showed `127.0.0.1:3000`) and `ufw`'s rules (still correctly
scoped to `tailscale0` only, confirming the firewall was never the problem).

**Fix:** removed `HOST=127.0.0.1` from the VPS `.env`. One more thing was
learned in the process — `pm2 restart <name-or-file> --update-env` merges new
environment values onto pm2's *cached* process env; it does not clear a key
that's simply absent from the new config. Removing the line and restarting
left the stale value in place. A full `pm2 delete` + `pm2 start` was required
to actually clear it — worth remembering, since the earlier
`ecosystem.config.cjs` fix in this ADR only proved restarting-by-file picks up
*added or changed* values, not that it clears *removed* ones.

**Verified after reverting:** tailnet `/sse` → `401` (restored, correctly
gated); public `/mcp` via the tunnel → unaffected, still returns the full tool
list; a direct request to the public IP on port 3000 → still times out,
confirming `ufw` — not the app's bind — was and remains the actual security
boundary, exactly as ADR 007 established. Nothing about the public tunnel's
security depended on the `127.0.0.1` bind; it was redundant defense-in-depth
that broke a working feature without preventing anything `ufw` didn't already
prevent.

## Phase 4 (2026-08-30): `/sse` and `/messages` deleted

The two endpoints above are gone from the code, not merely unpublished — along
with `createSseEndpoints`, the `SSEServerTransport` import, and the whole
stateful session map. `/mcp` is the only MCP transport this server has.

**Why delete rather than keep them tailnet-only.** They cost nothing to leave
running, which is exactly the argument that keeps dead code alive for years.
Against that: `POST /messages` never had an auth gate of its own (the Phase 0
notes recorded a plan to add one as defence in depth; **it was never
implemented**, and this deletion is what actually resolves that), the session
id it relies on travels in a query string, and the whole path was a second,
differently-shaped way to reach tool dispatch that every future security
review would have to reason about separately. Its only remaining user was the
owner's own Claude Code `gmail-mcp` server, re-pointed at the public `/mcp`
endpoint as part of this phase.

**What replaces the reachability it provided.** Nothing, deliberately. The
tailnet is now purely the SSH/admin path (see ADR 007's amended status). A
client reaches this server one way: `https://mcp.example.com/mcp`, with an
OAuth token. The `0.0.0.0` bind stays as-is — `ufw` is still the boundary, and
changing a working bind for tidiness is exactly the move the Correction above
exists to warn against.

**The `GET`/`DELETE /mcp` → 405 rule is unaffected and still load-bearing.**
It was never about `/sse`; it is about the SDK's own standalone GET stream.

**A build-hygiene trap this surfaced, worth knowing before any future
deletion.** `tsc` does not remove compiled output for a source file that no
longer exists, and `scripts/deploy.sh` untars the *local* `dist/` over the
remote one. So `dist/http/auth.js` — the deleted bearer gate — shipped to the
VPS in the very deploy meant to remove it. Inert (nothing imported it), caught
by adversarial review, fixed at the root: `npm run build` now clears `dist/`
first. Recorded here rather than as a footnote because it is this project's
founding bug in a new costume — the source said one thing, the artifact that
actually ran said another, and every test passed either way.

## Consequences

- **The threat model changes.** Before: the MCP port was unreachable from the
  internet at all; the bearer token was a second lock on a door nobody could
  find. Now: `/mcp` is publicly reachable. Between 2026-08-28 and 2026-08-29
  the shared bearer token was the *only* thing standing between the internet
  and this inbox; ADR 013's OAuth layer then replaced it, and Phase 4 deleted
  it. This is a real downgrade in one dimension, accepted as the necessary
  cost of the phone and cloud-agent goals.
- **Content is decrypted in Cloudflare's memory in transit.** Stated
  explicitly here rather than left implicit: this is different from every
  prior transport this project used, all of which kept plaintext off any
  third party's hardware.
- **Tailscale is demoted, not removed.** It remains the SSH/admin path.
  Phase 3 moved SSH itself onto the tailnet (2026-08-30), and Phase 4's
  deletion of `/sse` removed the last non-administrative thing it carried —
  the tailnet's role is now purely administrative, as predicted here.
- **Every MCP tool call now has a hard 125-second ceiling**, with no
  heartbeat escape hatch (nothing is written to the response until the
  handler completes, by design of `enableJsonResponse`). Trivial for Gmail
  calls today; worth remembering if a future feature does something slow
  (a large attachment fetch, say).
- **`docs/tickets/002-http-not-https.md` is not reopened by this** — that
  ticket was about plaintext-over-the-public-internet, which never returns:
  the endpoint is HTTPS via Cloudflare's edge, not plain HTTP.

## Pointers

- `docs/plans/001-remote-access-migration.md` — the full multi-phase plan
  this ADR is Phase 0/1 of; Phases 2–5 are not yet built.
- `src/http/{server,transports}.ts` — the extracted, testable transport layer
  this decision required (`src/index.ts` used to self-execute on import, so
  none of this was testable before). `src/http/auth.ts`, which held the shared
  bearer gate, was deleted in Phase 4.
- `scripts/deploy.sh` — the `pm2 restart ecosystem.config.cjs` fix, and the
  post-deploy public-hostname health check this decision added.
- `scripts/cloudflare-api.sh`, `docs/machine-setup.md` §"The public `/mcp`
  endpoint" — how the tunnel was provisioned and how to verify it by hand.
- `docs/adr/007-tailscale-only-sse-endpoint.md` — **superseded** by this ADR;
  kept as the historical record of the decision this one reverses.
- `docs/adr/004-extend-allowlist-to-workspace-tools.md` — the send-allowlist
  boundary, unaffected by any of this: a leaked bearer token still cannot send
  outside the allowlist.
