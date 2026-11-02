# ADR 007 — Tailscale-Only SSE Endpoint

**Last edited:** 2026-08-30 (written 2026-08-19)
**Status:** Superseded by ADR 012 (2026-08-28), and **fully unwound as of
2026-08-30**: Phase 4 deleted the `/sse` + `/messages` endpoints this ADR was
about, so nothing it decided is still in force. `/mcp` over Cloudflare Tunnel,
OAuth-gated, is the only way in — see ADR 012 (transport) and ADR 013 (auth).
Kept below as the historical record of the reasoning this reverses.
**Origin:** `docs/tickets/002-http-not-https.md`

**Tailscale itself is not removed, and its role grew rather than shrank.** SSH
moved onto the tailnet on 2026-08-30 and the VPS now has zero publicly
reachable inbound ports. So this ADR's core instinct — put the private thing
behind a private network — was right; it was applied to the wrong thing. The
MCP endpoint had to be public to reach a phone or a cloud agent. The
administrative path did not, and that is where the tailnet ended up.

---

## Context

ADR 001 decided plain HTTP was acceptable at launch: "Acceptable for personal
use on a home network or VPN; not suitable if the endpoint were ever made
public beyond personal use." That decision was never revisited against real
usage — `docs/tickets/002-http-not-https.md` existed specifically to do that.

The problem the ticket named: the SSE endpoint
(`http://203.0.113.10:3000/sse`) had no TLS and no network-level access
control of any kind. Confirmed directly from ADR 001's own text: "The SSE
endpoint sits on a public IP with no network-level access control... anyone
who discovers the URL can read the emails." The bearer token was the *only*
barrier, and it traveled in cleartext — readable by anyone positioned on the
network path (hostile wifi, a compromised router) between a client and the
VPS. A stolen token would grant full read access to both Gmail accounts.
Sending is separately hard-blocked by the send-allowlist (ADR 004) and
unaffected either way.

The owner's actual usage confirmed the risk is real, not theoretical: clients
connect from home wifi *and* public wifi (coffee shops, hotels, etc.), not
exclusively a trusted network.

## Options Considered

**Caddy + a real domain (automatic HTTPS via Let's Encrypt).** Encrypts
traffic in transit, keeps a plain "visit a URL" client experience. Rejected:
it only solves the cleartext-token problem. The server would remain reachable
by the entire public internet — same exposure surface as today, just
encrypted — protected by nothing but the bearer token. Also requires
owning/pointing a domain at the VPS and opening port 443, for a "reachable
from literally anywhere" property the owner doesn't need: real usage is one
MacBook today, maybe a phone later, not an unknown/wide client base.

**Status quo — accept the risk.** Rejected once the owner confirmed real
usage includes untrusted public networks. The original ADR 001 caveat ("not
suitable if the endpoint were ever made public") already anticipated this
outcome; usage just confirmed it applies.

**Tailscale (private mesh VPN).** Chosen. Every joined device gets a private
address reachable only from other devices on the same tailnet; the server
stops being addressable from the public internet at all rather than being
addressable-but-encrypted. The "every client needs the app installed and
joined" cost, which would be real friction for a wide/unknown client base, is
trivial here — one MacBook, maybe later a phone, both owned by the same
person who's setting this up.

**Pricing was verified, not assumed**, before proceeding — the owner was
explicit about not wanting a surprise bill. Checked directly against
`tailscale.com/pricing`: the Personal plan is free forever for non-commercial
use, unlimited devices, no data/bandwidth-based charges. The only paid
triggers (50+ tagged resources, 1,000+ ephemeral CI/CD minutes/month) are
enterprise-fleet features nothing in this setup touches.

## Decision

**Move the SSE endpoint onto Tailscale and close the public port.**

Concretely, done this session:
- Installed Tailscale on the VPS; joined the owner's tailnet as
  `gmail-mcp-vps`, private address `100.64.0.10`.
- Installed the Tailscale menu-bar app on the owner's MacBook
  (`brew install --cask tailscale`); joined the same tailnet, address
  `100.71.253.20`.
- VPS firewall (`ufw`): removed `allow 3000` from anywhere (v4 and v6),
  replaced with `allow 3000/tcp on tailscale0`. Port 22 (SSH) was
  deliberately left open to the public internet — this decision is scoped to
  the MCP endpoint, not VPS admin access generally.
- Updated the MCP client config (`~/.claude.json`) to
  `http://100.64.0.10:3000/sse`.

## What's Now Known

Verified for real, not just visually, per this project's standing
verification discipline:
- The old public URL (`203.0.113.10:3000`) times out — confirmed
  unreachable from the client machine after the firewall change.
- The Tailscale URL responds correctly — `401` with no token, same
  auth behavior as before.
- A real Gmail tool call (`search_emails`) round-tripped actual inbox data
  over the new connection after reconnecting the MCP client (`/mcp`) —
  confirming the whole path works end to end, not just that the port is open.

## Consequences

- **Closes `docs/tickets/002-http-not-https.md`.** The exposure it described
  — public reachability plus a cleartext token — no longer exists in either
  half: the server isn't publicly reachable, and traffic between joined
  devices is WireGuard-encrypted by Tailscale itself.
- **The endpoint still speaks plain HTTP, not HTTPS**, but this is no longer
  a gap: Tailscale's own tunnel encrypts everything between joined devices,
  so there's no cleartext hop left, unlike the pre-Tailscale setup where HTTP
  was the only layer.
- **SSH (port 22) is unchanged** and still publicly reachable. Out of scope
  for this decision; a separate concern from the MCP endpoint.
- **Any new client device needs Tailscale installed and joined before it can
  reach the server.** Accepted deliberately — the owner's real client set is
  one or two owned devices, not an open population, so this cost is small
  and the alternative (Caddy+domain) would have paid a domain purchase for
  public reachability nobody needs.
- **Reversing this** means re-opening `ufw allow 3000` publicly and pointing
  the client config back at the public IP — cheap, but should not be done
  without asking, same as any boundary decision in this repo.

## Pointers

- `docs/tickets/002-http-not-https.md` — the ticket this resolves; kept as
  historical record per `docs/tickets/README.md` convention.
- `docs/adr/001-initial-architecture.md` — "No HTTPS" original tradeoff, and
  "no network-level access control" confirmation this ADR responds to.
- `docs/adr/004-extend-allowlist-to-workspace-tools.md` — the send-side
  boundary that remains unaffected by a leaked token regardless of transport.
- VPS: `ufw status verbose`, `tailscale status` — current firewall and
  tailnet state.
- `~/.claude.json` (client machine) — `mcpServers.gmail-mcp.url`, now the
  Tailscale address.
- `CLAUDE.md` — Environment section, updated to match.
