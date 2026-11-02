# ADR 015 — Per-client accountability: request log and `clients.sh`

**Last edited:** 2026-08-30
**Status:** Accepted
**Origin:** `docs/plans/001-remote-access-migration.md`, Phase 3

---

## Context

Phases 0–2 made the server reachable from anywhere and gave it a real OAuth 2.1
authorization server. That changed a question from theoretical to operational.

Before OAuth there was exactly one credential — the shared bearer token — and
exactly one meaningful revocation action: rotate it, which disconnects
everything at once. That was tolerable when the only client was Claude Code on
the owner's own laptop, over a tailnet nobody else could join.

It stopped being tolerable the moment multiple independent clients existed. As
of 2026-08-29 three do: Claude Code (`gmail-remote`), claude.ai (and therefore
the phone), and the ChatGPT desktop app's Codex host. Each holds its own
access and refresh tokens against the owner's live inbox. Two questions had no
answer:

- **"Which client did this?"** Nothing recorded who made a request. A tool call
  that archived the wrong thread, or a burst of activity from a machine the
  owner no longer trusts, was untraceable.
- **"Can I cut off just that one?"** The OAuth stores live under
  `/root/.gmail-multi-mcp/oauth/` — deliberately outside the repo, alongside
  credentials the agent is fenced away from. Revoking one client meant hand-
  editing JSON next to the token files, which is exactly the neighbourhood the
  fence exists to keep agents out of.

The plan (`docs/plans/001-remote-access-migration.md`, Phase 3) called for both
as prerequisites to onboarding outside clients, on the grounds that revocation
should be targeted rather than global *before* the client list grows.

## Options Considered

**For the log:**

- **Reuse `send-audit.log`.** Rejected: that file is the send-boundary's
  record, tied to `assertSendAllowed()` and the final MIME bytes. Mixing
  general HTTP traffic into it would dilute the one artifact whose job is
  narrow and legible, and it would grow far faster.
- **Log inside each tool handler.** Rejected: 62 dispatch cases, each an
  opportunity to forget. One middleware at the HTTP boundary cannot be
  forgotten by a new tool.
- **Log every request including 401s.** Not chosen for now — see Consequences.
- **A real database.** Rejected: nothing else here uses one, and JSONL beside
  the existing JSON stores matches the codebase's existing idiom.

**For revocation:**

- **An MCP tool that revokes clients.** Rejected outright. A tool is reachable
  by any authorized client, which means a compromised or confused client could
  revoke the others, or itself, over the same channel an attacker already has.
  Revocation must live on the operator's side of the boundary.
- **Hand-editing the JSON over SSH.** Rejected: it puts an agent in the same
  directory as `accounts.json` and the token files, for a routine operation.
- **A wrapper script that reaches the stores through `scripts/vps.sh` and
  prints only non-secret fields.** Chosen — the same carve-out shape as ADR
  010: give the narrow, specific capability rather than widening access.

## Decision

Two pieces, both landed 2026-08-30.

**`src/http/request-log.ts`** — an append-only JSONL log beside
`send-audit.log`, one line per **authenticated** `/mcp` request, recording
client id, auth method (`oauth` vs legacy `bearer`), granted scopes, HTTP
method/path/status, and the JSON-RPC method plus tool name.

It records **no secrets of any kind** — no access or refresh token, no
authorization code, no `code_verifier`/`code_challenge`, no client secret, no
SSE session id. The session-id exclusion is deliberate and specific: those ids
travel in query strings, so anything logging full URLs (including Cloudflare)
would capture them, and possession of one injects JSON-RPC into an
already-authenticated session.

Tool-name granularity comes from wrapping `transport.onmessage` — objects the
SDK has *already* parsed off the stream. **No body parser is mounted on
`/mcp`, and none may ever be:** the Streamable HTTP transport reads the raw
request stream, and mounting `express.json()` makes `/mcp` hang or see an
empty body.

**`scripts/clients.sh`** (logic in `scripts/lib/oauth-clients.cjs`) — `list`
and `revoke <client_id>`, reaching the VPS only through `scripts/vps.sh`.
`revoke` purges the client registration, its access tokens, its refresh
tokens, and any in-flight authorization codes or pending authorizations, then
reads state back rather than trusting an exit code.

### Three sub-decisions worth their own reasoning

**Never block a request, but also never lose a record — resolved, not traded.**
Logging happens on `res.on('finish')`, so it can never delay or fail a reply.
The first implementation made that fire-and-forget, and *nothing awaited the
write*. This was not merely untidy: `pm2 restart` — i.e. **every deploy** —
sends SIGTERM, and `process.exit(0)` could run with writes still queued,
silently dropping the log's most recent entries. It surfaced as a ~25% flaky
test under full-suite load, which is the only reason it was caught before
shipping.

Fixed by routing writes through a per-path promise chain modeled on
`JsonRecordStore.serialized()` in `src/http/oauth/store.ts` — the same pattern,
not a third invention — with `flush()` awaited during `close()`. Concurrent
interleaving was measured and ruled out as a separate corruption risk (100
concurrent appends, 0 corrupt lines: POSIX `O_APPEND` is atomic at these
sizes). Loss came purely from nothing awaiting.

**`fsync` durability was deliberately not added.** The residual — a hard crash
between the OS accepting a write and it reaching disk — is identical to what
`send-audit.log` already accepts, and guaranteeing more here than the send
boundary guarantees would be incoherent. What is now closed is the orderly
shutdown case, which is what every deploy is.

**Hostile characters in CLI output are escaped, not deleted.** `client_name`
is attacker-controlled: registration is open DCR by design (ADR 013), and the
field is unvalidated free text. Printed raw, it can carry terminal escape
sequences that clear the screen, retitle the terminal, or scroll a real entry
out of view — in the one tool whose entire purpose is being *the trustworthy
view of who is connected*.

The first fix stripped C0 and DEL. Adversarial re-verification defeated it in
three ways that use no C0 byte at all: U+202E RIGHT-TO-LEFT OVERRIDE (renders
`evil-client-<RLO>txt.exe` as `evil-client-exe.txt`, the standard malware
filename-spoofing trick), U+2028 LINE SEPARATOR (fabricates what looks like a
second entry), and U+009B (single-byte C1 CSI).

The range now also covers C1, bidi controls, isolates, and zero-width
characters — and each disallowed code point is rendered as a visible
`<U+XXXX>` marker rather than removed. Deletion would turn the hostile name
into `evil-client-txt.exe`: still misleading, with no trace that anything was
removed. An audit tool should show that a name contained something hostile,
not merely be immune to its effect. Legitimate non-ASCII (accents, CJK, emoji,
punctuation) is verified to pass through code-point-for-code-point unchanged.

## What's Now Known

Established empirically during implementation and two independent adversarial
review passes, not assumed:

- **Revocation is genuinely effective, not cosmetic.** The decisive question
  was whether the running server caches the OAuth JSON stores — if it did,
  revoking would do nothing until a restart. Verified against a live server
  with **no restart**: a working token went `200` → `401 invalid_token`, and a
  refresh exchange went to `400 invalid_client`. `JsonRecordStore` re-reads
  from disk per call.
- **Shutdown cannot hang or reject on a failing log path.** With `logPath`
  pointed at an unwritable location, requests still completed in 1–20ms and
  `close()` returned cleanly. A dead disk cannot wedge `pm2 restart`.
- **The shell-injection chain holds.** Six hostile `client_id` payloads
  (command substitution, backticks, quote breakout, newline injection,
  leading-`--yes` argument injection) all arrived as inert single argv strings
  through `printf %q` and the two-hop ssh composition.
- **The suite could not previously catch the plan's most-warned-about
  regression.** Every `/mcp` test drove the SDK client, which posts pre-parsed
  bodies — precisely the test shape the plan warns will pass while a body
  parser is silently breaking the endpoint. `test/mcp-raw-socket.test.mjs` now
  hand-builds an HTTP request over a TCP socket, and was confirmed to **fail**
  when `express.json()` is mounted on `/mcp`.

## Consequences

- Test count 264 → 282. No fenced file was touched.
- The log is mode `0600`, matching `send-audit.log`. `mode` is set on the
  `appendFile` that creates it; an existing file's mode is deployment's job.
- **The log records only authenticated requests.** The middleware mounts after
  the auth gate, so a 401 never reaches it. This is correct for
  accountability — an unauthenticated request has no client to attribute — but
  it means the log is **not** an intrusion-detection surface, and repeated
  failed auth attempts are invisible to it. `[ghub] HTTP <method> <path>` in
  the pm2 log is the only record of those. Revisit if the threat model shifts
  from "which of my clients did this" to "who is knocking".
- **No rotation or reaping.** Matches `send-audit.log`'s existing choice. The
  file grows unboundedly over a long uptime; at personal scale this is disk
  hygiene, not a live problem.
- **An accepted race:** `clients.sh`'s read-modify-write is a separate OS
  process from the live server's in-process write queue, so a `revoke` racing
  a token refresh for the same client could in principle interleave. 25
  deliberate racing trials failed to demonstrate it. Documented in the
  script's own comments and in `docs/tickets/README.md`'s Minor list, accepted
  at this scale rather than solved with cross-process locking.
- Revocation remains **operator-side only** — there is deliberately no MCP tool
  that can revoke a client, and adding one would undo this ADR's reasoning.

## Pointers

- `src/http/request-log.ts` — the log, its write queue, and `flush()`
- `createRequestLog` mounted in `src/http/server.ts`, after the auth gate
- `recordRpcEvent` / the `transport.onmessage` wrapper in `src/http/transports.ts`
- `scripts/clients.sh`, `scripts/lib/oauth-clients.cjs` (`sanitizeForTerminal`)
- `test/request-log.test.mjs`, `test/oauth-clients-cli.test.mjs`,
  `test/mcp-raw-socket.test.mjs`
- ADR 010 (the carve-out shape this follows), ADR 013 (the OAuth server whose
  clients this manages)
