# ADR 002 — Remove `unsubscribe_from_email` Instead of Hardening It

**Last edited:** 2026-08-18
**Status:** Accepted
**Origin:** ad hoc

---

## Context

An adversarial review found a HIGH-severity blind SSRF in `unsubscribe_from_email`. The tool read the `List-Unsubscribe` / `List-Unsubscribe-Post` headers of an incoming message and, when they claimed RFC 8058 one-click support, automatically POSTed to whatever URL was in the header — no confirmation, mirroring what Gmail's own "Unsubscribe" button does.

The problem: both headers are written by the sender of the incoming email, i.e. by whoever the server is being asked to unsubscribe from. The only validation was `startsWith('http://')` (later `https://` too) — nothing checked *where* the URL pointed. An attacker could email the owner with `List-Unsubscribe: <http://169.254.169.254/...>` and the server would fetch it, using its own network position to reach an address the attacker could never reach directly (cloud metadata endpoints being the canonical example).

## Options Considered

**Harden the auto-fetch.** Require `https://` only, resolve the hostname and reject anything that resolves to a private/link-local range, disable automatic redirect following, add a timeout. Correct in principle, but real security engineering with real edge cases (DNS rebinding between the resolve-check and the fetch being the classic one) — a lot of code to get exactly right for a personal tool.

**Make it report-only.** Keep finding and parsing the unsubscribe info, but never fetch anything server-side — surface the link and let the owner click it themselves, in a real browser, where they can see where it actually goes. Eliminates the SSRF path entirely with almost no code, at the cost of losing true one-click convenience.

**Remove the tool entirely.** No unsubscribe support of any kind. Simplest possible fix.

## Decision

**Removed the tool entirely**, per explicit owner choice (offered the report-only option as the recommended middle ground; owner chose outright removal instead).

## Consequences

- `docs/specs/001-email-tool.md` originally listed "unsubscribe from mailing lists" as in-scope. **Superseded 2026-08-17:** the owner confirmed the removal and the spec was edited to match — unsubscribing now sits under "Explicitly out of scope" with the SSRF reasoning. The spec and the implementation agree; there is no longer a gap to revisit. Restoring some safe form of unsubscribe later (report-only, never auto-POST) would require a spec change first.
- Code removed: the `unsubscribe_from_email` tool schema and dispatch case, `handleUnsubscribeFromEmail` (`src/index.ts`), and its two supporting parsers `parseListUnsubscribeHeader` / `parseMailto` plus the `MailtoParse` type (`src/gmail-client.ts`). `getMessageHeaders` (`src/gmail-client.ts`) was also removed — it existed solely to serve this handler and had no other caller.
- `tools-enabled.json` no longer lists `unsubscribe_from_email`.
- Tests removed: the "P3: List-Unsubscribe is attacker-controlled input" block (6 tests) in `test/organize.test.mjs`, and "the unsubscribe mailto branch contains no send at all" in `test/send.test.mjs`.
- Net effect on the server's outbound network behavior: it now **never** makes an HTTP request whose target originates from the content of an incoming email. That property is now true by construction, not by validation.

## Related

See `docs/adr/004-extend-allowlist-to-workspace-tools.md` for the same underlying question — "should the server automatically act on an address/URL chosen by someone other than the owner?" — resolved differently there (allowlist-gate rather than remove) because Drive/Calendar tools take input from the *caller*, not from untrusted incoming mail.
