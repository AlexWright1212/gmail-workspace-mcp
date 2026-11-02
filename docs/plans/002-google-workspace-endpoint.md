# Plan 002 — Google Workspace endpoint: two endpoints on one server

**Spec:** `docs/specs/002-google-workspace-server.md` (supersedes spec 001)
**Status:** **Complete — all seven phases done 2026-09-20.** Phase 6 (closeout): the legacy scope alias is gone (stored tokens rewritten in place by `clients.sh migrate-scopes`, nobody re-consented), three dead duplicate registrations revoked, docs reconciled. See "Phase 6 — what actually happened". Phase 5: every read and write task passed agent-level in Claude Code (Sonnet 5 subagents) and Codex (owner-typed, 33 logged calls, every write read back); Cursor and claude.ai/phone each connected to `/workspace/mcp` and completed a search + spreadsheet read; five real findings plus the owner's all-calendars decision fixed and deployed (`8baf670`, `eee4a38`, `204224a`, `ebebd0e`), 500/500 tests.
**Opened:** 2026-09-19 · **Owner decisions recorded:** 2026-09-17 – 2026-09-19

A multi-phase build, run across sessions. This file is the context transfer
between them: what was decided, why, what phase we are in, and what is still
only a guess. Update the status line and the phase table as work lands.

## Start here if you're a new session picking this up

**Read, in order:** `CLAUDE.md` (project invariants — always), the spec
(`docs/specs/002-google-workspace-server.md`, every acceptance criterion in it
is a test this plan must produce), this document in full, then the ADRs for
what you are about to touch — `docs/adr/003` and `004` before anything near
`tools-enabled.json` or a tool that can reach a third party, `docs/adr/013`
before anything in `src/http/oauth/`, `docs/adr/011` before touching the
server instructions or anything account-health-shaped.

**The working pattern from plan 001, use it again:** one resident session
drives one background subagent per coherent unit of work, with a brief that
cites exact file paths, the facts this document already knows, the fences
(files it must not touch), and what "done" means. Verification is a separate
subagent from implementation. Nothing is "done" until it has been read back
from the running system — for this plan that means read back from Google.

**Do not re-run the research.** The landscape survey, the per-client tool
limit research, the Docs and Sheets API facts, and the code-level assessment
of the inherited Workspace tools were all done 2026-09-17/19 and are
summarized in "What we learned before writing this" below. Re-deriving them
costs a session.

## The goal

Turn the Gmail server into two separately-connected MCP endpoints on the same
hostname, process and login: **Mail** at `https://mcp.example.com/mcp`,
unchanged, and **Google Workspace** at `https://mcp.example.com/workspace/mcp`,
covering Drive, Docs across all tabs, Sheets and Calendar over both accounts —
so an agent can find the internship tracker, read a tab, find a row, change a
status, append an opportunity, add a tab, cross-reference a contacts sheet,
read a whole multi-tab Doc and make small edits to it, all verified against
real Google state by an unattended harness.

## What we learned before writing this (2026-09-17/19)

Facts, verified unless marked. Everything here was checked against code, the
live VPS, GitHub, or official documentation.

- **Upstream is dead-ended.** Tyler Szakacs's `tszaks/ghub` last commit
  (2026-06-27) is the one we forked from. Its Drive/Sheets/Docs/Calendar
  tools were added in one commit (`2d52bdb`) to a four-star project and never
  documented. There is nothing newer to pull.
- **All 62 tool handlers are built, compiled and deployed; 23 are exposed.**
  The Workspace handlers use the same account resolver as mail
  (`resolveWriteAccount` / `resolveReadAccounts` in `src/accounts.ts`), and
  `GmailAccountClient` already constructs Drive, Sheets, Docs and Calendar API
  handles from the same token (`src/gmail-client.ts:1082-1087`). Drive search
  already merges both accounts. Multi-account fit is complete.
- **The inherited Docs tools are broken for real use.** `getDocument()` calls
  `documents.get` without `includeTabsContent`, so Google returns only the
  first tab and nothing says other tabs exist; `handleDocsGet` then truncates
  at 2,000 characters with no way to page. Append computes its insertion point
  from that first-tab body. Edits are index-based (`docs_apply_style` takes
  character offsets from the agent). All of this is listed in the spec's
  "Known Symptoms To Avoid".
- **The inherited Sheets tools are sound but thin.** Real `values.get` /
  `values.update` / `values.append` with render and input options, tab CRUD,
  dimension insert/delete, formatting, charts. Missing: header-keyed reads, a
  find-rows-by-column-value tool that returns row numbers, reading a cell's
  data-validation rule, and row numbers in read output. Reads print
  tab-separated rows with no row index.
- **Live account tokens on the VPS hold Gmail scopes only** (read directly
  from both `token.json` files: `mail.google.com`, `gmail.settings.basic`,
  `userinfo.email`, `openid`). `tools/reauth.mjs` requests exactly that set on
  purpose. The wider constant `GOOGLE_ACCOUNT_SCOPES` (`src/gmail-client.ts:32`)
  already lists Drive, Sheets, Docs and Calendar. Enabling Workspace needs a
  fresh consent per account with those scopes. Whether the Drive/Sheets/Docs/
  Calendar APIs are enabled in GCP project `email-503620` is **unknown** — no
  document records it, and the code carries a dedicated error message for the
  disabled case (`describeDriveApiError`), which suggests upstream hit it.
- **Our own OAuth server binds every token to one resource URL**
  (`GmailOAuthProvider.verifyAccessToken`, `record.resource !== this.resourceUrl.href`
  → reject). This is ADR 013's confused-deputy defense and must survive. A
  second endpoint is a second RFC 8707 resource, not a config switch.
- ~~**The tool list is inline code.**~~ **Superseded by Phase 1 (2026-09-19).**
  It was one array of 58 schemas (not 59 as first counted) and 61 `handleX`
  methods inside `GmailMultiInboxServer`, filtered by a global set from
  `tools-enabled.json`. Now: `src/tools/<service>.ts` modules unioned by
  `src/tools/registry.ts` (62 tools), exposed per endpoint by `endpoints.json`,
  served by `src/mcp-server.ts`. Four handlers had no schema at all
  (`get_attachment`, `get_all_attachments`, `begin_account_auth`,
  `finish_account_auth`); Phase 1 authored minimal ones from their argument
  handling so the registry could require a definition per handler. They are
  listed on no endpoint. The list handler still ignores the caller — every
  client of an endpoint sees that endpoint's whole list.
- **Server instructions are 1,719 bytes of a 2,048-byte cap.** Claude Code
  truncates per-server instructions and tool descriptions at 2KB; confirmed
  as real behavior by an Anthropic engineer reproducing anthropics/claude-code
  issue #43474, quoted verbatim in #76372, and a request to defer instead of
  truncate (#83702) was closed "not planned" 2026-09-16. Undocumented in the
  public docs. Per-endpoint instructions is the structural fix.
- **Per-client tool exposure differs and drives the two-endpoint decision.**
  Claude Code: names only at start, descriptions fetched on demand (observed
  directly in the 2026-09-17 session), no practical cap. Cursor: full schemas
  loaded, ~40 tools across *all* servers combined, silently drops the rest
  (reported consistently on Cursor's forum since 2025, absent from Cursor's
  docs — never officially documented). claude.ai, Codex, ChatGPT: no
  documented cap; Codex guidance says put anything critical in a tool
  description's first 512 characters.
- **Nobody bundles.** GitHub, Notion, Atlassian, Anthropic's own Drive (11
  tools) and Calendar (9) connectors, and Google's official Workspace MCP
  endpoints all ship one tool per operation. Anthropic's tool-search eval:
  50+ resident tools drops Opus 4 accuracy 74%→49%; the answer vendors reach
  for is deferral or toolsets, never an `operation` enum. Spec 002 forbids
  bundling.
- **Google now hosts official per-product MCP endpoints** (`gmailmcp`,
  `drivemcp`, `docsmcp`, `sheetsmcp`, `calendarmcp`, … `.googleapis.com/mcp/v1`)
  in a Developer Preview; verified on developers.google.com. Reported, not
  verified: the Gmail one cannot send and none handles multiple accounts.
  Lowers the ceiling on how much to build here; does not change what to build.
- **What is worth porting** (all MIT/Apache-2.0, files confirmed to exist
  2026-09-17 via the GitHub API):
  - `a-bonus/google-docs-mcp` (TypeScript, MIT, 662★):
    `src/markdown-transformer/docsToMarkdown.ts` (8.5KB, walks
    StructuralElements → Markdown with headings/lists/links/bold/italic/tables),
    `src/tools/docs/findElement.ts` and `findAndReplace.ts` (2.5KB each,
    text-anchored, `tabId`-scoped), plus their `*.test.ts` cases. **Do not port**
    `markdownToDocs.ts` (33KB) — the spec excludes wholesale Markdown authoring.
  - `aaronsb/google-workspace-mcp` (TypeScript, Apache-2.0):
    `docs/architecture/api/ADR-306-tab-addressed-docs-reads-and-writes.md` —
    the design rule, not code: every Docs read and write carries a `tabId`; a
    read never falls back to the legacy first-tab body; large multi-tab docs
    return a tab index instead of concatenated text.
  - Sheets designs to copy (not code — Go and Python): `mab-go/sheets-mcp`'s
    `sheets_lookup` (match modes, `return_columns`, row number in result) and
    `niberdi01gold/sheets-mcp`'s `find_rows` (column addressed by header name).
  - `taylorwilsdon/google_workspace_mcp` (Python, 3,181★) is the breadth
    reference and has **open bugs in exactly the tabs area** (issues #113,
    #1086, #1108) — a checklist of what not to repeat, not a source.
- **Official API facts the code must respect:** `documents.get` returns
  `document.tabs` only with `includeTabsContent=true`, and then the legacy
  `document.body` is empty; child tabs nest under `tab.childTabs`
  recursively; `batchUpdate` `Location`/`Range`/`EndOfSegmentLocation` take
  `tabId`, and omitting it targets the first tab silently; indices are UTF-16
  units per segment and shift after every edit, so batches must be ordered
  highest-index-first; the final newline of a body cannot be deleted; table
  rows need their own delete request. Sheets: `values.append` finds the
  "table" in the given range itself (pass `Tab!A:Z`, never compute the row
  count); `USER_ENTERED` is the right default; tab names with spaces or
  punctuation are single-quoted in A1 notation; a cell's validation rule is
  readable via `spreadsheets.get` with a `fields` mask containing
  `dataValidation`; quotas are 60 reads and 60 writes per minute per user —
  irrelevant unless something loops per cell.

## Decisions already made by the owner

| Question | Decision | Rejected |
|---|---|---|
| One server or two | **Two endpoints, one codebase, one process, one deploy, one login.** Clients register with each separately. | A forked second server (doubles deploys, audit logs, OAuth stores; the file-based OAuth store assumes one writer). A second subdomain (second issuer; re-registers every mail client). |
| Endpoint names and addresses | Mail stays at `/mcp`. Workspace at `/workspace/mcp`, presented to clients as **"Google Workspace"** — the word Google in the name, "Workspace" alone judged too vague. | |
| Tool shape | **Granular, one tool per operation, 2–4 word `verb_noun` names, each endpoint under 40 tools.** | Bundled `operation`-enum tools (no vendor precedent; hides capability behind a generic name in clients that show names first). Scope-filtered tool lists as the *only* mechanism (clients cannot choose scopes in their UI; they can choose URLs). |
| Scopes | **Two, `read` and `write`, same on both endpoints.** `read` forbids every mutation including creating a draft/doc/tab/event. No scope requested → both. Old `mail:read`/`mail:write` retired; every existing client re-consents once. | Keeping mail-specific names. |
| Primary clients and verification bar | **Claude Code and Codex run every key check. Cursor: connect and one call per endpoint.** claude.ai/phone expected to work as for mail. | |
| Drive writes | Create folder, rename, move, trash, **upload from the VPS outbox** all in. **Sharing out**, permanent delete out. | |
| Docs | Read every tab as Markdown, no truncation. Append, find-and-replace, **anchor-based insert/replace** in. **No Markdown-to-Doc writer.** | |
| Sheets | Everything built plus find-rows, header-keyed reads, update-row. **Dropdown rules readable, not editable.** | Raw `batchUpdate` passthrough (the "anything goes" surface this project closes everywhere else). |
| Calendar | The six built tools. Events for the owner alone (attendees allowlisted — ADR 004). **A secondary "Google Testing" calendar for write checks**; the primary calendar is never written by any check. | RSVP, free-time search. |
| Destructive ops | No new gate. Google keeps version history and trash; the `read` scope covers cautious clients. | A "confirm before delete" mechanism. |
| Fixtures | Folder **Google Testing** (`146u4HhtHabLpaXgIIIOZ1Ib4MnmI4Rda`, personal, shared with tamu) holding **Internship Copy** (`1rtMq32einYm4i48IRM6It3MVUuDWGDVwEseZ061HEhA`) and **Musings Copy** (`1Mr4uKibX3RljaiCWTXogf9ydz71E7q0k2ANsdyymgqU`). Checks run on fresh copies; templates never modified. | |
| Spec structure | Spec 002 supersedes 001 for the whole product; 001 kept, marked superseded. | Two live specs. |
| `docs/human-verification.md` | Demoted, not deleted (done 2026-09-19). | Deletion (nine files cite it; it is the send-path regression recipe). |

## Non-negotiables

- **Every rule in plan 001's non-negotiables still holds**: stateless
  transport, `GET`/`DELETE` → 405 on every MCP endpoint, no global body
  parser, RFC 9728 PRM + `WWW-Authenticate` on every 401, RFC 8707 audience
  validation, DCR supported, hostname permanent.
- **A token minted for one endpoint is rejected by the other.** The
  two-endpoint design must not weaken the audience check; it must apply it
  per endpoint. A test that presents a `/mcp` token at `/workspace/mcp` (and
  the reverse) must get a 401.
- **`tools-enabled.json`'s fail-closed rule (ADR 003) carries over to the
  per-endpoint config.** Invalid or missing → the process refuses to boot
  (not "boots with no endpoints": a server that 404s everything would still
  look alive to a naive probe).
- **Scope classification fails closed.** A tool with no read/write
  classification is denied to every OAuth caller, as `src/http/scopes.ts`
  does today. Classification moves to the tool definition itself
  (`annotations.readOnlyHint`) so it cannot be forgotten separately.
- **ADR 004's allowlist wiring in `shareDriveFile`, `createCalendarEvent`,
  `updateCalendarEvent` is untouched.** `share_drive_file` is not exposed at
  all; the calendar tools keep their attendee check.
- **The mail endpoint's `tools/list` output is byte-identical before and
  after the restructure** (Phase 1's golden test). Renaming or reshaping mail
  tools is out of scope for this plan.
- **No Docs tool ever takes or returns a character index from the model.**
- **No check ever touches the owner's real tracker, real documents or primary
  calendar.** Harness copies are named `zz-test-<ISO timestamp>-<name>` so a
  leftover is recognizable and a sweep can trash them.
- **Read back from Google after every write in every layer of verification.**
  The unit suite proves bytes; only the harness and the agent runs prove
  Google.

## Phases

Each leaves a working system. The mail endpoint is live and unchanged for
clients through every phase.

| # | Work | Done when |
|---|---|---|
| **0** | Owner checklist (below) and the early risk test: consent the **tamu** account first with the full scope set and make one Drive call against the shared folder. Fixture ids recorded. Testing calendar created and its id recorded. | Both accounts' `token.json` show Drive/Sheets/Docs/Calendar scopes; a `drive.files.list` on the Google Testing folder succeeds from **both** accounts on the VPS; the four APIs are enabled in `email-503620`. **Done 2026-09-19** — `bash scripts/vps.sh 'node tools/workspace-probe.mjs'` is the check and passed for both accounts (Drive, Sheets, Docs, Calendar each called for real). tamu granted every scope: no university policy blocks it. Testing calendar id is in `tools/live/fixtures.json`. |
| **1** | **Tool registry restructure, no behavior change.** Tool definitions and handlers move out of `src/index.ts` into per-service modules; per-endpoint config replaces the single enabled list; scopes derive from tool annotations; instructions per endpoint. | `npm test` green; golden test proves the mail endpoint's `tools/list` JSON is byte-identical to a snapshot taken before the refactor; deployed; Claude Code reconnects and every mail tool works; `clients.sh list` shows normal traffic. **Done 2026-09-19** (commit `318965f`): 306/306 tests; independent review diffed all 61 moved handlers and 58 schemas against the original with zero drift; deployed, `dist/` hashes identical local↔VPS; a read (`get_labels`) and a write (`mark_as_read`) from Claude Code both logged `oauth`/200 through the new dispatch, no reconnect needed since the list is byte-identical. Leftovers, all cosmetic: historical comments in `src/http/transports.ts`, `src/gmail-format.ts`, `src/gmail-client.ts`, `src/http/oauth/router.ts` still name `GmailMultiInboxServer`/`tools-enabled.json` (fenced this phase; fix when those files are next touched); `test/instructions.test.mjs` only checks size, so the workspace text has no golden until Phase 3 gives it tools. |
| **2** | **Second protected resource.** OAuth provider accepts a set of resource URLs; per-endpoint verifier, PRM and 401 header; consent screen names the endpoint; scope rename with a legacy alias; `/workspace/mcp` mounted with an empty-but-valid tool list; Cloudflare ingress; `deploy.sh` probes both. | A real Claude Code client registers with `/workspace/mcp`, sees the consent screen naming "Google Workspace", gets `tools/list` (may be empty); a `/mcp` token at `/workspace/mcp` → 401 and vice versa (test + live curl); existing mail clients re-consent once and work. **Done 2026-09-19** (commit `c22cfdc`, see "Phase 2 — what actually happened"): 322/322 tests; independent adversarial review found no cross-endpoint bypass and mutation-tested both load-bearing checks; deployed, `dist/` hashes identical local↔VPS; boot log lists both endpoints; both `/mcp` and `/workspace/mcp` 401 through the tunnel with the right `resource_metadata`, both PRMs name themselves; the owner's existing Claude Code Mail client (legacy `mail:read mail:write` token) made a real `get_labels` call through the new gate — the alias works live. `google-workspace` registered in Claude Code via `claude mcp add`; the owner completed the real Google login, saw the consent page name "Google Workspace" with `read` and `write`, approved, and the request log shows that client's `initialize` → `tools/list` at `/workspace/mcp` with `scopes: [read, write]` and a token whose audience is the Workspace URL only (`clients.sh list`, 2026-09-19 20:01 UTC). No mail client has re-consented yet (none needed to); `clients.sh list` marks all four LEGACY, which is Phase 6's gate. |
| **3** | **Workspace reads.** Drive search with type filter and content reading (Docs → Markdown via our reader, PDF/Office → `extractText`); Sheets metadata, range, records, find-rows, dropdown rule; Docs read with all tabs (ported converter), tab index for long docs; Calendar lists/get. Live harness v1 (read-only checks, both accounts). | Harness v1 green on the VPS from both accounts; every read criterion in the spec passes; a Claude Code agent completes the read-only task list. **Done 2026-09-19** (commits `ef1d98d`..`7e05f81`, see "Phase 3 — what actually happened"): 370/370 tests (48 new); `bash scripts/vps.sh 'node tools/live/workspace-check.mjs --phase read'` is 36 passed / 0 failed / 1 honest skip (tamu has no upcoming events) from both accounts, every check paired with an independent API read-back; deployed, `dist/` hashes identical local↔VPS, boot log lists `Google Workspace: POST /workspace/mcp (13 tools)`. The agent-level read task list (`docs/workspace-verification.md`) is written but runs in Phase 5 with the write list, after the owner reconnects Claude Code to pick up the new tools. |
| **4** | **Workspace writes.** Sheets write/append/update-row/tabs/dimensions/format/chart/create; Docs append/replace/anchored insert (ported anchor resolution), create; Drive folder/rename/move/trash/upload-from-outbox; Calendar create/update/delete on the testing calendar. Harness v2 with the copy → mutate → read back → trash lifecycle. | **Done 2026-09-19** (commits `6e45b42`, `4bf4edd`, `78e5288`, `d06f21c`, `8592927`, `d57a4dd`, `028fc81`, `00afbaa`, and the sweep fix after it; see "Phase 4 — what actually happened"): 489/489 tests (up from 374); `/workspace/mcp` carries 35 tools (58 registry tools listed across both endpoints, 7 deliberately unlisted); deployed, `dist/` hashes identical local↔VPS, boot log reads `Google Workspace: POST /workspace/mcp (35 tools)`. Live harness run 1 was 87/9/5 (every failure a harness assumption, not a tool defect); run 2, after the fixes, was 99 passed / 0 failed / 2 honest skips (52 personal / 47 tamu); the sweep crashed on a cross-account trash 403, fixed to sweep per owning account, rerun trashed 10 leftovers with 0 remaining. Two independent adversarial reviews found no boundary defect; real findings fixed in `d57a4dd`. |
| **5** | **Agent-level verification and tuning.** Task lists run by a subagent through the deployed endpoint in Claude Code and in Codex; reviewer reads back Google and the transcript; Cursor connect + one call each; claude.ai + phone connect. Instructions and descriptions tuned from what the transcripts show. Owner eyeballs formatting and the chart. | Every spec acceptance criterion checked off with evidence; "first-attempt correct tool" holds for the ordinary operations in both clients' transcripts. **In progress 2026-09-19** (see "Phase 5 — what actually happened"): Claude Code done — Sonnet 5 subagents, competing connectors disabled, 40 + 31 + 5 + 1 + 5 logged tool calls all matching the self-reported transcripts, zero unrelated-tool calls, every attempted write's end state confirmed by an independent read-back diff; findings fixed in `8baf670` and `eee4a38`, both deployed with `dist/` hash parity; 498/498 tests. Reruns, owner's eye, sweep and the all-calendars `list_events` change (`ebebd0e`) done the same day. **Done 2026-09-20:** Codex ran all eight owner-typed messages (33 logged tool calls, right tool every time, every write confirmed by read-back); Cursor and claude.ai/phone each did `search_drive_files` → `get_spreadsheet` at `/workspace/mcp` under their own client ids. Copies swept, 0 remaining. |
| **6** | **Closeout.** Legacy scope alias removed once `clients.sh list` shows no old tokens; the dead duplicate client registrations revoked (on 2026-09-20 the list held three Cursor, three Claude and two Codex entries, most with no live token). `CLAUDE.md`, `README.md`, `docs/machine-setup.md` (ingress, onboarding matrix for two endpoints), spec reconciled. | ADRs 017–020 (scope model; tab-addressed Docs reads plus anchored writes; header-row auto-detection; fixture-copy verification) and the ADR 004 amendment were written at the end of Phase 4, 2026-09-19 — not deferred to this phase. Docs describe the running system; `/reconcile` finds no drift. **Done 2026-09-20** (commits `f48d55d`, `d31cdc0`, `f37545b` and the docs commit after them; see "Phase 6 — what actually happened"): the gate as written could never have closed on its own, so the stored tokens were rewritten in place (117 records, read back clean) and the alias deleted with fail-closed refusal in its place; 505/505 tests; independent review found no bypass and mutation-tested both guards; deployed, `dist/` hashes identical local↔VPS; a real call on each endpoint logged 200 under `read write`; no 401 in the request log after the deploy; `clients.sh list` shows 8 registrations, one per client per endpoint, none RETIRED. README, `machine-setup.md` (onboarding matrix), `CLAUDE.md`, spec, ADRs 016/017 reconciled. |

## Owner actions that cannot be automated (Phase 0)

All up front, so agents run unattended afterwards. Each is one-time.

1. **Enable four APIs in GCP project `email-503620`**, in the Cloud console:
   Google Drive API, Google Sheets API, Google Docs API, Google Calendar API.
   (No `gcloud` on this machine; the console is the only path.) If any is
   already enabled, nothing to do for it.
2. **Re-consent both accounts.** `tools/reauth.mjs` will have been widened to
   request `GOOGLE_ACCOUNT_SCOPES` (agent does this first). Then, per account:
   `bash scripts/vps.sh 'node tools/reauth.mjs tamu'`, open the printed URL in
   a browser signed in as that account, click through Google's "unverified
   app" interstitial (same as for Gmail today — the Desktop client is In
   production but unverified, and `drive` is a restricted scope like
   `mail.google.com`), copy the `code` from the failed `localhost` redirect,
   then `bash scripts/vps.sh 'node tools/reauth.mjs tamu <code>'`. Repeat for
   `personal`. **Do tamu first** — a university admin policy blocking Drive or
   Docs for third-party apps is the one unknown that could reshape the plan,
   and it costs five minutes to learn.
3. **Create the "Google Testing" calendar** — done 2026-09-19 by
   `tools/workspace-probe.mjs --create-calendar` under the personal account,
   not by hand: it creates the secondary calendar, sets
   `calendarList.selected=false` so test events never show on the main view,
   and is idempotent (an existing one is reused). Its id is recorded in
   `tools/live/fixtures.json`. tamu does not see it; sharing it to tamu, if
   Phase 4 needs calendar checks from both accounts, is a calendar ACL grant
   to the owner's own address.
4. **After Phase 2 deploys:** re-authorize each existing mail client once
   (Claude Code: `/mcp` → reconnect; claude.ai/phone/Codex/Cursor: their own
   reconnect) because the scope names changed.
5. **After Phase 4 deploys:** run `/mcp` in Claude Code and reconnect
   `google-workspace` so the cached 13-tool (read-only) list is replaced by
   the full 35-tool (13 read + 22 write) list; deploying alone does not do
   this. Codex, Cursor, claude.ai: reconnect the same way if already
   registered, or register `https://mcp.example.com/workspace/mcp` fresh.
6. **Phase 5:** look at two things on the harness-kept internship copy (`bash
   scripts/vps.sh 'node tools/live/workspace-check.mjs --phase write --keep
   --account personal'`, then `--sweep` after looking) — the bold header row
   `B7:J7` and the column chart anchored at `L6` over the table the harness
   wrote at `L1:M4` on the Internship Tracker tab — and say whether they look
   right.
7. **Phase 5, after 2026-09-19's deploys:** run `/mcp` in Claude Code and
   reconnect `google-workspace` once more — `upload_drive_file`'s schema
   changed (`path` is optional now) and the cached schema still requires it.
   (The DW2–DW4 rerun already passed without it, via the refusal listing.)
8. **Phase 5, other clients:** `google-workspace` is registered in
   `~/.codex/config.toml` and `~/.cursor/mcp.json` (done by the agent,
   2026-09-19; Codex backup at `config.toml.pre-workspace.bak`) and the
   owner logged both in the same day (`clients.sh list` shows each with a
   Workspace token), typed the messages listed in
   `docs/workspace-verification.md`, "Owner-run clients", and connected
   claude.ai and the phone app — all scored from the request log
   2026-09-20. **Done.** claude.ai and the
   phone app: add `https://mcp.example.com/workspace/mcp` as a custom
   connector, make one call.

## Phase 1 — Tool registry restructure

**Why first:** everything after it adds tools, and adding tools to a
4,100-line inline array is how the current sprawl happened. The golden test
makes this refactor safe to do without behavior review.

**Shape:**

- `src/tools/<service>.ts` for `mail`, `drive`, `sheets`, `docs`, `calendar`
  (and `attachments` if the mail split warrants it). Each exports
  `definitions: Tool[]` — the exact schemas that exist today, moved not
  rewritten — with `annotations: { readOnlyHint, destructiveHint }` added to
  every one, and `handlers: Record<toolName, Handler>`. Handler code moves out
  of the class as functions taking a small context (`loadConfig`,
  `getClientForAccount`, `configRoot`).
- `src/endpoints.ts`: loads `endpoints.json` at boot, validates it, refuses to
  boot on failure. Shape:
  ```json
  { "mail":      { "path": "/mcp",           "tools": ["read_emails", "..."] },
    "workspace": { "path": "/workspace/mcp", "tools": [] } }
  ```
  A listed tool that no module defines is a boot error (typos fail loudly).
  `tools-enabled.json` is deleted in the same commit; ADR 003 is amended to
  point at the new file, not superseded — the rule is identical.
- `src/instructions/mail.ts`, `src/instructions/workspace.ts`: the per-endpoint
  instructions strings, each with a unit test asserting `< 2000` bytes.
- `src/http/scopes.ts`: `scopeForTool` reads the registry's annotations
  (`readOnlyHint === true` → `read`, else `write`); a definition without
  `annotations` is a unit-test failure and a runtime deny. Scope names change
  to `read`/`write` here in Phase 2, not in this phase.
- `GmailMultiInboxServer` becomes `McpEndpointServer(endpointName)`: its
  `tools/list` returns that endpoint's definitions, its dispatch consults that
  endpoint's handlers. `createServer` in `runHttpServer` becomes a factory per
  endpoint.
- **Golden test:** `test/golden/mail-tools-list.json` is captured from the
  pre-refactor build and the post-refactor list must equal it exactly
  (deep-equal after stable key ordering). Names, descriptions, schemas,
  order, and the `instructions` string.
  - **Captured 2026-09-19** by `test/golden/capture-mail-tools-list.mjs`
    over **stdio**, not through an OAuth token: the `tools/list` handler
    ignores the caller entirely, so stdio yields the same bytes, and the
    local `dist/index.js` it ran against hashed identical (md5) to the
    deployed one. 23 tools, instructions 1,711 bytes, server `ghub 1.4.0`.
    Regenerate only deliberately.
  - **One permitted addition:** today's definitions carry no `annotations`;
    Phase 1 adds `annotations.readOnlyHint`/`destructiveHint` to every one
    because scope classification derives from it. The golden test compares
    everything except `annotations`, and separately asserts the flag is
    present on every tool and agrees with `scopeForTool`. Clients that
    honour `readOnlyHint` (permission prompts) may behave slightly
    differently; judged harmless and correct.

**Fences:** `src/compose.ts`, `src/allowlist.ts`, `deliver()` in
`src/gmail-client.ts`, `src/http/oauth/*` — untouched in this phase.

## Phase 2 — Second protected resource

**Provider** (`src/http/oauth/provider.ts`): `resourceUrl: URL` becomes
`resourceUrls: URL[]`. `resolveResource()` accepts any member. `PendingAuthorization`,
codes and token records already carry `resource` — unchanged. `verifyAccessToken`
is replaced by `verifierFor(resourceUrl)` returning a verifier that rejects a
record whose `resource` is not *that* URL. The consent page shows which
endpoint is being authorized ("Mail" / "Google Workspace") next to the client
id and redirect host — the owner should be able to tell "this client is
asking for my files" from "for my mail".

**Router** (`src/http/oauth/router.ts`): `mcpAuthRouter` is mounted once with
the first resource (it serves the shared AS metadata and the PRM for `/mcp`).
A second PRM route is added by hand at
`/.well-known/oauth-protected-resource/workspace/mcp` with `resource_name:
"Google Workspace MCP server"`, mirroring the existing bare-path alias. Each
endpoint's gate is `requireBearerAuth({ verifier: verifierFor(url),
resourceMetadataUrl: prmUrlFor(url) })`.

**Server** (`src/http/server.ts`): mounts, per endpoint in `endpoints.json`,
the gate → request log → `POST` handler → `GET`/`DELETE` 405, at that
endpoint's path. The request log already records `path`, which is enough to
tell endpoints apart in `clients.sh list`; add an `endpoint` column there.

**Scopes:** `SUPPORTED_SCOPES = ['read', 'write']`, descriptions rewritten
("Look at your mail, files, documents, spreadsheets and calendar" / "…and
change them"). **Legacy alias:** `verifierFor` maps `mail:read`→`read`,
`mail:write`→`write` on tokens issued before the cutover, so the owner's
daily clients keep working until re-consented; removed in Phase 6.

**Cloudflare:** the ingress regex (read 2026-09-17:
`^/(mcp|\.well-known/.*|authorize|token|register|revoke|oauth/google/callback|oauth/consent)$`)
gains `workspace/mcp`, via `scripts/cloudflare-api.sh PUT
/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$CF_TUNNEL_ID/configurations`. The
`.well-known/.*` clause already covers the new PRM path. Plan 001 recorded
that this ingress list drifted twice; check it before debugging the app.

**`deploy.sh`:** probes both `/mcp` and `/workspace/mcp` unauthenticated and
asserts 401 on each.

**Tests to add** (extend `test/helpers/oauth.mjs` to take the resource URL):
cross-endpoint token rejection both ways; PRM served for both paths with the
right `resource`; consent page names the endpoint; legacy scope alias; boot
refusal on bad `endpoints.json`; a `GET /workspace/mcp` → 405.

### Phase 2 — what actually happened (2026-09-19)

Built in one session (commit `c22cfdc`), 322/322 tests (16 new), independent
adversarial review by a separate agent before deploy. Deviations from the
design above, all deliberate:

- **`resources: {url, name}[]` rather than `resourceUrls: URL[]`.** The
  consent page and each endpoint's PRM need a human name, so the provider
  takes the pair. The names come from a new required `displayName` field in
  `endpoints.json` ("Mail", "Google Workspace"), validated at boot like every
  other field. `src/http/server.ts` derives the resource list from the same
  endpoint list it mounts, so mount, gate, PRM and consent page cannot
  disagree.
- **`GmailOAuthProvider.verifyAccessToken` now throws.** The SDK interface
  requires the method, but on a two-audience server "is this token valid?"
  has no answer without "for which endpoint?". A gate wired to the provider
  itself would fail with a 500 on its first request instead of silently
  accepting cross-endpoint tokens. Only `verifierFor(url)` verifies.
- **Nested endpoint paths are refused at boot** (`/mcp` and `/mcp/x`).
  Express's `app.use(path)` is a prefix match, so one endpoint's gate would
  otherwise apply to the other's requests, and whichever mounted first would
  win.
- **A client that sends no `resource` gets a Mail token** — the first entry
  in `endpoints.json`, which is exactly the pre-Phase-2 behaviour. The MCP
  SDK client (Claude Code) always sends `resource`, taken from the endpoint's
  own PRM, so this default only reaches a client that ignores RFC 9728; its
  failure mode is a visible 401 at Workspace, not silent access.
- **The legacy alias lives in one function**, `normalizeScopes()` in
  `src/http/scope-names.ts`, applied at authorize (a re-consenting client may
  still ask for the old names), at refresh (the stored grant and the request
  are compared under the new names; the new access token is issued under
  them, so an un-re-consented client converges on `read`/`write` at its
  first refresh while its refresh-token record keeps the old names as
  evidence) and in the verifier. `clients.sh list` now prints each client's
  scope sets and marks `mail:` ones LEGACY — that line is Phase 6's removal
  criterion. On deploy day every live token (4 refresh, 16 access) was legacy.
- **`deploy.sh` probes the PRM too**, not just the 401: each endpoint's
  `/.well-known/oauth-protected-resource<path>` must come back through the
  tunnel naming that endpoint as `resource`, and each 401's
  `WWW-Authenticate` must name that same URL. A wrong gate at a path would
  still 401; this catches it. Endpoint paths are read from `endpoints.json`.
- **`scripts/cloudflare-api.sh` now expands `$CF_ZONE_ID`/`$CF_ACCOUNT_ID`/
  `$CF_TUNNEL_ID` in the path itself.** The documented form silently sent the
  literal text and got a 404 — found while updating the ingress this phase.
- Cloudflare ingress: `workspace/mcp` added (config version 4, read back).
  The `.well-known/.*` clause already covered the new PRM path.

## Phase 3 — Workspace reads

**Drive** (`src/tools/drive.ts`, client methods in `src/gmail-client.ts` or a
new `src/drive-client.ts` if the class split is worth it):
`search_drive_files` gains `type` (`spreadsheet` | `document` | `folder` |
`pdf` | `presentation` | `any`) mapped to a `mimeType` clause;
`list_drive_folder`; `get_drive_file`; `read_drive_file` — Google Doc → our
Docs Markdown reader (all tabs, so it matches `read_doc` exactly), Google
Sheet → returns the tab list and says to use the Sheets tools, PDF/docx/xlsx
→ `extractText()` from `src/attachments.ts` on the downloaded bytes (OCR
included), anything else → metadata plus "no text form". Results always name
the account.

**Sheets** (`src/tools/sheets.ts`): keep `get_spreadsheet` (was `sheets_get`),
`read_sheet_range` (adds row numbers to the output), new `read_sheet_records`
(header row → array of objects, `header_row` param default 1), new
`find_sheet_rows` (`tab`, `column` by header name, `value`, `match`:
`exact`|`contains`, returns `[{row, values}]`), new `get_sheet_dropdown`
(`spreadsheets.get` with a `fields` mask on `dataValidation` for one cell or
range, returns the allowed values). A1 quoting of tab names lives in one
helper with unit tests (`'Career Fair'!A1`).

**Docs** (`src/tools/docs.ts`, `src/docs/markdown.ts`, `src/docs/tabs.ts`):
`read_doc` calls `documents.get` with `includeTabsContent: true`, walks
`tabs[]` and `childTabs[]` recursively, renders each tab with a heading line
carrying its title and `tabId`, using the converter ported from
`a-bonus/google-docs-mcp/src/markdown-transformer/docsToMarkdown.ts` (adapt to
`docs_v1.Schema$*` types; keep its test cases as `node:test` cases). Above a
size threshold (start at 60,000 characters, revisit after Phase 5) it returns
the tab index (title, id, depth, character count) and `read_doc` takes an
optional `tab_id` to read one. Never truncates. Images and footnotes become
inline markers, not silence.

**Calendar** (`src/tools/calendar.ts`): `list_calendars`, `list_events`
(window + optional text query), `get_event` — the existing methods, output
checked for explicit time zones.

**Live harness v1** (`tools/live/workspace-check.mjs`, ships to the VPS with
the rest of `tools/`, runs as `bash scripts/vps.sh 'node
tools/live/workspace-check.mjs --phase read'`): reads `tools/live/fixtures.json`
(folder, template ids, calendar id, account ids — the repo is private and
these are identifiers, not secrets), and for each account calls the **tool
handlers** (the same code an MCP call runs) with real credentials, asserting
on their results and on independent API read-backs. Read phase needs no
copies: it reads the templates. Prints one line per check, exits non-zero on
any failure. This is the inner loop for autonomous iteration: edit, `npm
test`, `deploy.sh`, harness, repeat, no human.

### Phase 3 — what actually happened (2026-09-19)

Built in one session, three commits, independent adversarial review before
closing. Deviations from the design above, all deliberate:

- **`read_sheet_records` / `find_sheet_rows` auto-detect the header row**
  when `header_row` is omitted (widest row in the first 20;
  `detectHeaderRow` in `src/sheets/records.ts`) and say which row they used.
  The owner's tracker has a title on row 2, a totals block on rows 4–5 and
  its header on **row 7** — a default of 1 failed the single most common
  flow ("find the row for Company X") on the first harness run. Still a
  heuristic; Phase 5 transcripts decide whether it holds.
- **`read_drive_file` on a Google Sheet does not export to `.xlsx`.** It
  returns the tab list and points at the Sheets tools, so there is one way
  to read a sheet, not two that disagree. A Google Doc goes through the same
  `renderDocument` + `formatDocumentRead` as `read_doc`, so those two cannot
  disagree either. Slides still export to `.pptx` and go through `extractText`.
- **A real bug in the mail path fell out of the harness:** every PDF under
  4 KB failed to extract with `bad XRef entry`. `extractPdf` handed pdf-parse
  a Node `Buffer`; the bundled pdf.js clones it with
  `new value.constructor(value)` and later builds sub-streams from
  `bytes.buffer` at absolute offsets, ignoring `byteOffset`, so a pooled
  Buffer (< 4 KB) reads pool garbage. Fixed by passing a `Uint8Array` copy;
  pinned by `test/attachments.test.mjs` with a hand-built 600-byte PDF
  (`test/helpers/tiny-pdf.mjs`). Real attachments are almost always larger,
  which is why nobody saw it.
- **Every Docs tab body opens with a `sectionBreak`;** the ported converter
  rendered it as `---` at the top of every tab. The opening one is skipped.
- **`read_sheet_range` sizes its column header from the requested range**,
  not from what Google returned — Google trims trailing empty cells, so
  `A1:C3` came back two columns wide.
- **`list_events` defaults `time_min` to now** when no window is given.
  Without that, `orderBy: startTime` returns the oldest events on the
  calendar first, which is never what "what's coming up" means.
- **`describeGoogleApiError`** (Drive/Sheets/Docs/Calendar) produces the
  spec's sentences: lapsed auth names the account and the re-consent command,
  a missing scope likewise, a 404 says "not found in account X — try the
  other", a disabled API names the API and the activation link. The old
  Drive-only version told the model to run `begin_account_auth`, a tool
  listed on no endpoint.
- **The harness uploads one tiny PDF per run** (`zz-test-<ISO>-sample.pdf`,
  personal account, trashed on exit, `--sweep` for leftovers). The design
  said the read phase needs no writes; the spec needs "a PDF placed in the
  folder" and the folder has none. It is the one write the read phase does.
- **`GmailAccountClient.rawApis()`** exposes the googleapis handles for
  harness read-backs so no verification script opens a token file itself
  (`tools/live/inspect-fixtures.mjs` and the harness both go through it;
  an ad-hoc script that read tokens was refused by the permission
  classifier, correctly).
- **Independent review found two real gaps, both fixed before closing:**
  `read_drive_file` buffered any non-Google file whole with no ceiling (a
  multi-GB Drive video would OOM the one process that also serves Mail) —
  now refuses above 25 MB (`MAX_READ_BYTES`, Gmail's own attachment
  ceiling) before downloading; and a table nested inside a table cell was
  dropped from the Markdown with no marker — now `[nested table: …]`. The
  review also asked for a unit test proving `getDocumentWithTabs` sends
  `includeTabsContent: true` (dropping it failed no unit test, only the
  live harness); added. Found sound and not to be re-verified: no write
  reachable from the workspace list, scope gate fails closed, mail golden
  byte-identical, no character index leaks, partial-account failures never
  hide the other account, no hollow harness check.
- **Not a golden.** `test/workspace-endpoint.test.mjs` pins the workspace
  `tools/list` to `endpoints.json`'s order, all-read-only, < 40, every
  id-taking tool requiring `account`, descriptions 60–512 chars — not the
  bytes, because Phase 5 tunes them.
- **The old read tools are gone, not aliased:** `list_drive_files`,
  `get_drive_file_content`, `sheets_get`, `sheets_read`, `docs_get`. The
  unlisted write tools keep their Phase 1 names until Phase 4 renames them.
- **Memory on the droplet was not exercised for OCR**: the harness PDF has
  a text layer, so pdf-parse handled it and the OCR binary never ran. Still
  listed under "Still only a guess".

## Phase 4 — Workspace writes

**Sheets:** `write_sheet_range`, `append_sheet_rows` (range is the tab name;
`INSERT_ROWS`), new `update_sheet_row` (`row` number + `{header: value}` map →
writes only those cells), `add_sheet_tab`, `rename_sheet_tab`,
`delete_sheet_tab`, `insert_sheet_dimension`, `delete_sheet_dimension`,
`format_sheet_range`, `add_sheet_chart`, `create_spreadsheet`. Every write
returns what Google's response says changed (`updatedRange`, `updatedCells`),
never the request echoed.

**Docs:** `append_doc_text(tab_id)` via `EndOfSegmentLocation` with `tabId`;
`replace_doc_text(tab_id)` via `replaceAllText` with `tabsCriteria`;
`insert_doc_text(tab_id, anchor: {heading | text}, position: before|after,
text)` — anchor resolution ported from `findElement.ts`/`findAndReplace.ts`,
scoped to the tab, resolved at call time, refusing on 0 or >1 matches with
the candidates listed; `create_doc`. `docs_insert_table` and
`docs_apply_style` are **not** carried forward (index-based).

**Drive:** `create_drive_folder`, `update_drive_file` (rename/move),
`trash_drive_file`, `upload_drive_file` — path must resolve inside the outbox
directory (`src/compose.ts:795` is the existing resolver; reuse it and its
delete-after-use behavior).

**Calendar:** `create_event`, `update_event`, `delete_event` — existing
methods; the attendee allowlist check stays first.

**Harness v2:** `--phase write` copies each template into the folder
(`drive.files.copy`, name `zz-test-<ISO>-internship` / `-musings`), runs every
write check on the copies, reads back, trashes the copies on success, keeps
them with `--keep` for the owner's eyeball checks, and `--sweep` trashes any
`zz-test-*` leftovers. Calendar checks create and delete on the testing
calendar only and assert the primary calendar's event count is unchanged
before and after. The cross-reference flow creates its own
`zz-test-<ISO>-contacts` spreadsheet.

### Phase 4 — what actually happened (2026-09-19)

Built as four units in parallel worktrees (each on Sonnet), one design doc
fixing tool names, arguments and refusals before any unit wrote code: **A**
Sheets writes (`src/tools/sheets.ts`, `src/sheets/writes.ts`); **B** Docs
writes (`src/tools/docs.ts`, `src/docs/anchors.ts`, `src/docs/writes.ts`);
**C** Drive and Calendar writes plus the shared outbox module (`src/outbox.ts`
— `src/compose.ts` changed only by an import-only swap, the outbox helpers
moved out verbatim with MIME construction untouched and `test/compose.test.mjs`
unchanged and green; judged not a send-path change under
`docs/human-verification.md`'s rerun trigger, so it was not rerun); **E** live
harness v2 (`tools/live/workspace-check.mjs --phase write|all`,
`tools/live/lib/harness-helpers.mjs`) plus the Phase 4 write task lists in
`docs/workspace-verification.md`. The orchestrator then wired `endpoints.json`
(35 tools, the "Tool surface" order below), rewrote
`src/instructions/workspace.ts` (1,926 of the 2,000-byte budget), replaced
`test/workspace-endpoint.test.mjs` to pin the 22 write tools as exactly the
`readOnlyHint: false` set, and deleted the dead index-based Docs client
methods (`getDocument`, `appendToDocument`, `replaceInDocument`,
`insertTableInDocument`, `applyDocHeadingStyle`) from `src/gmail-client.ts`.
Registry: 65 tools (58 listed across both endpoints + 7 deliberately
unlisted: `share_drive_file`, `list_accounts`, `begin_account_auth`,
`finish_account_auth`, `get_signature`, `get_attachment`,
`get_all_attachments`). **Deleted, not aliased:**
`sheets_write`/`append`/`create`/`add_tab`/`rename_tab`/`delete_tab`/
`format`/`add_chart`/`insert_dimension`/`delete_dimension`,
`docs_create`/`append`/`replace_text`/`insert_table`/`apply_style`.

**Deviations from the design, all deliberate:**

- New Google-calling logic lives in per-service modules
  (`src/sheets/writes.ts`, `src/docs/writes.ts`) taking a `client.rawApis()`
  handle plus the account id, rather than growing the 3,200-line
  `src/gmail-client.ts` further.
- `insert_sheet_dimension`/`delete_sheet_dimension` take `before`/`start` as
  a 1-based row number or column letter (string or number), not a 0-based
  `start_index`.
- `add_sheet_chart` takes `anchor_cell` (A1 notation), not row/column indices.
- `add_sheet_tab` takes an optional `headers` array.
- `create_spreadsheet`/`create_doc` take `folder_id` and move the new file
  there.
- `update_drive_file` takes `name` and/or `move_to_folder_id`; the old
  `add_parents`/`remove_parents`/`starred`/`description` arguments are gone.
- `upload_drive_file`'s path must resolve inside the outbox
  (`assertInsideOutbox`, realpath both sides) and the file is deleted after a
  successful upload — stricter than mail attachments, which are left alone
  when read from outside the outbox (ADR 008).
- Calendar write tools lost `send_notifications`.
- `delete_event` reads the event back rather than trusting the call succeeded
  — Google returns the event with `status: "cancelled"`, not a 404.
- `append_doc_text`/`insert_doc_text` force inserted paragraphs to
  `NORMAL_TEXT` with bullets removed, because Docs copies the neighbouring
  paragraph's style onto newly inserted text (ADR 018).
- Every Docs `batchUpdate` carries `tabId` and
  `writeControl.requiredRevisionId`; a missing `revisionId` refuses the edit
  rather than proceeding unpinned (ADR 018).

**Adversarial review** (two independent Sonnet reviewers, before deploy)
found no boundary defect: the attendee allowlist held through the new
handlers, including `"Name <owner>"` and CRLF-injection shapes (refused,
fail-closed); the scope gate was untouched and non-tautologically tested;
the outbox guard held against symlink and `..` escapes and the outbox
directory itself; `share_drive_file` stayed byte-identical and unlisted.
Real findings, all fixed in `d57a4dd`:

- Ambiguous-anchor refusals were uncapped — now at most 10 candidates plus
  "and N more".
- An `anchor_text` or `find` containing a line break could match through a
  paragraph boundary and merge paragraphs on replace — now refused.
- A missing `revisionId` silently dropped `writeControl` — now refuses.
- `update_sheet_row` echoed the caller's value when Google's response
  carried no `updatedData` — now prints "written; Google returned no value
  for this cell -- read it back".
- `append_sheet_rows` could throw after a successful write if
  `updatedRange` named no row — now non-fatal.
- Two harness soft-check regexes never matched real output.

**Live harness, on the VPS, real Google, fresh copies per account** (ADR
020 has the full contract): run 1 was 87 passed / 9 failed / 5 skipped,
every failure a harness assumption or a too-strict tool refusal, not a
boundary defect — `values.append` aligns appended values to the table's
**first header column** (column B on the tracker, column A is empty), not
column A, now stated in `append_sheet_rows`' description;
`insert_sheet_dimension`/`delete_sheet_dimension` refused a numeric
`before`/`start` (tools now accept number or string, harness passes one of
each); Google truncates event times to whole seconds; `drive.files.list` by
name lags for a non-owner's just-created file in a shared folder, and the
same name used by both accounts in one run collided — the harness now takes
the id from the tool's own output and reads back with `files.get`, and
every created name carries the account id. Run 2: 99 passed / 0 failed / 2
skipped (tamu: no upcoming primary events, no testing calendar; 52
personal / 47 tamu), copies trashed on success. The sweep then crashed with
a 403 — the folder owner cannot trash a tamu-owned copy — fixed so each
account sweeps what it owns and prints what remains by owner; the rerun
trashed 10 leftovers, 0 remaining.

Settled from "Still only a guess": `drive.files.copy` preserves a
spreadsheet's data-validation rules (`get_sheet_dropdown` on the copy
matched); a deleted event reads back with `status: "cancelled"`; tamu can
create, upload, copy and write inside the personal-owned shared folder.

**Noted, not fixed** (see `docs/tickets/README.md`, `## Minor`):

- The Calendar write methods in `src/gmail-client.ts`
  (`createCalendarEvent`/`updateCalendarEvent`/`deleteCalendarEvent`) do not
  wrap googleapis errors through `describeGoogleApiError` the way the read
  methods do; the Phase 4 handlers wrap at the handler level instead.
- ADR 009 claims five outbox tests in `test/compose.test.mjs` that do not
  exist (`grep -i outbox` finds none); the outbox module now has its own
  `test/outbox.test.mjs`.
- `create_doc`'s report prints `Document ID:` without the `**` markers every
  other tool uses; the harness regex depends on it.
- The new folder-move path means a spreadsheet or doc created into a folder
  the owner previously shared is visible to those people at once — Google's
  own sharing model, not a new grant; ADR 004's scope is unchanged.

**Owner actions now open:** run `/mcp` in Claude Code and reconnect
`google-workspace` (35 tools replace the cached 13); look at the kept
internship copy from `bash scripts/vps.sh 'node tools/live/workspace-check.mjs
--phase write --keep --account personal'` — the bold header row `B7:J7` and
the column chart anchored at `L6` over the small table the harness wrote at
`L1:M4` on the Internship Tracker tab — then run the same command with
`--sweep`. Phase 5 is next, in its own session.

## Phase 5 — Agent-level verification

The task lists live in `docs/workspace-verification.md` (written in Phase 3,
extended in Phase 4): one list per area, phrased as the owner would phrase a
request, with the expected end state in Google. A subagent in Claude Code,
connected only to the deployed endpoints (both, for the cross-endpoint
hints), runs a list against harness-made copies; a second subagent, or the
resident session, reads back the copies through the API and reads the
transcript, scoring each task pass/fail and noting any exploratory or wrong
tool calls. Codex runs the same lists. Cursor: register, list tools, one
`search_drive_files`. claude.ai and phone: register, one call.

Tuning loop: what the transcripts show goes into descriptions and
instructions (both endpoints), redeploy, rerun. Every tool rename requires a
client reconnect — budget for it.

### Phase 5 — what actually happened (2026-09-19, Claude Code half)

**Setup.** Anthropic's own Google Drive, Google Calendar and Wispr Flow
connectors were disabled for this project first, so a subagent could only
answer through `/workspace/mcp`. `--phase write --keep` (63/63, both
accounts) and `--phase read --keep` (36/36/1 skip) left copies, the contacts
sheet and the sample PDF in place; the reviewer seeded "TODO" and "draft
notes" phrases and one outbox file, then took a baseline with
`tools/live/phase5-readback.mjs` (new: sheet values/bold/charts/links, doc
paragraphs per tab, folder children + trash, testing-calendar events +
primary count, outbox listing — all via `rawApis()`). The subagents ran on
Sonnet 5 (the global subagent model), were given the task text verbatim, no
ids for the read list, ids for the copies on the write list, and were told
to use nothing but the `google-workspace` tools and to report every call.
The server's `request-log.log` (`tools/call:<name>` per line) was the
cross-check: 40 calls for the read run, 31 for the write run, 5 for the
rerun, 1 for B2 — every one matching the self-reported sequence, none to an
unrelated tool.

**Read list (37 tasks: 19 from personal, 18 from tamu).** Every task chose
the right tool first: `search_drive_files` → `list_drive_folder`,
`read_doc` with the right `tab_id`, `read_sheet_records` with auto-detected
header row 7, `find_sheet_rows` on `Company`, `get_sheet_dropdown` on
`E8:E50`, `read_sheet_range` `B7:E9`, `list_calendars`, `list_events`,
`get_event`. G4 (`t.nope`) and S5 (Initech) refused/empty without invention.
C3 from tamu was honestly impossible (no events). Three findings:

- **C2 defect.** "This coming week" as `time_max` alone returned 25 events
  from 2025-08 onward: `list_events` only defaulted `time_min` to now when
  *both* bounds were absent, and a unit test enshrined that. Fixed: defaults
  whenever `time_min` is missing; a past `time_max` without `time_min` is
  refused with a hint.
- **C3 label.** A Teams invite stored in `Etc/UTC` printed as
  `15:00:00-05:00 (Etc/UTC)`; the agent called it a bug. `formatEventTime`
  now checks the named zone's offset at that instant (Intl) and, when it
  disagrees with the stamp, says the offset is authoritative.
- **D1 fixture ambiguity.** From personal the agent found the owner's real
  "Internship" tracker and preferred it over "Internship Copy", saying why.
  The task list expected the copy; amended — the real one is a valid answer.
  (`get_sheet_dropdown` taking only an A1 range, not a header name, is a
  minor ticket.)

**Write list (22 tasks on personal's copies).** The agent oriented first
(`get_spreadsheet`, `read_sheet_records`, `read_doc`, `list_calendars`),
then wrote; the before/after diff confirmed every attempted write landed
exactly and nothing else moved (row-5 totals changed by formula). SW1 only
Status E8; SW2 row 23 with a live hyperlink; SW3 "Career Fair" A1:C1; SW4
insert+delete left row 9 = Tesla; SW5 the harness had already written the
contact, so the agent's write was a no-op by value; SW6 bold; SW7 table
`N1:O4` + column chart at `N6`; DG1 last paragraph of Internet; DG2 two
TODOs in MCP → DONE, the SRC v DIST one untouched; DG3 "See the appendix."
as its own paragraph after the H1; DG5 refused with the tab list; CW1–CW3
create/move/cancel on the testing calendar only (primary 9 → 9); CW4
refused before creation; BW1 tamu appended row 24 through the shared
folder. Findings:

- **DW2 gap (real).** "There's a file in my server's outbox — upload it":
  no tool listed the outbox, so the agent refused rather than guess a name,
  and DW3/DW4 could not run. Fixed: `upload_drive_file` without `path`
  lists the outbox; `path` may be a bare filename; a missing file's refusal
  names what is there. Schema changed (`path` optional) → reconnect, then
  rerun.
- **DG4 was the task's fault.** "Replace the phrase X with Y in the MCP tab"
  is exactly `replace_doc_text`; the agent used it and replaced both. The
  task is reworded to an anchored insert ("add the line … right after the
  sentence that mentions …"); the rerun refused, naming both places.
- **CW4 wording.** The attendee refusal said "No message was sent and no
  send request reached Gmail." Now "No event was created and no request
  reached Google Calendar." (mail's sentence untouched). Rerun confirmed.
- **BW1 surprise for the agent.** The instructions' "the account the id
  came from" read as a hard rule; a shared file works under either.
  Instructions reworded ("one that can see the file"). 1945 bytes.
- **SW4 row counts** (1001 → 1003 → 1002) are not a quirk:
  `append_sheet_rows` uses `INSERT_ROWS`, which grows the grid. Copy at
  1003 = template 1000 + harness append + agent append + insert − delete +
  BW1 append. Documented here, no change.

**B2.** tamu's `token.json` renamed aside (nothing copied or read), probe
showed `FAIL [tamu] load account`; the agent's search named tamu's failure
verbatim and returned personal's results — pass — but the error sat in a
trailing "## Account Errors" after 20 results. Aligned with mail (ADR 011):
`search_drive_files`, `list_calendars`, `list_events` now open with the
INCOMPLETE banner. Token renamed back; probe 11/11. (Not re-broken to see
the banner live; the unit test pins the format.)

**DW2–DW4 rerun** passed before any reconnect: with the *old* cached
schema the agent probed the outbox directory path (refused as "outside"),
then a guessed filename, whose refusal listed the real one; upload → rename
+ move → trash all confirmed by read-back (note.txt in trash with the
fixture folder as parent, Screenshots empty, outbox empty). The directory
path now lists too (`204224a`), and the Drive tools' `account` argument no
longer says an id is valid in one account only. The empty "Screenshots"
folder was trashed by the reviewer.

**Owner decisions on the findings (2026-09-19, after the report):**
`list_events` must cover *all* the owner's calendars — classes, school,
social and shared calendars are separate calendars, so the primary-only
default understated the week. Spec 002 "Calendar" amended; `ebebd0e` makes
the no-`calendar_id` default a sweep of every calendar shown in the sidebar
(calendarList `selected` or primary), each event naming its calendar, an
event reached through two accounts listed once, one failing calendar under
the INCOMPLETE banner. Live: personal's coming week went from 5 events
(primary) to 26 across 10 calendars, matching Google's per-calendar union
(harness read phase 38/0/1); the agent-level C2 rerun listed 23 events across 12 swept calendars, each named, no banner. The dropdown-by-header note stays a minor
ticket. ADR 011 (banner on both endpoints) and ADR 020 (the agent-level
layer and `phase5-readback.mjs`) folded in — no new ADR.

Owner's eye done (bold header and both charts looked right), sweep run
(16 leftovers trashed, 0 remaining), Claude Code reconnected. Codex and
Cursor registered and logged in at `/workspace/mcp` with `read write`
(`clients.sh list`, 2026-09-20 00:11 and 00:12 UTC) — connect proven for
both; their task runs are the owner's to type.

**Other clients (2026-09-20, owner-typed, scored from `request-log.log`
by client id and by `phase5-readback.mjs`).** *Codex* (client `72952d9f`,
33 tool calls at `/workspace/mcp`): message 1 `search_drive_files` →
`get_spreadsheet`; 2 `read_sheet_records` + `find_sheet_rows`; 3
`search_drive_files` → `read_doc`; 4 `list_events`; 5 `get_spreadsheet`,
`find_sheet_rows`, `read_sheet_records`, `get_sheet_dropdown` (checked the
allowed values before writing, unprompted), `update_sheet_row`,
`append_sheet_rows`, then `read_sheet_range` read-backs; 6 `read_doc`,
`list_calendars`, `append_doc_text`; 7 `create_event` → `delete_event`; 8
`insert_sheet_dimension` → `delete_sheet_dimension` with `read_sheet_range`
before, between and after. No unrelated tool. Read-back: row 8 Status
"Interviewing" only; "Codex Test Co / Analyst / Applied" on row 23; row 9
still Tesla; "Reviewed by Codex." the last paragraph of Internet and in no
other tab; "Codex Sync" cancelled on the testing calendar; primary 30-day
count unchanged at 9. The string-or-number `before`/`start` schema, a
guess for Codex until now, worked. *Cursor* (client `fef67d65`):
`search_drive_files` → `get_spreadsheet`, answer correct per the owner.
*claude.ai and phone* (client `812666f2`, one registration for both):
`search_drive_files` → `get_spreadsheet`, answer correct per the owner.
Cursor's tool count as displayed was not recorded at the time — settled
the same day by the owner (all 35 listed), see "Still only a guess".

**Acceptance criteria not exercised by an agent here**, resting on earlier
evidence: a read-only token refused on a write tool
(`test/oauth-http.test.mjs`, "a read-only token is denied on a write
tool") and revocation on one endpoint leaving the other connection working
(`test/oauth-provider.test.mjs` revoke test plus Phase 2's live
cross-endpoint 401s). Neither was re-proven live in Phase 5.

**Four deploys** (`8baf670`, `eee4a38`, `204224a`, `ebebd0e`), `dist/` hash
parity each time, 500/500 tests. **Phase 5 complete 2026-09-20.**

## Phase 6 — what actually happened (2026-09-20)

**The removal gate was unreachable as written.** "Delete the alias once
`clients.sh list` shows no LEGACY client" assumed clients would re-consent
at some point. They never would: the alias made re-consent unnecessary, a
refresh token never expires, and Phase 2's refresh path deliberately left the
refresh-token record under the old names as evidence. On 2026-09-20 the list
still marked four mail clients LEGACY (Claude Code, claude.ai, Codex, Cursor),
each holding a `mail:read mail:write` refresh token that would have stayed
that way forever. Waiting was not an option; asking the owner to re-login
three or four clients was the alternative and was rejected as three
interruptions for nothing — the rewrite below is the same grant under its
current spelling (same client, same audience, same Google identity, nothing
widened).

**Migration first, alias deletion second**, so the running server tolerated
both spellings throughout:

1. `bash scripts/clients.sh migrate-scopes` added (`f48d55d`) in
   `scripts/lib/oauth-clients.cjs`, the one file that already knows the
   store idiom — dry run by default, `--yes` to write, every store read back
   and success refused if a retired name survived, never prints a token
   value (the store keys *are* the token values). Dry run on the VPS: 113
   access-token records and 4 refresh-token records carrying the old names.
   `--yes`: "Rewrote and verified: 117 record(s)". `list` afterwards: no
   LEGACY mark on any client. A real `get_labels` from Claude Code through
   the *old* build proved the rewritten access token passed the live gate.
2. Three token-less duplicate registrations revoked (`6d0a2831` Cursor,
   `39998425` Cursor, `857ce3cf` Claude — each a dry run showing one
   registration and zero tokens, codes or pending logins, then `--yes`).
   Eight remain: exactly one per client per endpoint. The Cursor mail
   registration `d5b74305` (last seen 2026-09-11) holds a live refresh token
   and was kept.
3. Alias deleted (`d31cdc0`): `normalizeScopes`/`isLegacyScopeName` gone
   from `src/http/scope-names.ts`, replaced by `dedupeScopes` and
   `allScopesSupported`. The three read points now **fail closed** instead
   of translating — a stored refresh token under any unsupported name is
   `invalid_grant`, a stored access token is a 401 with `WWW-Authenticate`
   (so the client refreshes, gets `invalid_grant`, and re-authorizes), and a
   client asking for the retired names at authorize gets `invalid_scope`
   before any Google redirect. Not passed through either: an access token
   minted under an unknown name would reach the tool gate and be denied at
   every `tools/call` while `initialize`/`tools/list` succeed — an
   apparently-connected client with no path back to consent. The Phase 2
   alias tests were replaced by pins for each refusal.
4. Independent adversarial review (separate subagent, read-only plus
   mutation testing): no path lets an unsupported name reach the tool gate
   or mint a token; `codes.json`/`pending.json` can only hold
   already-validated scopes; `InvalidGrantError` → HTTP 400 `invalid_grant`
   and `InvalidTokenError` → 401 with `WWW-Authenticate` are the signals a
   compliant client already recovers from. Mutation A (refresh guard
   removed) failed exactly one test — the request was still refused by
   `issueTokens`' second guard, but as `invalid_scope`, the wrong recovery
   signal. Mutation B (verifier guard removed) failed exactly one test, and
   there the request genuinely succeeded past auth: the verifier's guard is
   the *only* check on the access-token path, now said so in a comment.
   Three low findings fixed in `f37545b`: the RETIRED marker in `list` was
   untested and matched any `mail:`-prefixed name (a `mail:admin` record
   would have sent the operator to a command that does not touch it) — now
   matches exactly the two migrated names and is pinned; a store file
   holding valid JSON of the wrong shape fails by file name instead of a
   bare TypeError; a write failure between the two stores reports which
   store landed. 505/505 tests.
5. Deployed (`deploy.sh`, no warnings), `dist/*.js` sha256 identical
   local↔VPS (`9b4197f9…`), boot log `Mail: POST /mcp (23 tools)` and
   `Google Workspace: POST /workspace/mcp (35 tools)`, process restart count
   unchanged after the deploy. A real `search_emails` (Mail) and
   `list_calendars` (Workspace) from Claude Code both logged `oauth`/200
   with `scopes: [read, write]` on the new build. Every 4xx in the recent
   request log is the known connect-probe 400 or a GET 405, all timestamped
   before the deploy; no 401 for any client. `clients.sh list`: 0 RETIRED.

**Docs.** `README.md` rewritten for two endpoints (Workspace tool tables from
`endpoints.json`, client matrix, the four added Google scopes, `migrate-scopes`,
spec 002 as source of truth); `docs/machine-setup.md` step 4 and the public-
endpoints section updated with an onboarding matrix per client family;
`CLAUDE.md` invariant and scratchpad; the spec's scope paragraph; ADRs 016
and 017 amended in place (016 now records why the gate could not close and
the lesson: state a migration gate in terms of state the plan itself can
bring about); ADR index row.

**Left behind, deliberately:**
- Verification of the retired-name refusal is unit-level only: no live token
  carries a retired name any more, and planting one on the VPS to watch a
  real client re-authorize was judged not worth touching the store for.
- `tokens.json` accumulates expired access tokens (the 113 above were all
  dead pre-cutover tokens); ticket 007's sweep covers only `pending.json`
  and `codes.json`. Minor note in `docs/tickets/README.md`.
- `migrate-scopes` stays as a subcommand: idempotent, dry-run by default,
  and the fix if a pre-2026-09-20 backup of the oauth directory is ever
  restored. `clients.sh list` marks such a record RETIRED and names it.

**Plan 002 complete 2026-09-20.**

## Tool surface (as shipped 2026-09-19; names final — Phase 5 tunes descriptions, not names)

**Mail (23, unchanged):** as `tools-enabled.json` lists today.

**Google Workspace (35):**
Drive 8 — `search_drive_files`, `list_drive_folder`, `get_drive_file`,
`read_drive_file`, `create_drive_folder`, `update_drive_file`,
`trash_drive_file`, `upload_drive_file`.
Sheets 16 — `get_spreadsheet`, `read_sheet_range`, `read_sheet_records`,
`find_sheet_rows`, `get_sheet_dropdown`, `write_sheet_range`,
`append_sheet_rows`, `update_sheet_row`, `add_sheet_tab`, `rename_sheet_tab`,
`delete_sheet_tab`, `insert_sheet_dimension`, `delete_sheet_dimension`,
`format_sheet_range`, `add_sheet_chart`, `create_spreadsheet`.
Docs 5 — `read_doc`, `create_doc`, `append_doc_text`, `replace_doc_text`,
`insert_doc_text`.
Calendar 6 — `list_calendars`, `list_events`, `get_event`, `create_event`,
`update_event`, `delete_event`.

Not exposed on any endpoint: `share_drive_file`, `list_accounts`,
`begin_account_auth`, `finish_account_auth`, `get_signature`,
`docs_insert_table`, `docs_apply_style`, the attachment tools.

## Verification layers (the plan's contract with the spec)

| Layer | Proves | Runs where | Human? |
|---|---|---|---|
| `npm test` | Bytes and API calls the code produces, with fake Google clients; golden mail tool list; scope derivation; endpoint config validation; OAuth cross-endpoint rejection | MacBook, every change | No |
| Live harness | Every spec criterion that reads back through the API, from both accounts, on fresh copies | VPS, after every deploy | No |
| Agent runs | That an agent can find and use the tools from names + descriptions + instructions; cross-client | Claude Code, Codex, Cursor, claude.ai | Reviewer is an agent |
| Owner's eye | Header formatting, chart placement | Google UI | Yes — two items |

The spec's acceptance criteria and `docs/workspace-verification.md`'s task
lists are the same list stated twice. When they drift, the spec wins.

## Still only a guess — verify before relying on it

- ~~Whether the tamu Workspace account permits third-party Drive/Docs/Sheets/
  Calendar scopes.~~ **Settled 2026-09-19: it does.** All four granted, folder
  and both templates visible via sharing, Sheets/Docs/Calendar calls succeed.
- ~~Whether the four APIs are already enabled in `email-503620`.~~ **Settled
  2026-09-19: enabled** (the probe's calls succeeded from both accounts).
- ~~Whether Google's "unverified app" interstitial for the added restricted
  `drive` scope behaves exactly as it does for `mail.google.com`.~~ **Settled
  2026-09-19: same interstitial, all scopes granted, no refresh-token expiry.**
- The 60,000-character threshold for returning a tab index instead of text
  (Musings Copy is ~12,000 characters, so the index path has only unit
  coverage so far).
- `detectHeaderRow`'s "widest row in the first 20" rule (Phase 3). Right for
  the owner's tracker; a data row wider than its header would win. The
  output names the row and `header_row` overrides.
- ~~Cursor's 40-tool cap: forum-reported only.~~ **Observed 2026-09-20:**
  Cursor listed all 35 Workspace tools (owner). Whether a cap exists above
  that is still unobserved; 35 is fine.
- ~~Whether `drive.files.copy` of a spreadsheet preserves data-validation
  rules (needed for the dropdown checks on copies).~~ **Settled 2026-09-19:
  yes** — `get_sheet_dropdown` on a fresh copy matched the template, live.
- ~~`insert_sheet_dimension` / `delete_sheet_dimension` declare `before` /
  `start` as `type: ['string', 'number']`; Cursor and Codex unobserved.~~
  **Settled 2026-09-20:** Codex passed the union live (Phase 5, message 8).
  Cursor made no dimension call; its tools/list accepted the schema.
- Memory on the 1GB droplet when `extractText` runs OCR on a Drive PDF while
  the server is serving — the OCR binary already runs for mail attachments,
  so expected fine; watch `pm2` memory during harness runs.
