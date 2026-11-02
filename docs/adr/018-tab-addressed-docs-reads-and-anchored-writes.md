# ADR 018 — Tab-addressed Docs reads, anchored Docs writes, no Markdown-to-Doc writer

**Last edited:** 2026-09-19
**Status:** Accepted
**Origin:** `docs/plans/002-google-workspace-endpoint.md`, Phases 3 and 4

---

## Context

The inherited Docs tools were broken for real use in two independent ways,
both observed directly, not assumed:

- **First-tab blindness.** `getDocument()` called `documents.get` without
  `includeTabsContent`, so Google silently returned only the first tab —
  nothing in the response says other tabs exist. `handleDocsGet` then cut
  the result at 2,000 characters with no way to page further. The same
  defect is open in the most popular community Workspace MCP server
  (`taylorwilsdon/google_workspace_mcp`, issues #113, #1086, #1108) — not a
  one-off bug, a known trap in this API shape.
- **Index-based writes.** `docs_apply_style` and the old `docs_insert_table`
  took character offsets from the caller. Docs indices are UTF-16 units per
  segment and shift after every edit; a position handed to the model in one
  call is stale by the next.

Both are one design problem: a Doc is not a flat document, it is a tree of
tabs, and an edit position is only valid at the instant it's computed.

## Options considered

**Port `a-bonus/google-docs-mcp`'s `markdownToDocs.ts` (33KB) wholesale** —
let the model author a document by writing Markdown and having the server
convert and apply it. Rejected: spec 002 excludes wholesale document
authoring by design ("Reading produces Markdown; writing is small, targeted
edits"); the owner's stated need is read-and-small-edit, not author.

**Let the model pass character indices directly**, as the inherited tools
did. Rejected outright — this is the exact defect being fixed, and
CLAUDE.md now states the rule as a project invariant: no Docs tool ever
takes or returns a character index.

**Address tabs by title instead of `tabId`.** Rejected: titles are not
unique (two tabs can share a name) and can change between a read and a
later write; `tabId` is stable and exactly what Google's own API uses to
scope a request.

## Decision

**Reads** (`src/docs/tabs.ts`, `renderDocument`): every read calls
`documents.get` with `includeTabsContent: true` and walks `tabs[]` and
`childTabs[]` recursively (depth-first, document order), rendering each tab
from its own `documentTab.body` — never from the legacy top-level
`document.body`. Each tab is labelled with its title and `tab_id`. Above
`DEFAULT_INDEX_THRESHOLD` (60,000 characters, a starting guess — "Still
only a guess" in the plan, revisit after Phase 5) a whole-document read
returns the tab index (title, id, depth, character count) instead of text,
and `tab_id` then reads one tab; nothing is ever silently truncated.

**Writes** (`src/docs/writes.ts`, `src/docs/anchors.ts`) share the same tab
addressing. The tab rule, identical across every write tool
(`resolveTargetTab`): `tab_id` given and valid → that tab; given and
unknown → refused, naming the tab index, nothing written; omitted on a
one-tab document → that tab, unchanged behavior; omitted on a multi-tab
document → refused with the tab index, nothing written. Every
`batchUpdate` request carries `tabId` on every location/range it sends, and
`writeControl.requiredRevisionId` taken from the same `documents.get` the
positions were computed from — a concurrent edit is rejected by Google
rather than landing in the wrong place, and a `documents.get` that returns
no `revisionId` refuses the write outright rather than proceeding unpinned.

**Anchors** — a heading matched by trimmed, case-insensitive text, or a
unique passage of body text — are resolved fresh at call time by
`src/docs/anchors.ts`, ported from `a-bonus/google-docs-mcp`'s
`findElements` (MIT). A match is built from *contiguous* text runs per
paragraph (a run whose `startIndex` isn't the previous run's last index + 1,
or a non-text element such as an inline image, ends the unit), recursing
into table cells and nested tables. Zero or more than one match refuses the
call, listing every candidate up to `MAX_LISTED_CANDIDATES` (10, with a
"… and N more" tail) — never applied to a guess. Anchors and `find` strings
may not contain a line break (`assertSingleLine`): a paragraph's trailing
newline is part of its text in the Docs API, so a query containing one
could match across a paragraph boundary and a replace could merge two
paragraphs.

`insert_doc_text`'s `before`/`after` paths always follow the insertion with
an explicit `updateParagraphStyle: NORMAL_TEXT` + `deleteParagraphBullets`
over the inserted range, because Docs copies the neighbouring paragraph's
style onto newly inserted text — without the reset, text inserted after a
bulleted or heading paragraph inherits that formatting unasked.
`append_doc_text` does the same, forced to whatever `style` it was given
(default `NORMAL_TEXT`) rather than whatever the previously-last paragraph
happened to be.

**`docs_insert_table` and `docs_apply_style` were deleted, not
replaced.** Both were index-based with no anchor-based equivalent that
preserves their exact behavior; re-adding either capability later means
designing it against the anchor model from scratch, not restoring the old
code.

## What's now known

Live harness (2026-09-19, both accounts, on a copy of the owner's six-tab
document):

- `append_doc_text` lands as its own last paragraph, and every other tab is
  byte-identical before and after.
- `replace_doc_text` scoped by `tabsCriteria` leaves the same phrase in
  another tab untouched.
- A heading-anchored `insert_doc_text` lands directly under the heading as
  plain (non-bulleted, non-heading) text.
- The ambiguous-anchor, no-tab-given, and unknown-tab-id refusals all leave
  the document unchanged — none of them partially applies before refusing.

Adversarial review (a separate agent, before deploy) confirmed every
`batchUpdate` request built by `src/docs/writes.ts` carries `tabId`, and
checked the index arithmetic against Google's documented model: the body
starts at index 1, a structural element's `endIndex` is one past its
trailing newline, the segment's final newline can never be deleted, and
indices are UTF-16 code units — `bodyEndIndex()` and the heading
before/after/replace arithmetic in `src/docs/writes.ts` were checked
against all of that, not just against a passing test.

## Consequences

- A single-tab document behaves exactly as before Phase 3/4 — the tab rule
  never asks for `tab_id` when there's only one place an edit could go.
- Every edit tool re-fetches the document after writing and reports the
  paragraph Google now holds, never the request echoed — the same
  "report what the response says, not what was asked" discipline as the
  Sheets writes (ADR 019's sibling decision, `docs/plans/002...`, Phase 4
  contract).
- The 60,000-character index threshold is unverified beyond unit coverage —
  the fixture document (Musings Copy) is roughly a fifth of that size, so
  the index path has never been exercised live. Phase 5's transcripts are
  the first real test of where it should sit.
- No Markdown-to-Doc writer exists or is planned under this decision;
  wholesale authoring stays a deliberately unbuilt capability, not a
  deferred one — building it later is a new decision, not a resumption of
  this one.

## Pointers

- `src/docs/tabs.ts` — `flattenTabs`, `renderDocument`, `formatTabIndex`, `DEFAULT_INDEX_THRESHOLD`.
- `src/docs/anchors.ts` — `findHeadings`, `findText`, `listHeadings`, `bodyEndIndex`, `MAX_LISTED_CANDIDATES` (in `src/docs/writes.ts`).
- `src/docs/writes.ts` — `resolveTargetTab` (the tab rule), `appendDocText`, `replaceDocText`, `insertDocText`, `assertSingleLine`.
- `src/tools/docs.ts` — tool definitions and handlers; `formatDocumentRead` (shared with `read_drive_file`'s Google Doc path).
- `docs/specs/002-google-workspace-server.md`, "Docs" and "Known Symptoms To Avoid".
- `docs/plans/002-google-workspace-endpoint.md`, "Phase 3 — what actually happened" and the Phase 4 contract's Docs table.
