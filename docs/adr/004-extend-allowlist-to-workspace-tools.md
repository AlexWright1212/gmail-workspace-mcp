# ADR 004 — Extend the Send-Allowlist Boundary to Drive Sharing and Calendar Invites

**Last edited:** 2026-09-19 (Amendment: `create_event`/`update_event` exposed, plan 002 Phase 4)
**Status:** Accepted
**Origin:** ad hoc

---

## Context

The hard rule this whole project is built around — "never reach anyone but the owner" — was, until this change, enforced only for the literal email-sending path (`send_message` / `send_draft`, gated by `assertSendAllowed()` inside `GmailAccountClient.deliver()`, the one choke point every Gmail send call goes through; see `src/allowlist.ts`).

But two other tools, disabled by `tools-enabled.json` but present in the compiled code, reach third parties exactly the same way an email does:

- `share_drive_file` grants a named email address access to a Drive file, and by default has Google email that person a notification with owner-supplied text.
- `create_event` / `update_event` invite a list of attendee email addresses to a Calendar event, and by default has Google email them.

Neither checked the allowlist at all. Their only protection was `tools-enabled.json` switching them off — the same file whose fail-open bug is fixed in `docs/adr/003-tools-enabled-fails-closed.md`. One config file protecting two independent properties (which tools exist, and who those tools can contact) is a single point of failure.

## Options Considered

**Rely solely on the ADR 003 fail-closed fix.** Simpler, no new code. Rejected — it leaves the "who can this reach" property entirely undefended for these tools; a future decision to enable `share_drive_file` or `create_event` (e.g. wanting Calendar support) would silently reintroduce an unrestricted send-adjacent capability unless someone remembered this gap.

**Wire the existing allowlist mechanism directly into these tools.** Defense in depth: even with the tool switched on, the recipient/attendee address is checked the same way an email recipient is.

**Delete the Drive/Sheets/Docs/Calendar code entirely, scope this server back to Gmail only.** The cleanest long-term answer if none of that functionality is ever wanted, but a much bigger and more disruptive change, and the git history (see ADR 003's context) shows real intentional investment in building it out. Not taken now; left as a live option if the owner later decides this server should be Gmail-only.

## Decision

**Wired the allowlist directly into `share_drive_file`, `create_event`, and `update_event`.** `update_event` was added to the scope beyond the two tools originally flagged, since it takes the identical `attendees: string[]` shape as `create_event` and has the identical bypass. Sheets and Docs tools were left untouched — they don't reach a third-party address at all, so there is nothing for an allowlist to check.

## Implementation

New `assertAddressAllowed()` in `src/allowlist.ts`, a sibling to the existing `assertSendAllowed()`:
- Same fail-closed config loading (`loadAllowlist()`), same audit log (`send-audit.log`), same `SendNotAllowedError` on rejection.
- Checks bare email addresses passed in directly, rather than parsing them out of raw MIME bytes — these tools never build a MIME message, so there's nothing to parse.
- `SendNotAllowedError`'s constructor gained an optional `workaround` parameter so the refusal message can say something tool-appropriate ("share it yourself directly in Google Drive", "add the attendee yourself directly in Google Calendar") instead of the send-specific "create a draft instead and send it manually from Gmail."

Call sites, each right before the underlying Google API call (mirroring `deliver()`'s "gate is the first statement" pattern):
- `GmailAccountClient.shareDriveFile()` (`src/gmail-client.ts`) — also now refuses `type: "anyone"` and `type: "domain"` outright, unconditionally, before the allowlist check even runs. Those grant access to a population rather than one address, so there's no single address for the allowlist to evaluate — silently checking nothing would be worse than refusing.
- `GmailAccountClient.createCalendarEvent()` and `updateCalendarEvent()` (`src/gmail-client.ts`) — every address in `attendees` is checked; any non-allowlisted address rejects the whole call before `calendar.events.insert`/`.patch` runs.

## Consequences

- Even if `tools-enabled.json` fails open again (or someone deliberately enables these tools later), `share_drive_file` / `create_event` / `update_event` can no longer reach a third party on their own — the recipient-boundary property no longer depends on a single config file.
- `docs/human-verification.md` does not yet cover these tools (they're disabled in production today) — if they're ever enabled, add live verification steps analogous to the existing allowlist section (§10).

## Pointers

- `src/allowlist.ts`: `assertAddressAllowed()`, `SendNotAllowedError` (extended).
- `src/gmail-client.ts`: `shareDriveFile()`, `createCalendarEvent()`, `updateCalendarEvent()`.
- `test/workspace-allowlist.test.mjs`: 9 tests — non-allowlisted email/attendee refused before any Google API call, allowlisted ones pass through, `type: "anyone"`/`"domain"` refused outright, no-attendee `create_event` needs no check.
- `test/workspace-write-drive-calendar.test.mjs`: the handler-level proof, added with the Amendment below.

## Amendment (2026-09-19, plan 002 Phase 4)

`create_event` and `update_event` are now exposed on `/workspace/mcp` (part
of its 35 tools) — the two tools this ADR wired the allowlist into in
advance of their ever being reachable by a client. The allowlist call
inside `GmailAccountClient.createCalendarEvent()` /
`updateCalendarEvent()` is **unchanged**; Phase 4 added no new gate and no
new bypass surface, by design (see the Phase 4 contract: "the allowlist
calls inside `GmailAccountClient.createCalendarEvent`/`updateCalendarEvent`
are ADR 004 and are NOT touched").

What changed is what now *proves* the gate holds:

- **Unit level:** `test/workspace-write-drive-calendar.test.mjs` drives the
  real `create_event`/`update_event` handlers against a real
  `GmailAccountClient` with a fake Calendar API object (`fakeCalendarApi()`)
  — a non-allowlisted attendee is refused before the fake Calendar client's
  `insert`/`update` method is ever called, and an allowlisted attendee
  passes through to it. This is the handler-level version of the
  client-level proof `test/workspace-allowlist.test.mjs` already gave.
- **Live level:** the write-phase harness (`tools/live/workspace-check.mjs`,
  see ADR 020) exercises the same boundary against real Google: an attendee
  outside the allowlist is refused before any event exists, on the Google
  Testing calendar only.

`share_drive_file` stays unexposed on every endpoint, unchanged from the
original decision above.

This ADR's original Consequences section said `docs/human-verification.md`
did not yet cover these tools because they were disabled in production.
That consequence is now **superseded**: the tools are live, and the
harness (not `docs/human-verification.md`) is what verifies the boundary
they carry — `docs/human-verification.md` remains scoped to the mail send
path (see `CLAUDE.md`).
