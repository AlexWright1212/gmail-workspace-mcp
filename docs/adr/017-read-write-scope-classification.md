# ADR 017 — Read/write scopes derived from `readOnlyHint`, not a separate map

**Last edited:** 2026-09-19
**Status:** Accepted
**Origin:** `docs/plans/002-google-workspace-endpoint.md`, Phase 2 (classification mechanism); Phase 4 write set pinned by `test/workspace-endpoint.test.mjs`

---

## Context

ADR 016 gave the server two protected resources, Mail and Google Workspace,
each accepting its own token audience. That still left one question ADR 016
deliberately did not answer: once a client can hold a token for either
endpoint, what does the token's *scope* mean, and where does the server keep
the fact that a given tool needs it?

Before Phase 1, scope classification lived in a hand-maintained
`TOOL_SCOPES` map inside `src/http/scopes.ts` — a second place, separate
from each tool's schema, that could name a tool wrongly or not at all
without either file failing to build.

## Options considered

**Keep mail-specific scope names (`mail:read`/`mail:write`) and add
`workspace:read`/`workspace:write`.** Rejected: a token already names its
endpoint through its audience (ADR 016), so an endpoint prefix on the scope
name carries no information the audience doesn't already carry, and it
doubles the vocabulary the consent page has to explain to a human for no
gain.

**Per-tool scopes** (e.g. a `sheets:write` distinct from `docs:write`).
Rejected: no client surfaces scope selection at that granularity, and the
spec's `read`/`write` split ("look, but never change anything") is the only
distinction anything downstream can act on.

**Scope-filtered tool lists as the only mechanism** — one endpoint, and a
`workspace` scope decides which tools appear in `tools/list`. Rejected in
the plan itself, not re-litigated here: clients cannot choose scopes in
their UI, they can choose URLs, which is why two endpoints exist at all
(ADR 016).

## Decision

Two scopes, `read` and `write`, defined once in `src/http/scope-names.ts`
and shared by the authorization server and the per-tool gate
(`src/http/scopes.ts`). `read` forbids every mutation, including creating a
draft, a Doc, a Sheets tab, or a Calendar event — there is no
partially-safe write. A client that requests no particular scope is granted
both, unchanged from pre-Phase-2 behavior.

**Classification lives on the tool definition itself**
(`annotations.readOnlyHint`, set beside each tool's schema in
`src/tools/*.ts`), not in a separate map — `scopeForTool()` in
`src/http/scopes.ts` just reads it back out of `TOOL_REGISTRY`. A
definition without a boolean `readOnlyHint` is denied to every OAuth caller
at runtime (`assertToolScopeAllowed`, fail closed, same posture as ADR 003)
and fails `test/registry.test.mjs` at build time — the two enforcement
points cannot drift apart because they read the same field.

The old `mail:read`/`mail:write` names were retired in two steps. On cutover
day an alias in `src/http/scope-names.ts` mapped them to `read`/`write` at
the three points a stored or requested scope list is read — `authorize`,
refresh, and the per-endpoint verifier — so every refresh token live on the
VPS kept working with no re-consent. On 2026-09-20 (plan 002 Phase 6) the
stored records were rewritten in place by `bash scripts/clients.sh
migrate-scopes --yes` and the alias deleted; the three read points now refuse
any name outside the two (ADR 016, "What's now known").

## What's now known

Existing clients converged on the new scope names at their first token
refresh, with no re-consent and no visible interruption — the rename was
invisible in practice, which the spec did not assume going in.
`test/workspace-endpoint.test.mjs` pins that the 22 Phase 4 write tools are
exactly the set with `readOnlyHint: false` on `/workspace/mcp` — a tool
misclassified in either direction now fails a test, not just a read.

## Consequences

- Adding a tool to either endpoint requires no scope-map edit: forgetting
  `annotations.readOnlyHint` is caught by `test/registry.test.mjs`, not
  discovered live.
- `read` and `write` mean the same thing on both endpoints — a client
  holding `read` at Workspace and `write` at Mail (or any other
  combination) is expressing two independent grants, not a stronger and
  weaker version of one scope.
- There is exactly one spelling of each scope. A stored record under any
  other name is refused at the point it is read, never translated — the
  alias that did that is gone and is not to come back as a fallback.

## Pointers

- `src/http/scope-names.ts` — `READ_SCOPE`, `WRITE_SCOPE`, `dedupeScopes()`, `allScopesSupported()`.
- `src/http/scopes.ts` — `scopeForTool()`, `assertToolScopeAllowed()`.
- `src/tools/registry.ts`, `test/registry.test.mjs` — where `annotations.readOnlyHint` is required per tool.
- `test/workspace-endpoint.test.mjs` — pins the Phase 4 write-tool set against `readOnlyHint`.
- `docs/adr/016-two-endpoints-one-authorization-server.md` — the audience/resource half of the same OAuth change; this ADR covers the scope-vocabulary half.
- `docs/plans/002-google-workspace-endpoint.md`, "Decisions already made by the owner" (Scopes row) and Phase 2.
