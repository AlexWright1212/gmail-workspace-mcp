# ADR 011 — What the server tells a model about accounts

**Last edited:** 2026-09-19 (written 2026-08-22; health-reporting decision added 2026-08-23; pointer updated for `endpoints.json` 2026-09-19)
**Status:** Accepted
**Origin:** `docs/tickets/004-no-real-account-health-check.md`

---

Two decisions about the same subject: what a caller learns about the two
accounts, and where it learns it. The first moved account *context* out of
parameter descriptions into the server's `instructions` field. The second
decided the server will not report account *health* at all.

## Part 1 — Account context belongs in the MCP `instructions` field

### Context

Every tool taking an `account` argument described it the same way: `Account id
("personal", "tamu")` — repeated verbatim across ~20 parameter descriptions. That
tells a caller the ids exist. It never says what they *mean*, which inbox holds
what, or that read and write tools default differently.

Investigating how Claude Code actually exposes this server (2026-08-22, live,
against v2.1.240-era behavior) turned up the reason that repetition was the wrong
shape:

- **Only tool *names* load into a model's context at session start.** Descriptions
  and schemas are deferred and fetched on demand. So context living in a parameter
  description arrives *after* the model has already chosen a tool — too late to
  inform which tool or account to pick.
- **A server's top-level `instructions` string is never deferred.** It loads at
  connection time, before any tool call, and it is the only author-written prose
  with that guarantee.

The field was unset. `docs/specs/001-email-tool.md:41-43` already requires resolving
informal references ("my tamu email") to the right id — behavior the server gave
the model no information to perform.

### Decision

Set `instructions` on the `Server` constructor (`SERVER_INSTRUCTIONS` in
`src/index.ts`), carrying what a caller needs *before* choosing a tool:

- What each inbox actually holds, and that the split is not clean — finance,
  housing and networking appear in both.
- **Reads should query both** unless the user names one; omitting `account` does
  this and merges results.
- **Writes require an explicit account** and error without one.
- The send allowlist is server-enforced and no phrasing lifts it.

Sized at 1566 bytes against Claude Code's 2KB truncation limit for this field.

### Alternatives considered

- **Expand each parameter description.** Pays the token cost once per loaded
  schema, and still arrives after tool selection. Strictly worse.
- **A Claude Code skill, or a note in global `CLAUDE.md`.** Works for one client.
  `docs/specs/001-email-tool.md:7` scopes this server to *any* MCP-over-SSE client, so
  client-specific context defeats a stated goal.
- **Put it in `list_accounts` output.** Requires the model to have already decided
  to call a tool, and to pick that one.

## Part 2 — The server reports no account health at all

### Context

`list_accounts` reported `Status: ready` for both accounts for two weeks while
every Gmail call returned `invalid_grant`. Not a wrong branch: `getAccountHealth()`
in `src/accounts.ts` computes `ready` as `enabled && credentialsFileExists &&
tokenFileExists`. It checks that two files are present on disk. It never touches
the Gmail API, so it never could report whether the tokens *inside* those files
still work. The tool's description promised "authentication/health status," which
is the part that misled.

The tool was removed from `tools-enabled.json` on 2026-08-22 as a consequence of
Part 1: once the account map lived in `instructions`, health status was the only
thing `list_accounts` still uniquely offered — and health status was the lie. The
handler and `getAccountHealth()` were left in source, dormant.

That left the real question open: **is a live health check worth building at
all?** `docs/tickets/004-no-real-account-health-check.md` argued it hinged on one
unverified thing — whether an aggregate read with one dead account surfaces that
clearly, or looks like "no results." A silent wrong answer is the worst failure
class in this project, and would have made the case strong.

### What is now known (checked 2026-08-23)

**Aggregate reads do not fail silently.** In `fetchMergedPage()` (`src/index.ts`)
every per-account fetch is wrapped individually; any throw becomes a named error
string (`"tamu: invalid_grant"`) and that account's paging position is held rather
than treated as exhausted. `formatEmailListOutput()` (`src/gmail-format.ts`) puts
those errors *first*, under `⚠️ Some accounts failed — these results are
INCOMPLETE`, and replaces the "no more results" line with an explicit statement
that the set is not complete. `test/organize.test.mjs` asserts the banner's
position.

Quieter paths — drafts, labels, Drive listings — render an `## Account Errors`
section without the banner, but still name the failing account and the reason.

**Verified by reading the code and its test, not against a live expired token.**
The next real expiry is free evidence: run one aggregate search before
re-authorizing. `docs/tickets/README.md`'s Minor list carries this gap.

**The recurring cause is gone.** The OAuth consent screen was in Testing when
this happened, which expires refresh tokens every 7 days. It is now In production.
Tokens can still die (revocation, password change, policy change), but not on a
weekly clock.

### Decision

**No account health reporting of any kind.** Specifically:

- `list_accounts` stays out of `tools-enabled.json` (since 2026-09-19: listed on no endpoint in `endpoints.json`). The handler and
  `getAccountHealth()` remain in source, dormant and unchanged.
- **No live health-check tool** (one real Gmail call per account, reporting true
  pass/fail).
- **No proactive monitoring** (a scheduled job on the VPS that pings both accounts
  and alerts the owner).

Reasoning, in the owner's framing (2026-08-23):

- **A health tool spends a call to learn what the next call reports anyway.** It
  would be invoked speculatively, before doing the actual work — and the actual
  work names the dead account a moment later. Doing the thing and reading the
  error is the cheaper path to the same fact.
- **Knowing earlier shortens nothing.** Recovery means `tools/reauth.mjs` on the
  VPS and a human clicking through Google's consent screen. That is the owner, by
  design; an agent cannot substitute for it. Earlier detection buys no agent
  autonomy.
- **Monitoring can be dead in exactly the case it exists for.** Any alert has to
  leave from one of the two accounts, so both-accounts-dead notifies nobody. The
  owner judged that limitation sufficient not to build it, preferring no mechanism
  over one that fails in its own worst case. The counter — cross-account alerting
  covers the far more likely single-account failure — was weighed and rejected as
  not worth the build.

### Alternatives considered

- **Re-enable `list_accounts` as-is.** Restores a green light wired to file
  existence. This is the option a future reader is most likely to reach for
  (it is one line); it is the option that caused the incident.
- **Fix `list_accounts` to check live.** See above — real cost, no earlier
  usable knowledge.
- **Scheduled monitoring with cross-account alerting.** The strongest rejected
  option, and the only one that helps for an inbox nobody is currently touching.
  Rejected on the reasoning above; if the "untouched inbox" case ever bites in
  practice, this is the thing to reconsider first.

## Consequences

- The ~20 `("personal", "tamu")` parentheticals are now redundant. Left in place
  for now — trimming them is a separate, mechanical change.
- **Takes effect only after the MCP client reconnects**, same caching behavior
  that hides newly added tools. Deploying alone is not enough.
- The inbox contents are owner-supplied, not inferred, and will drift as the
  owner's usage changes. This ADR is the place to record it if the framing
  changes; the spec describes *that* accounts are resolved, not *what* is in them.
- 2KB is a Claude Code limit measured on 2026-08-22, not a protocol guarantee.
  Other clients may differ.
- **A dead account is discovered at the point of use.** For an inbox left untouched
  for a long stretch — plausible for `tamu` between semesters — the token stays
  dead and unnoticed until something reaches for it. Accepted.
- The error paths carrying this decision are load-bearing now. Weakening the
  per-account `try` in `fetchMergedPage()`, or the errors-first ordering in
  `formatEmailListOutput()`, removes the only thing that reports a dead account.
  Both are the reason no health tool exists.
- Resolves `docs/tickets/004-no-real-account-health-check.md`.
- **2026-09-19 (plan 002 Phase 5):** the Workspace endpoint's aggregate reads
  (`search_drive_files`, `list_calendars`, `list_events`) now open with the
  same INCOMPLETE banner (`incompleteBanner()` in `src/tools/shared.ts`).
  They used to append a "## Account Errors" section after the results; with
  the tamu token deliberately removed, the agent under test did report the
  failure but called it "buried in a field you'd have to notice". The
  errors-first rule above is now load-bearing on both endpoints.
