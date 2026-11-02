# Gmail MCP Server

Built on Tyler Szakacs's open-source Gmail multi-inbox MCP server ([tszaks/ghub](https://github.com/tszaks/ghub), MIT; see `LICENSE`), extended here with remote OAuth access, the Google Workspace endpoint, the send allowlist and per-client accountability. Hostnames, addresses and the owner's accounts are placeholders.

A self-hosted MCP server, reachable from anywhere over one hostname carrying two authenticated Streamable HTTP endpoints: **Mail** (two Gmail inboxes) and **Google Workspace** (Drive, Sheets, Docs, Calendar over the same two accounts). Any AI client that speaks MCP over HTTP with OAuth can connect to either — Claude Code, claude.ai and the Claude mobile apps, Codex, Cursor.

**Endpoints (placeholder host):** `https://mcp.example.com/mcp` (Mail) and `https://mcp.example.com/workspace/mcp` (Google Workspace) — both public; see [Connecting a New Client](#connecting-a-new-client)  
**Auth:** OAuth 2.1, issued by this server's own authorization server after a Google login restricted to the owner's two addresses. Each client registers separately per endpoint and holds its own revocable token, scoped `read` and/or `write` — there is no shared secret to copy, and a token issued for one endpoint is refused at the other.

---

## What This Does

**Mail** (`/mcp`) gives AI agents read access to two Gmail accounts — personal and Texas A&M — plus inbox organization, draft composition, and **sending restricted to a hard allowlist**.

**Google Workspace** (`/workspace/mcp`) gives AI agents read and write access to Drive, Sheets, Docs, and Calendar across the same two accounts: finding and reading files, editing spreadsheets and documents, and managing calendar events. See [Available Tools](#available-tools) for the full list.

**Accounts (both endpoints):**
- `personal` → `ownerpersonal@gmail.com`
- `tamu` → `owner_school@tamu.edu`

---

## The Send Boundary

Sending is enabled, but the server will only deliver to addresses on an explicit allowlist (seeded with the owner's own two addresses). This is the security property the whole design turns on, so it is worth being precise about how it works.

**Where the check happens.** `src/allowlist.ts` exposes `assertSendAllowed()`. It is called from exactly one place: `GmailAccountClient.deliver()` in `src/gmail-client.ts`, which is the only method in the codebase containing a `users.messages.send` or `users.drafts.send` call. The gate is that method's first statement. A recipient that is not allowlisted is refused before any network request is made.

**What the check reads.** Not the caller's arguments — the **final MIME bytes** destined for the Gmail API `raw` field. A critic pass demonstrated a live parser-differential attack where `to: "alex@gmail.com\r\nBcc: evil@example.com"` was rewritten by nodemailer's address parser into RFC 5322 group syntax, leaving the attacker as the only real recipient while an argument-checking allowlist would have read "alex@gmail.com" and waved it through. Checking the bytes that actually leave removes the representation gap. `src/compose.ts` also rejects that input, but the boundary does not depend on two parsers agreeing forever.

**`send_draft` re-reads the draft.** Drafts can be created in one session and sent in another, or edited in Gmail in between. `sendDraft()` fetches the draft with `format='raw'` and gates on those bytes. Nothing recorded at creation time is trusted.

**Config location — outside the repo, read-only to the agent:**

```
/root/.gmail-multi-mcp/send-allowlist.json     # { "allowed": [ ... ] }, mode 0400
/root/.gmail-multi-mcp/send-audit.log          # one JSON line per decision, allow and deny
```

That is the same directory as `accounts.json`, and the filename is fixed rather than configurable. **No tool exposed by this server can read, edit, reload, or report-then-modify the allowlist.** Widening it is an SSH-and-edit-the-file task, deliberately.

Failure modes all deny: missing file, unreadable file, malformed JSON, wrong shape, empty list, and a message whose recipients cannot be parsed all raise rather than sending. Addresses are normalized before comparison (Gmail dot/plus-tag equivalence for `gmail.com`; plus-tags only for Workspace domains such as `tamu.edu`, where dots are significant), so a cosmetic variant cannot be used to walk around the list — and a plus-tagged variant of an approved address is correctly allowed, since it still reaches the owner's mailbox.

---

## Connecting a New Client

Both endpoints are public and there is **no token to paste**. A client registers itself per endpoint, you complete a Google login (only the owner's two addresses are accepted) and a consent screen naming the endpoint being authorized ("Mail" or "Google Workspace"), and it stores its own token. A client that wants both connects twice — one registration per endpoint, each scoped `read` and/or `write`.

- **URLs:** `https://mcp.example.com/mcp` (Mail), `https://mcp.example.com/workspace/mcp` (Google Workspace)
- **Transport:** Streamable HTTP
- **Auth:** OAuth 2.1 — discovered automatically from the 401's `WWW-Authenticate` header

**Claude Code:**
```bash
claude mcp add --transport http gmail-remote     https://mcp.example.com/mcp
claude mcp add --transport http google-workspace https://mcp.example.com/workspace/mcp
```
then run `/mcp` and authenticate in the browser, once per endpoint.

| Client family | How to connect | Notes |
|---|---|---|
| Claude Code | `claude mcp add` (above), then `/mcp` per endpoint | — |
| claude.ai / Claude mobile apps | Add each URL as a custom connector in the client's own UI, same browser flow | One registration per endpoint covers both web and phone |
| Codex | Add each URL as a custom connector in Codex's own UI, same browser flow | Adding a connector in the ChatGPT *desktop* app configures Codex, not ChatGPT chat — switch the app to Codex mode |
| Cursor | Add each URL as a custom connector in Cursor's own UI, same browser flow | — |
| ChatGPT chat | **Cannot connect** — nothing server-side fixes this | Custom MCP in regular ChatGPT chat needs OpenAI's Developer Mode, not offered on Plus |

Adding or renaming a tool requires the client to reconnect — the tool list is cached at connect time.

After connecting, confirm the new client appears by name in `bash scripts/clients.sh list`. To cut one off: `bash scripts/clients.sh revoke <client_id>`, effective immediately with no restart.

No other configuration is needed — the server handles multi-account routing internally. Tools that take an `account` parameter accept `"personal"` or `"tamu"`.

> The legacy Tailscale-only `/sse` endpoint and its shared bearer token were **deleted on 2026-08-30**. Nothing answers on `/sse`. Tailscale is now purely the SSH/admin path. See [ADR 007](docs/adr/007-tailscale-only-sse-endpoint.md) (amended), [ADR 012](docs/adr/012-public-streamable-http-via-cloudflare-tunnel.md), [ADR 013](docs/adr/013-self-hosted-oauth-google-upstream.md).

---

## Available Tools

23 tools on the Mail endpoint (`/mcp`), and 35 tools (13 read + 22 write, Drive/Sheets/Docs/Calendar over both accounts) on the Google Workspace endpoint (`/workspace/mcp`). `endpoints.json` is the ground truth for which tools each endpoint exposes and in what order. Mail tools:

| Tool | What it does |
|------|-------------|
| `read_emails` | Read emails from inbox |
| `search_emails` | Search by query string |
| `get_email_thread` | Fetch full thread |
| `get_labels` | List Gmail labels |
| `mark_as_read` | Mark emails read |
| `label_messages` | Apply labels |
| `unlabel_messages` | Remove labels |
| `label_thread` | Apply labels to every message in a thread |
| `unlabel_thread` | Remove labels from every message in a thread |
| `archive_emails` | Archive emails |
| `trash_emails` | Move to trash |
| `create_label` | Create a new label |
| `delete_label` | Delete a label |
| `block_sender` | Block a sender |
| `list_blocked_senders` | List blocked senders |
| `unblock_sender` | Unblock a sender |
| `mute_thread` | Mute a thread |
| `create_draft` | Create a draft (does not send) |
| `send_message` | **Compose and send** — allowlisted recipients only |
| `send_draft` | **Send an existing draft** — re-checked against the allowlist |
| `delete_drafts` | Delete drafts |
| `list_drafts` | List drafts |
| `search_drafts` | Search drafts |

### Composition notes

- **Body is plain text, never HTML.** `create_draft` and `send_message` take one `body` string in a small markdown-ish dialect (blank line = paragraph, `-`/`1.` = lists, `[text](url)` links, `**bold**`). Both the `text/plain` and `text/html` MIME parts are derived from that one string, so they cannot disagree, and `<`/`>`/`&` render literally. This is what fixed the original draft-vs-sent line-break bug: `multipart/alternative` with both parts present and `quoted-printable` forced on each.
- **Signatures are not inserted.** Gmail signature reuse was disabled 2026-08-17: the API only exposes a signature set as the account *default*, and setting a default makes Gmail auto-insert it into every compose in the web UI. `get_signature` is listed on no endpoint in `endpoints.json`, and `include_signature` is out of every tool schema; the code path is intact and dormant. Write a plain sign-off in the body instead. See [ADR 005](docs/adr/005-disable-gmail-signature-reuse.md).

### Google Workspace tools (`/workspace/mcp`)

Drive, Sheets, Docs and Calendar over both accounts. Writes report what Google confirms, not what was asked; a lapsed Google authorization for one account is named at the point of use and the other account keeps working (ADR 011).

**Drive (8)**

| Tool | What it does |
|------|-------------|
| `search_drive_files` | Find files by name or content, both accounts unless one is given, newest first |
| `list_drive_folder` | List a folder's direct contents, newest first |
| `get_drive_file` | Metadata for one file — name, type, size, parents, owners, link |
| `read_drive_file` | Read a file's text — Doc as Markdown, PDF/Office extracted, Sheet points to the Sheets tools |
| `create_drive_folder` | Create a folder, optionally inside a parent |
| `update_drive_file` | Rename and/or move a file |
| `trash_drive_file` | Move a file to trash (recoverable) |
| `upload_drive_file` | Upload a file from the server's own outbox; called with no `path`, lists what is waiting there |

**Sheets (16)**

| Tool | What it does |
|------|-------------|
| `get_spreadsheet` | List a spreadsheet's tabs and sizes |
| `read_sheet_range` | Read a tab as a raw grid, addressed by row number and column letter |
| `read_sheet_records` | Read a tab as header-keyed rows, each with its sheet row number |
| `find_sheet_rows` | Find the rows where one column matches a value |
| `get_sheet_dropdown` | Read the dropdown/validation rule on a cell or range |
| `write_sheet_range` | Overwrite exactly one range of cells |
| `append_sheet_rows` | Add rows after the last row of data, aligned to the table's first header column |
| `update_sheet_row` | Change named columns of one existing row by header name |
| `add_sheet_tab` | Add a new tab, optionally with a header row |
| `rename_sheet_tab` | Rename a tab |
| `delete_sheet_tab` | Permanently delete a tab and its contents |
| `insert_sheet_dimension` | Insert blank rows or columns before a given position |
| `delete_sheet_dimension` | Permanently delete rows or columns |
| `format_sheet_range` | Apply bold, italic, color, alignment, number format, or wrap to a range |
| `add_sheet_chart` | Create a chart from a data range |
| `create_spreadsheet` | Create a new spreadsheet, optionally into a Drive folder |

**Docs (5)**

| Tool | What it does |
|------|-------------|
| `read_doc` | Read a Doc as Markdown, every tab, each labelled with its `tab_id` |
| `create_doc` | Create a new, empty Doc |
| `append_doc_text` | Add a new paragraph at the end of one tab |
| `replace_doc_text` | Find and replace every occurrence of a phrase throughout one tab |
| `insert_doc_text` | Insert or replace text at a heading or a unique passage, never a character position |

**Calendar (6)**

| Tool | What it does |
|------|-------------|
| `list_calendars` | List the calendars each account can see, with ids and time zones |
| `list_events` | List/search events in a time window; sweeps every calendar shown in the sidebar by default, naming each event's calendar |
| `get_event` | Full details of one event |
| `create_event` | Create an event — attendees limited to the owner's own addresses |
| `update_event` | Change fields of an existing event — same attendee restriction |
| `delete_event` | Delete an event (recoverable) |

---

## Owner-Only Server Scripts

Not MCP tools. Run these over SSH on the VPS from `/root/gmail-multi-inbox-mcp/`.

| Script | Purpose |
|--------|---------|
| `node tools/reauth.mjs <account>` | Print the OAuth consent URL for one account. Re-run as `node tools/reauth.mjs <account> <code>` with the `code` from the redirect URL to exchange it and write the token. Requests only the scopes the spec needs, unlike the in-server onboarding tool (which is blocked). |
| `node tools/raw-mime.mjs <account> <messageId>` | Dump the **raw delivered MIME** of a message. Also `--headers-only`, `--part=N`, `--search "<query>" [--limit=N]`, `--draft <draftId>`. Neither our MCP tools nor Anthropic's Gmail connector expose raw MIME, which makes the whole draft-vs-sent divergence bug class invisible to both — every fidelity claim in this project is verified with this script against a real delivered message. |
| `node tools/workspace-probe.mjs` | Can each account reach Drive, Sheets, Docs and Calendar? Real calls, per account, fails loudly. Run it from the laptop as `bash scripts/vps.sh 'node tools/workspace-probe.mjs'`. |
| `node tools/live/workspace-check.mjs --phase read\|write\|all` | The live Workspace harness against real Google, both accounts: reads checked against independent read-backs; writes as copy → mutate → read back → trash. `--keep` keeps the copies, `--account <name>` restricts to one, `--sweep` trashes `zz-test-*` leftovers. `tools/live/inspect-fixtures.mjs` dumps the fixtures' structure. |

---

## Infrastructure

**VPS:** DigitalOcean, NYC1 region, Ubuntu 24.04, ~$6/month  
**IP:** `100.64.0.10` (tailnet — the only address that answers). The public IP `203.0.113.10` is recorded here for provider-console purposes only; the VPS has **zero publicly-reachable inbound ports**  
**Code on server:** `/root/gmail-multi-inbox-mcp/`  
**Process manager:** pm2 (`gmail-mcp` process, starts on boot)  
**Runtime:** Node 24

---

## SSH Access

**Agents — use the wrapper, not raw `ssh`:**
```bash
bash scripts/vps.sh 'pm2 list'
bash scripts/vps.sh 'grep -c label_messages dist/index.js'
```
It supplies the key, starts in the deployed repo directory, and is allow-listed
in `.claude/settings.json` so it runs without a prompt.

**The key:** `~/.ssh/mcp_deploy_key` (passwordless ED25519, comment
`macbook-deploy-20260817`); its public half is in `/root/.ssh/authorized_keys`
on the server. Raw invocation, if you need it:
```bash
ssh -i ~/.ssh/mcp_deploy_key root@100.64.0.10
```

**`ssh root@203.0.113.10` does not work, and the reason changed.** Since
2026-08-30 port 22 is closed to the public internet, so that command now
**times out** — a real firewall block. Before then it failed with
`Permission denied (publickey)`, which was *not* a security block: the deploy
key is not one of the default filenames (`id_rsa`, `id_ed25519`, …) that `ssh`
checks, and no default-named key exists on this MacBook, so a bare invocation
simply offered nothing. Both failure modes point at the same fix — use
`scripts/vps.sh`, or pass `-i` and the tailnet address. A machine must be
joined to the tailnet to reach the VPS at all.

If Tailscale ever dies on the VPS, the only way in is DigitalOcean's web
console with the root password (owner's password manager). That is not a
network exposure: `sshd` has `passwordauthentication no`.

---

## Gmail OAuth

**GCP Project:** `email-503620`  
**OAuth app type:** Desktop app, **published to production** (not "Testing", so refresh tokens do not expire after 7 days)  
**Scopes granted:** mail scopes since the start; Drive, Sheets, Docs and Calendar scopes were added for both accounts in plan 002 Phase 0 (2026-09-19) to bring up the Google Workspace endpoint.

| Scope | Needed for |
|-------|-----------|
| `https://mail.google.com/` | messages, threads, drafts, labels, modify — **and send** |
| `gmail.settings.basic` | `sendAs` signatures (`get_signature`), filters (`block_sender`) |
| `drive` | Drive search/read/create/move/trash (restricted scope, same "unverified app" interstitial as `mail.google.com`) |
| `spreadsheets` | the Sheets tools on the Google Workspace endpoint |
| `documents` | the Docs tools on the Google Workspace endpoint |
| `calendar` | the Calendar tools on the Google Workspace endpoint |
| `openid`, `userinfo.email` | identify which account actually consented |

There is no separate "send scope" to withhold: `mail.google.com` is a single full-access scope that includes sending. **The restriction on who can be sent to is enforced by this server's allowlist, not by OAuth** — see [The Send Boundary](#the-send-boundary). The first six rows are `GOOGLE_ACCOUNT_SCOPES` (`src/gmail-client.ts`); `tools/reauth.mjs` requests that full list plus the two identity scopes.

**Credential files on server:**
```
/root/credentials.json                                     # OAuth client credentials
/root/.gmail-multi-mcp/accounts/personal/credentials.json
/root/.gmail-multi-mcp/accounts/personal/token.json        # Access token (personal)
/root/.gmail-multi-mcp/accounts/tamu/credentials.json
/root/.gmail-multi-mcp/accounts/tamu/token.json            # Access token (tamu)
```

**If a token expires or becomes invalid:**
```bash
ssh -i ~/.ssh/mcp_deploy_key root@100.64.0.10
cd /root/gmail-multi-inbox-mcp
node tools/reauth.mjs personal            # prints a consent URL
# open it, consent; the browser lands on http://localhost/?code=... and fails to
# load (nothing is listening) — that is expected. Copy the `code` value.
node tools/reauth.mjs personal "<code>"   # exchanges it and writes token.json
pm2 restart gmail-mcp
```
No MCP tool can re-authorize an account; this is an owner task on the server.

---

## Who Is Connected, and Cutting One Off

There is no shared token to find. Each client holds its own OAuth token, and the tools for inspecting that print no secrets:

```bash
bash scripts/clients.sh list                        # every registered client, by name
bash scripts/clients.sh revoke <client_id>          # kill one client's tokens (--yes to confirm)
bash scripts/clients.sh migrate-scopes              # rewrite stored mail:read/mail:write tokens to read/write (--yes to confirm)
```

Revocation takes effect immediately, with no restart, and affects only that client. See [ADR 015](docs/adr/015-per-client-accountability.md).

---

## Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `.env` | Server only (not in git) | `PUBLIC_URL` and the Google login client credentials. **Required** — the server refuses to start the HTTP transport without them, since OAuth is the only way a client can authenticate |
| `ecosystem.config.cjs` | This repo | pm2 process config (reads `.env`) |
| `endpoints.json` | This repo | Which tools each endpoint exposes, in wire order (read at boot; a malformed file refuses to start) |
| `accounts.json` | Server: `/root/.gmail-multi-mcp/accounts.json` | Gmail account definitions (not in git) |
| `send-allowlist.json` | Server: `/root/.gmail-multi-mcp/send-allowlist.json` | **Who this server may send to.** Mode 0400, outside the repo, no tool can write it |
| `send-audit.log` | Server: `/root/.gmail-multi-mcp/send-audit.log` | One JSON line per send decision, allowed and denied |
| `oauth/` | Server: `/root/.gmail-multi-mcp/oauth/` | Registered OAuth clients and issued tokens. Read via `scripts/clients.sh`, never by hand |
| `request-log.log` | Server: `/root/.gmail-multi-mcp/request-log.log` | One JSONL line per authenticated request on any endpoint (`path` says which). Holds no secrets by construction |

> `endpoints.json` and `send-allowlist.json` are not the same kind of control. The first is a convenience switch that lives in git and anything with repo access can flip. The second is the security boundary, and it deliberately lives somewhere the agent, the repo, and git history cannot reach.

---

## Project Documentation

Working docs live under `docs/`, each folder indexed by its own `README.md`:

| Folder | Holds |
|---|---|
| `docs/specs/` | What the tool does. `002-google-workspace-server.md` is the current source of truth for behavior; `001-email-tool.md` is superseded, kept for the reasoning behind the mail sections. |
| `docs/plans/` | How it was built, in phases. |
| `docs/adr/` | Why each significant decision was made, and what else was considered. |
| `docs/tickets/` | Open problems, and how past ones were resolved. |

`CLAUDE.md` at the root is the briefing AI agents load when working in this repo. `docs/machine-setup.md`, `docs/human-verification.md`, `docs/research-report.md` and `docs/mcp-server-lessons.md` are standalone references.

---

## Making Changes

1. Edit code in the local clone.
2. `npm test` — builds, then runs the suite against `dist/`.
3. `bash scripts/deploy.sh` — builds locally, ships `dist/` over tar, verifies the module graph, restarts pm2.
4. Commit and push to GitHub. `bash scripts/deploy.sh --rollback` restores the previous build.

> **Do not build on the server.** `tsc` OOMs on the 1GB droplet (googleapis ships very large type definitions), and a `git pull` deploy produces a server that dies at boot with `ERR_MODULE_NOT_FOUND` — `dist/` is gitignored but was half-committed long ago, so any new module is silently untracked. `deploy.sh` sidesteps both by building where the resources are and shipping the artifact. See `scripts/deploy.sh`'s header for the full history.

**Adding or renaming a tool also requires the MCP client to reconnect** (`/mcp`, or restart Claude Code). Deploying alone is not enough — the client caches the tool list, and a stale one silently hides new tools and shows old schemas.

**Toggling tools on/off** without code changes: edit `endpoints.json` and deploy (the file is read at boot, so the restart `deploy.sh` performs is what applies it). A name no module defines refuses to boot rather than being silently ignored. The mail endpoint's list is frozen by a golden test — see `test/golden/`.

---

## pm2 Quick Reference

```bash
pm2 status                       # Check if gmail-mcp is running
pm2 logs gmail-mcp               # Tail logs
pm2 restart gmail-mcp            # Restart after config/code changes
pm2 start ecosystem.config.cjs   # Start fresh from config file
pm2 save                         # Persist process list across reboots
```
