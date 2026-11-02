# ADR 001 — Initial Architecture

**Last edited:** 2026-07-27  
**Status:** Accepted
**Origin:** ad hoc

---

## What Was Asked For

A way for AI agents to access two Gmail accounts — a personal Gmail and a Texas A&M workspace account — from any AI client, not just one specific tool. The core requirements, ranked by importance:

1. **Portability** — a single URL any client can point at (Claude Code, OpenRouter, ChatGPT, etc.), not tied to one machine
2. **Multi-account** — both inboxes accessible through the same endpoint
3. **Draft-only, permanently** — creating drafts is fine; sending emails on the user's behalf would be "absolutely terrible" and needed to be made impossible, not just restricted
4. **Full read access** — search, threads, labels, the works
5. **Authentication** — the endpoint should be protected so random people can't read the emails

---

## Options Considered

### Google's Official Gmail MCP
Google released an official MCP server around this time. Rejected immediately: single account only, no multi-account support.

### Local stdio MCP (run on the user's machine)
Standard approach for most MCP servers — run locally, connect via stdio. Rejected because it breaks portability. The whole point is that any client on any machine can connect, not just the one where the server is installed.

### tszaks/gmail-multi-inbox-mcp on a VPS
Open-source TypeScript MCP server with native multi-account support. Deploy it on a small VPS, expose it over SSE. This matches all requirements with minimal custom code — multi-account is built in, SSE transport is built in, the VPS gives portability.

### Cloudflare Workers
Serverless, globally distributed, cheap. Rejected because OAuth token storage on Workers is non-trivial (no persistent filesystem), and getting multi-account auth working would have required substantially more custom code than just deploying tszaks.

---

## Decision

**tszaks/gmail-multi-inbox-mcp deployed on a DigitalOcean VPS.**

$6/month DigitalOcean droplet (1GB RAM, NYC1). Ubuntu 24.04, Node 24, pm2 for process management. The server runs permanently and restarts automatically on boot.

---

## Security Decisions

### Hard-deleting send capabilities
The user was explicit: sending email on their behalf would be catastrophic. We didn't just disable `send_email` and `send_draft` — we deleted the tool definitions and case handlers from the TypeScript source entirely. They are not in the compiled output. There is no code path that can send email, regardless of what any client asks for.

This is stronger than an allowlist (which could be misconfigured) or a permission check (which could be bypassed). The capability simply doesn't exist in the deployed binary.

### Bearer token authentication
The SSE endpoint sits on a public IP with no network-level access control. Without auth, anyone who discovers the URL can read the emails. We added Express middleware that checks for `Authorization: Bearer <token>` on all `/sse` requests — anything else gets a 401.

The token is stored in `.env` on the server and read by `ecosystem.config.cjs` at startup. It is not committed to the git repo.

### Tool allowlist (tools-enabled.json)
The underlying library includes Drive, Sheets, Docs, and Calendar tools. The user didn't want these exposed. Rather than deleting them from source (which would make updates harder), we added a `tools-enabled.json` allowlist that filters both the `tools/list` response and blocks execution of any tool not in the list. This lets us toggle tools on/off without touching code.

### OAuth scopes
During the OAuth setup, we only authorized `https://mail.google.com/` and `userinfo.email`. No send scope was ever granted to the OAuth app. This is a second layer of defense — even if some code path for sending were somehow reachable, the OAuth token wouldn't have the scope to do it.

### OAuth app published to production
The GCP OAuth app was initially in "Testing" mode, which causes tokens to expire every 7 days. Published to production to eliminate this maintenance burden.

---

## Implementation Notes

**VPS RAM constraint:** The TypeScript compiler (`tsc`) exhausts Node's default heap limit on a 1GB machine. Build command requires `NODE_OPTIONS="--max-old-space-size=1536" npm run build`. This is documented in the README's "Making Changes" section.

**Token expiry:** Initial concern that tamu.edu (a Google Workspace account) might block third-party OAuth. Tested during setup — it worked without issues. No admin policy enforcement encountered.

**SSH automation key:** A separate passwordless SSH key (`~/.ssh/mcp_deploy_key`) was generated for AI agent access to the server. This avoids sharing the user's personal SSH key while still allowing Claude Code to SSH in and run commands.

**Ecosystem config pattern:** `ecosystem.config.cjs` reads `.env` at startup using Node's built-in `fs` module (no dotenv dependency). The bearer token flows: `.env` → `ecosystem.config.cjs` → pm2 process environment → Express middleware.

---

## What This Doesn't Do

- No write access beyond drafts (by design)
- No Drive/Sheets/Docs/Calendar (blocked by allowlist)
- No HTTPS — traffic is unencrypted HTTP. Acceptable for personal use on a home network or VPN; not suitable if the endpoint were ever made public beyond personal use
- No per-client access control — the single bearer token grants full access to both inboxes. If multiple people needed access with different permissions, a more sophisticated auth layer would be needed
