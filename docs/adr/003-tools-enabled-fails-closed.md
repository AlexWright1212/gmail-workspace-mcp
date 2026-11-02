# ADR 003 — The exposed-tool config fails closed (`tools-enabled.json`, now `endpoints.json`)

**Last edited:** 2026-09-19 (written 2026-08-18; amended 2026-09-19 for the move to `endpoints.json`)
**Status:** Accepted
**Origin:** ad hoc; amended under `docs/plans/002-google-workspace-endpoint.md`, Phase 1

**Where the rule lives today:** `endpoints.json` at the repo root, loaded by
`loadEndpoints()` in `src/endpoints.ts`. The 2026-08-18 sections below
describe `tools-enabled.json`, which that file replaced on 2026-09-19; the
rule is unchanged and stronger — see "Amendment" at the end.

---

## Context

This codebase is not really a Gmail server — it's a general Google Workspace MCP server (`package.json` describes it as "Multi-inbox Gmail, Drive, Sheets, Docs, and Calendar", internal name `ghub`). 60 tools are defined in `src/index.ts`; roughly 24 of them are Gmail tools, the rest are Drive/Sheets/Docs/Calendar. Git history shows this was deliberate: commit `2d52bdb` ("rename to ghub and add Drive, Sheets, Docs, Calendar tools") built the whole surface out, and a later commit `5ec2985` ("add bearer token auth, email-only tool allowlist, remove send tools") introduced `tools-enabled.json` specifically to scope the *exposed* surface back down to Gmail-only, without deleting the rest of the code.

That makes `tools-enabled.json` load-bearing in a way its name doesn't suggest — it's the entire difference between "Gmail-only server" and "full Workspace server with no restrictions." But `loadEnabledTools()` (`src/index.ts`) returned `null` on any failure to load or parse the file, and `isToolEnabled()` treated `null` as "every tool enabled." A missing file, a bad edit, a JSON syntax error, or a wrong shape (e.g. `enabled` not an array) would silently re-expose everything, including `share_drive_file` and `create_event` — tools that can reach arbitrary third-party email addresses via Google's own notification systems, entirely outside the Gmail send-allowlist.

## Options Considered

**Leave as-is, document as an accepted risk.** The file is deploy-controlled, not agent-editable, so the practical odds of it breaking were treated as low. Rejected — "low odds, high blast radius, easy fix" isn't a good reason to leave a fail-open switch on the one file guarding the boundary.

**Fail closed: any load failure yields an empty enabled set.** A missing/broken config means *no* tools are exposed rather than *all* tools.

## Decision

**Fail closed.** `loadEnabledTools()` now returns `Set<string>` (never `null`); any failure to read the file, parse it as JSON, or find a valid `enabled` array logs an error to stderr and returns an empty `Set`.

## Consequences

- A broken config now manifests as "nothing works" — loud, immediately obvious the first time any tool is called — instead of "everything works, including tools that shouldn't be reachable" — silent and dangerous.
- This alone does not close the deeper issue that `share_drive_file` / `create_event` / `update_event` had **no allowlist check of their own** — they were "safe" only because this one file switched them off. See `docs/adr/004-extend-allowlist-to-workspace-tools.md` for the belt-and-suspenders fix layered on top of this one.
- Two call sites in `src/index.ts` that previously branched on `ENABLED_TOOLS === null` were simplified to just check `.has()`, since the null case no longer exists.

## Pointers

- `src/index.ts`: `loadEnabledTools()`, `isToolEnabled()`.
- `test/workspace-allowlist.test.mjs`: `'loadEnabledTools source fails CLOSED, not open, on any load failure'` — a structural test against the compiled output (the same technique `test/send.test.mjs` uses for `deliver()`), since `src/index.ts` self-executes and can't be imported directly by tests.

## Amendment 2026-09-19 — `endpoints.json` replaces `tools-enabled.json`

### Why

Plan 002 turns the process into two MCP endpoints on one hostname — Mail at
`/mcp` and Google Workspace at `/workspace/mcp` — each exposing its own tool
list. One global enabled-set could no longer express "these tools here, those
tools there", so the config became per-endpoint. The property this ADR
protects did not change: a config that fails to load must be the *more
restrictive* failure. It is now more load-bearing, not less — the same file
that used to separate "Gmail-only" from "everything" now also separates the
mail surface from the Workspace surface, and the Workspace surface includes
tools that reach third parties (`share_drive_file`, `create_event`) which
ADR 004 gates separately and which stay unlisted on every endpoint.

### What changed

- `tools-enabled.json` (`{ "enabled": [...] }`) is deleted. `endpoints.json`
  maps an endpoint name to `{ "path", "tools": [...] }`; the order of `tools`
  is the order clients see in `tools/list`.
- **Fail closed is strengthened from "boot with no tools" to "refuse to
  boot".** `loadEnabledTools()` returned an empty set on any failure; that
  was loud enough when a single client would immediately find nothing works.
  With two endpoints, a server that came up with an empty list — or with one
  endpoint silently missing — would pass `deploy.sh`'s health check (it only
  asserts an unauthenticated 401) and look alive to every naive probe while
  serving nothing. `loadEndpoints()` therefore throws on a missing or
  unreadable file, invalid JSON, a malformed entry, a duplicate path, a tool
  name no module defines (a typo used to silently drop the tool), or an
  endpoint with no instructions text. `src/index.ts` calls it before binding
  a port, so pm2 reports the app down and `deploy.sh` catches it — the same
  reasoning ADR 013 applied to booting without OAuth.
- Scope classification (`read` vs `write`, ADR 013) no longer lives in a
  second hand-maintained map in `src/http/scopes.ts`. It is derived from
  `annotations.readOnlyHint` on each tool definition in `src/tools/*.ts`, so
  a tool cannot be listed on an endpoint while forgotten by the scope gate.
  A definition without the annotation fails a unit test and is denied at
  runtime — the same fail-closed shape, one level down.

### What else was considered

- **Keep `tools-enabled.json` and add a second file per endpoint.** Two
  files with two failure modes for one property; rejected.
- **Keep the empty-set behavior for a bad file.** Rejected for the
  health-check reason above: an empty tool list on a two-endpoint server is
  not reliably loud any more.

### Pointers

- `src/endpoints.ts`: `loadEndpoints()` — the only reader of `endpoints.json`.
- `src/tools/registry.ts`: `TOOL_REGISTRY` — every definition the file may name.
- `src/http/scopes.ts`: `scopeForTool()` — derives from the registry.
- `test/endpoints.test.mjs`: every refusal case above, each asserted to throw.
- `test/golden-mail-tools-list.test.mjs`: proves the restructure left the
  mail endpoint's `tools/list` and instructions unchanged.

