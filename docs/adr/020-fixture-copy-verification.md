# ADR 020 — Verification on fixture copies, read back independently

**Last edited:** 2026-09-19
**Status:** Accepted
**Origin:** `docs/plans/002-google-workspace-endpoint.md`, Phases 3–4

---

## Context

This project's whole reason for existing is a bug that passed visual
inspection (`CLAUDE.md`, "The bug this project exists to fix") — a draft
that looked correct in Gmail's compose UI and arrived broken. Workspace
writes reopen the same class of risk in a new shape: a tool can report
success while having changed the wrong tab, the wrong row, or nothing at
all, and the only way to know is to ask Google again, independently of
what the tool said. Plan 002 adds a second constraint on top of that
standing rule: **no check ever touches the owner's real tracker, real
documents, or primary calendar** — a live Sheets/Docs/Calendar surface
means a naive test-against-production approach would edit things the owner
actually uses.

## Options considered

**Check against the owner's real templates directly**, restoring them
afterwards. Rejected: a run that fails partway — a crash, a killed
process, a bug in the restore step itself — leaves the owner's actual
tracker or document modified, which is the one outcome every other
decision in this plan exists to prevent.

**Mock Google entirely for this layer**, as `npm test` already does with a
fake client. Rejected for the live layer specifically: mocking is exactly
what the unit suite is for, and it cannot observe what Google's real API
actually does with a request — the layer this harness exists to add is
the one unit tests structurally cannot cover.

## Decision

`tools/live/workspace-check.mjs` runs on the VPS, through the deployed
client class (`GmailAccountClient.create` + `rawApis()`) — never by
opening a token file directly; the permission classifier refuses a
script that reads `tokenPath` on principle, and the client path is what a
real MCP request takes anyway, so a script that bypassed it would be
proving something other than what ships.

For each account it copies the two templates (`tools/live/fixtures.json`:
Internship Copy, Musings Copy) inside the shared Google Testing folder as
`zz-test-<ISO run id>-<account>-<name>`, using that account's own
credentials — a run from `tamu` therefore also proves `tamu` can create
inside the shared folder, not just read it. Every check calls a **tool
handler** from `dist/tools/*.js` — the same code path an MCP call runs,
not a hand-rolled equivalent — and every assertion is paired with an
independent `rawApis()` read-back: the tool's own printed text
(`updatedCells`, an "occurrences changed" count) is used only as an
optional soft cross-check against a field name the tool's contract
guarantees, never as the pass/fail signal by itself. Copies are trashed on
success; a failure keeps them and prints their ids, so the exact bytes
that resulted from a real edit can be inspected rather than re-derived.
`--keep` always keeps everything, for the two checks that can only be
judged by eye (a formatted header row, a chart's placement). `--sweep`
trashes `zz-test-*` leftovers — Drive files, testing-calendar events, and
outbox files — independent of any run.

Calendar writes go only to the secondary "Google Testing" calendar
(`tools/live/fixtures.json`, created with `calendarList.selected: false`
so it never appears on the owner's main view); the primary calendar's
event count in a fixed window is asserted unchanged before and after every
write-phase run, not just left alone by convention.

## What's now known

- `drive.files.copy` of a spreadsheet **preserves data-validation rules** —
  confirmed live (2026-09-19), so the dropdown checks on a copy are
  meaningful. This was listed under "Still only a guess" in the plan until
  the harness ran; it was not assumed true and shipped.
- `delete_event`'s read-back returns the event with `status: "cancelled"`
  rather than a 404 — the harness treats a 404/410 as an acceptable
  alternate "gone" outcome, but on this API it is `cancelled` that actually
  comes back.
- `values.append` aligns appended values to the table's **first header
  column**, not column A — on the owner's tracker that's column B. A tool
  that assumed column A would silently misalign every appended row; the
  tool description now states this explicitly (commit `028fc81`).
- Drive's `files.list` by name lags for a just-created file, and the same
  `zz-test-*` name used by both accounts in the same run can collide in a
  list query. The harness (and any write tool that needs to locate what it
  just created) uses the id the tool itself printed, then reads that id
  back with `files.get`, rather than searching by name.
- Google truncates event times to whole seconds — a harness comparison
  against a sub-second timestamp it sent would fail on a technicality
  unrelated to correctness; the harness compares at second precision.
- The first full write-phase run (2026-09-19, before the harness/tool
  fixes in commit `028fc81`) was 87 passed / 9 failed, and every failure
  traced to one of the two classes above — a harness assumption that
  didn't hold, or `insert_sheet_dimension`/`delete_sheet_dimension`
  refusing a numeric `before`/`start` a model had passed as a number
  rather than a string. The run of 2026-09-19 after the harness fixes is
  recorded in the plan's Phase 4 section.

## Consequences

- A harness failure always leaves evidence (kept copies, printed ids)
  rather than a bare "FAIL" — the standing verification discipline applied
  to this layer specifically.
- The harness is the only thing that has ever exercised
  `drive.files.copy`'s validation-preservation behavior, the `cancelled`
  status on delete, and the append-alignment column against real Google
  state; nothing about those facts could have been learned by reading the
  API documentation or passing the unit suite.
- Every new Workspace write tool inherits this contract: it is not
  considered verified until the harness both calls it and reads Google
  back independently, on a copy, never on the owner's real objects.
- **The agent-level layer sits on top, not instead (plan 002 Phase 5,
  2026-09-19).** The harness proves a tool works when called correctly; a
  subagent driving the deployed endpoint through a real client, with every
  competing connector disabled and no hint beyond names, descriptions and
  instructions, proves an agent *finds* it. The reviewer never scores from
  the agent's word: `tools/live/phase5-readback.mjs` dumps a copy's sheet,
  doc, folder, calendar and outbox state through `rawApis()` before and
  after, and the server's `request-log.log` (`tools/call:<name>` per line)
  is diffed against the agent's self-reported call sequence. The first run
  found five defects the harness could not see, all in wording, defaults
  and discoverability -- exactly the class this layer exists for -- and two
  defects in the task list itself.

## Pointers

- `tools/live/workspace-check.mjs` — header comment states the contract in full; `sweep()`, `setupPdf`/`teardownPdf`, `driveWriteChecks`, `sheetsWriteChecks`, `docsWriteChecks`, `calendarWriteChecks`, `teardownWriteCopies`.
- `tools/live/fixtures.json` — folder, template, and testing-calendar ids (not secrets; useless without a token).
- `tools/live/phase5-readback.mjs` — the agent-level layer's independent read-back; `docs/workspace-verification.md` — the task lists it scores.
- `src/gmail-client.ts` — `rawApis()`, the only sanctioned way a verification script reaches Google.
- `docs/plans/002-google-workspace-endpoint.md`, "Non-negotiables" ("no check ever touches the owner's real tracker...") and the Phase 4 contract's harness section.
- `CLAUDE.md`, "Verification discipline" — the standing rule this ADR applies to Workspace writes.
