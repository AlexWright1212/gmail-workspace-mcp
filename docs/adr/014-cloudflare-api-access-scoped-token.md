# ADR 014 — Cloudflare API Access: Scoped, Extensible Token

**Last edited:** 2026-08-29
**Status:** Accepted
**Origin:** `docs/plans/001-remote-access-migration.md`

---

## Context

Building ADR 012's tunnel required Cloudflare API access — creating the
tunnel, configuring its ingress, creating the DNS record. Finishing the
zone-security hardening that ADR 012 identified as still needed (Browser
Integrity Check, Bot Management, rate limiting on future OAuth endpoints)
requires more of it, on an ongoing basis. This is the same shape of problem
ADR 010 already solved for SSH/VPS access: a real, repeated need for a
credential, without wanting to grant broad access just to satisfy it once.

## Options Considered

**One broad, all-permissions Cloudflare token, granted upfront.** Explicitly
offered by the owner ("im comfortable giving u much broader perms"). Declined
anyway. The owner's own standing instruction (`CLAUDE.md`: "prefer the
narrowest fix that removes the friction — a scoped carve-out over a blanket
loosening") governs this exact situation, and the SSH-key pattern that
instruction cites as the model works precisely *because* it's narrow — full
autonomy through a small grant, not a wide one. Taking the broader offer
would have contradicted the principle being applied to justify asking for
anything at all.

**A narrow, purpose-built token, extended only when a real need appears
(chosen).** First token (Phase 1 setup): `Account → Cloudflare Tunnel → Edit`
+ `Zone → DNS → Edit`, scoped to one zone and one account, nothing more —
sufficient for tunnel creation, ingress configuration, and the DNS record,
and confirmed by testing to be insufficient for anything else (a zone
settings call returned `403` with this token). Second token, requested only
once that specific blocked need was in front of the owner: added
`Zone → Zone Settings → Edit`, which is sufficient for Browser Integrity
Check but — also confirmed by testing, not assumed — still `403`s on the
Bot Management API and the Rulesets API (Configuration Rules, rate limiting).
A third, further grant is deferred until Phase 2 actually needs the
`/register` rate-limit rule, rather than requested speculatively now.

## Decision

`scripts/cloudflare-api.sh` — a thin, generic wrapper, deliberately mirroring
`scripts/vps.sh`'s shape (a named entry point that resolves credentials
automatically rather than a set of rigid subcommands). Credentials live at
`~/.config/gmail-mcp/cloudflare.env`, mode 600 in a mode 700 directory,
**outside this repo** — never committed, never included in `deploy.sh`'s
shipped file list, never placed on the VPS. Pre-approved in
`.claude/settings.json` the same way `vps.sh` and `deploy.sh` already are.

**No expiry was set on the token.** An expiring credential reintroduces
exactly the recurring interruption this setup exists to remove. It stays
revocable at any time from the Cloudflare dashboard — the same one-click
reach the SSH key already has via editing `authorized_keys`.

## What's Now Known

**The auto-mode classifier independently blocks a mutating Cloudflare call —
even one made through the pre-approved wrapper — when it reads as a
security-relevant change.** Confirmed live, 2026-08-28: a `PATCH` to disable
Browser Integrity Check was stopped by the classifier despite running through
`scripts/cloudflare-api.sh`, which is itself pre-approved in
`permissions.allow`. This is a **second, independent gate** on top of the
token's own permission scope — the script-level allow rule governs *whether
the command can run at all*; the classifier separately evaluates *what the
command does*, and can still pause on a specific action even when the tool
invocation itself is pre-approved. It worked as intended here: the change
was paused pending the owner's explicit confirmation (given via
`AskUserQuestion`), then made and verified. This mirrors the principle ADR
010 already established for a different mechanism (`autoMode.soft_deny`) —
flag a security-relevant action plainly and let the owner decide, rather than
either blocking it permanently or routing around the check.

## Consequences

- **A durable, reusable Cloudflare credential now exists**, matching the SSH
  key's shape: created once, used repeatedly, no further owner involvement
  required for anything the current scope covers.
- **Bot Management and Rulesets-API changes remain blocked** pending a
  further, specific grant — this is intentional deferral, not an oversight;
  see `docs/machine-setup.md` for the exact permission needed when Phase 2's
  rate-limit rule makes it necessary.
- **Two Cloudflare tokens were issued on 2026-08-28** (the original narrow
  one, then a zone-settings-extended one). The first is now fully superseded
  by the second's strictly larger scope and should be **revoked** from the
  Cloudflare dashboard — an unused-but-still-valid token is attack surface
  for no remaining benefit. Not yet done as of this writing; a one-click
  cleanup item.

## Pointers

- `scripts/cloudflare-api.sh` — the wrapper itself.
- `docs/machine-setup.md`, "The Cloudflare API token" — exact permission
  list, how to create or rotate the token, and how to verify it's wired up.
- `docs/adr/010-outbox-and-audit-log-permission-carve-out.md` — the SSH/VPS
  precedent this mirrors, including the classifier-vs-permission-rule
  distinction this ADR's "What's Now Known" section confirms generalizes to
  a second, unrelated credential class.
- `.claude/settings.json` — the `Bash(bash scripts/cloudflare-api.sh:*)`
  allow rule.
- `docs/adr/012-public-streamable-http-via-cloudflare-tunnel.md` — the work
  this credential was created to support.
