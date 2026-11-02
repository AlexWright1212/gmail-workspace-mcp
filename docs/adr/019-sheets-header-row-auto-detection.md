# ADR 019 — Header-row auto-detection for Sheets records

**Last edited:** 2026-09-19
**Status:** Accepted
**Origin:** `docs/plans/002-google-workspace-endpoint.md`, Phase 3; reused by `update_sheet_row` in Phase 4

---

## Context

`read_sheet_records` turns a raw grid into header-keyed rows, and
`find_sheet_rows` locates a row by a column's value — both need to know
which row holds the headers. The obvious default, "row 1", failed the
single most common flow ("find the row for Company X") on the very first
harness run: the owner's actual internship tracker has a title on row 2, a
totals block on rows 4–5, and its real header on row 7.

## Options considered

**Require `header_row` always**, with no default. Rejected: the model
doesn't know the sheet's layout before it has read it — the first call in
any flow would have to guess, and guessing wrong on the first call is
exactly the failure mode this exists to prevent.

**"First non-empty row."** Rejected against the same tracker: row 2 (the
title) is non-empty and would be picked over row 7.

## Decision

`detectHeaderRow()` in `src/sheets/records.ts` scans the first 20 rows and
picks the one with the most non-empty cells, ties going to the earliest
row. The reasoning: a header names every column, so it is at least as wide
as any data row beneath it, while a title or totals block above it is
narrower. `header_row` remains an explicit override, and every read names
which row it used, so a wrong guess is visible rather than silent.

The same function, with the same parameters, is called by
`read_sheet_records`, `find_sheet_rows`, **and** `update_sheet_row` (Phase
4) — a read and the write that follows it therefore cannot disagree about
which row is the header, because there is exactly one place that decision
gets made. `update_sheet_row` refuses before writing anything if the
target row is at or above the detected (or given) header row, or if a
requested column name doesn't match any header — both refusals list the
real headers so the model can correct itself in one step.

## What's now known

Still a heuristic, not a guarantee: a data row wider than its header would
win the scan, and nothing detects that case today. The live harness proves
it holds on the owner's real tracker on every run (the copy still detects
row 7), but Phase 5's transcripts against other real documents are what
will show whether the rule generalizes or needs a second signal (e.g.
preferring a row whose cells look like labels over one that looks like
data).

## Consequences

- A sheet whose header genuinely is its widest row in the first 20 needs no
  argument from the model at all — the common case costs nothing.
- A sheet that defeats the heuristic (a data row wider than the header, or
  a header past row 20) requires the model to pass `header_row` explicitly;
  the tool's response names the row it used, which is the signal that
  something needs correcting.
- Because `update_sheet_row` reuses the exact function `read_sheet_records`
  used, a sequence like "read the tracker, then update the row you found"
  cannot land a write against a different header row than the read that
  produced the row number, even if the sheet's layout is unusual.

## Pointers

- `src/sheets/records.ts` — `detectHeaderRow`, `buildHeaders`, `buildRecords`, `resolveColumn`, `findRows`.
- `src/sheets/writes.ts` — `updateRow`, which calls `detectHeaderRow`/`buildHeaders`/`resolveColumn` exactly as `find_sheet_rows` does before writing a single cell.
- `docs/specs/002-google-workspace-server.md`, "Sheets".
- `docs/plans/002-google-workspace-endpoint.md`, "Phase 3 — what actually happened" and "Still only a guess".
