*This spec defines WHAT this tool does. The plan defines HOW.*

> **Superseded by [002 — Google Workspace MCP Server](002-google-workspace-server.md) on 2026-09-19.** The mail behavior below remains true and is restated in 002; this file is kept for the reasoning and history behind it. Where the two disagree, 002 wins.

# Gmail MCP Server — Behavioral Spec

## Objective & Scope

This tool is a personally-owned, self-hosted MCP server, reachable over the public internet at a single HTTPS endpoint, that lets any modern MCP client authenticate as the owner and act as a full inbox assistant across the owner's two Gmail accounts (personal + tamu.edu) — searching and reasoning over mail, organizing it (labels, archive, mute, block), and composing correctly-formatted drafts with attachments, without ever being able to send mail to an outside recipient. Verified working today: claude.ai (web and the Claude mobile apps), Claude Code, Codex, and Cursor. ChatGPT's regular chat cannot reach it — not a limitation of this tool, but of ChatGPT's own plan tiering (Developer Mode, required for custom MCP servers in chat, isn't offered below Business/Enterprise/Edu); ChatGPT's *Codex* mode works fine since it's a different client underneath.

**In scope:**
- Full-text and semantic-ish search/reasoning across both inboxes and sent mail, including cross-referencing multiple related threads from a vague natural-language description
- Inbox organization: labels, archiving, trashing, muting, blocking/unblocking senders
- Composing drafts: correct HTML rendering (must survive Gmail's send pipeline unchanged), file attachments
- Sending, but only to addresses on an explicit allowlist (seeded with the owner's own addresses) — used as a self-preview/dry-run mechanism, not as a way to reach real recipients
- Two Gmail accounts today; architecture should tolerate adding a third Gmail account later without a redesign

**Explicitly out of scope (this version):**
- Sending to any address not on the allowlist, under any condition, regardless of user instruction in a given conversation — this is a hard boundary enforced by the tool, not a policy the agent is trusted to self-enforce
- Non-Gmail providers (IMAP/SMTP generic, Outlook, etc.) — permanently out of scope per owner's stated intent, not just deferred
- Non-MCP integration paths (n8n, Zapier, etc.)
- Google Drive, Sheets, Docs, Calendar — nice-to-have, not required, no design effort spent accommodating them now
- Signature reuse from Gmail's own settings — removed 2026-08-17. The Gmail API only exposes a signature that is set as an account's *default*, and setting a default makes Gmail auto-insert it into every compose in the web UI. Changing the owner's normal email behavior to satisfy the tool was not worth it; drafts are reviewed by hand, so the agent writes a plain sign-off in the body instead. See `docs/adr/005-disable-gmail-signature-reuse.md`.
- Unsubscribing from mailing lists — removed 2026-08-17. The tool POSTed to a URL taken from the incoming message's `List-Unsubscribe` header, which is controlled by whoever sends you mail; that is a blind SSRF against anything the server can reach. Deleted rather than sanitized. See `docs/adr/002-remove-unsubscribe-tool.md`.
- Paid third-party email-sending/agent SaaS products — self-owned code only, VPS hosting cost is the only acceptable recurring cost

**Future direction:** the allowlist mechanism is designed to be the seed of a more general "who is this agent allowed to reach" boundary — if real external sending is ever reintroduced, it likely arrives as an expansion of the same allowlist/gating mechanism rather than a new parallel system. The self-preview mechanism (dry-run-to-self) is the owner's default intuition for "how do I know a draft is really safe before it goes out," but is explicitly not considered the only acceptable verification method — alternatives (e.g., local render preview) may replace or supplement it if research surfaces something better.

## Feature Details

### Search & Cross-Thread Reasoning
**What it does:** Given a vague natural-language description ("my manager emailed me about X a couple weeks ago, my teammate also mentioned it, I think I replied") the agent can search both inboxes and sent mail, pull the relevant threads, and reason across them to answer questions or propose organization — without the owner needing to know Gmail search syntax or exact senders/dates.

**How it works (conceptually):** search is not a single exact-match lookup — the agent may need several search passes (by sender, by keyword, by date range, across accounts and sent mail) and read multiple candidate threads before concluding which ones actually match the owner's description. This is a reasoning loop, not a single tool call.

**Architecture boundary — important:** the MCP server's job is to expose good primitives (search by field, fetch a thread, list labels, etc.) — it is *not* the MCP server's job to implement the fuzzy matching or multi-thread reasoning itself. That reasoning happens in the AI model driving the tool calls, iterating over primitive results. This spec describes the behavior the owner should experience end-to-end, but the dividing line matters for the plan: don't build "smart search" into the server; build good primitives and trust the model loop.

**Data touched:** subject/body/sender/date across all mail (inbox, sent, archived), scoped to whichever account(s) are relevant to the request.

**Edge cases:** ambiguous description matches multiple unrelated threads → agent should surface the candidates and ask rather than silently pick one. No matches found → say so plainly rather than fabricating a plausible-sounding thread.

### Multi-Account Scoping
**What it does:** the owner will often refer to a specific account informally ("my tamu email," "my personal inbox") rather than asking to search everything — most requests are scoped to one account, not both. The agent should resolve informal references to the right account and default to touching only that account, rather than habitually querying both "just in case."

**How it works (conceptually):** each account has a stable id (`personal`, `tamu`) plus whatever informal names the owner naturally uses for them; the agent's job is mapping the informal reference to the right id. When the owner's request is genuinely ambiguous about scope ("check my email" with no account named) or explicitly spans both ("check both inboxes"), the tool should support querying across every enabled account in one call rather than forcing two round trips.

**Edge cases:** account reference doesn't clearly map to either account → ask rather than guess or silently default to one.

### Remote Access & Authentication
**What it does:** the server is reachable from anywhere, not just the owner's own devices, and requires no shared password or token to be copied between clients. Each client authenticates for itself.

**How it works (conceptually):** a connecting client is sent through a real Google login, hard-restricted to the owner's two Google addresses — nobody else's Google account can complete it. The owner then sees a consent screen naming the specific client asking for access before anything is issued. Once approved, that client holds its own token, separately revocable at any time with no effect on any other connected client. A client can be granted read-only access or full read/write access; today every connected client has both.

Two independent layers sit in front of that login: the server is only reachable through Cloudflare's edge, which is the sole public entry point and provides basic firewalling; and the VPS itself refuses any direct connection that doesn't arrive through that path or the owner's own private admin network. Neither is the actual security boundary on its own — a client still can't do anything without completing the Google-restricted login above.

**Edge cases:** a login attempt from any Google account other than the owner's two fails to complete, every time, regardless of the client. Revoking a client's access takes effect immediately, without restarting the server or affecting any other connected client.

### Inbox Organization
**What it does:** apply/remove labels, archive, trash, mute threads, block/unblock senders — either on explicit instruction ("archive this") or as a natural side effect of a broader request ("clean up anything from BSC older than a semester").

**Behavior boundary:** these actions are reversible or low-consequence (labels/archive/mute can be undone; Gmail trash has a recovery window) — the agent may take them on reasonable interpretation of an instruction without a separate confirmation step, unlike sending. Blocking a sender is the one action here worth a light gut-check since it's less obviously reversible in effect (future mail from them is silently dropped) — agent should say what it's about to block and why before doing it, not just narrate after.

**Mute is not a real mute.** Gmail's API rejects the `MUTE` label (`Invalid label: MUTE`) — tested, not assumed — so no client can mute a thread through the API. `mute_thread` archives the thread and says so plainly, including that new replies will reappear in the inbox. It must never report a thread as muted when it is not.

### Compose & Formatting
**What it does:** produce a draft — reply or new thread — that renders identically whether viewed as a draft or after the owner hits Send themselves. This is the core bug this whole spec traces back to: a draft that looks fine while being edited but reflows into broken line breaks on send is a spec violation, not a cosmetic nitpick.

**How it works (conceptually):** the tool never emits a body format that depends on Gmail's own editor to "fix up" on send (i.e., no bare multi-paragraph plain text). Paragraph structure must be explicit and unambiguous in the outgoing message itself.

**Edge cases:** body containing characters that are meaningful in whatever format is chosen (e.g., `<`, `&`) must render as literal text, not be interpreted as markup or silently dropped.

**Cross-cutting concern — unforeseen divergence bugs:** the draft-vs-sent line-break bug was not something anyone predicted going in; it was discovered by accident. That's the more important lesson than the specific fix: this class of problem (something that looks correct in one context — draft, preview, editor — and silently changes by the time it's actually delivered) can plausibly recur in other forms that haven't been hit yet — e.g., attachment corruption on send, character encoding/emoji mangling, subject line truncation, reply-threading headers getting stripped, signature duplication in reply chains, timezone/Date-header issues. The research pass (below) should treat "what other draft-vs-sent divergence bugs are known to bite people building on the Gmail API" as its own explicit question, not just fix the one bug already found. Where a proactively-identified risk already has a known robust fix (e.g., a standard library that handles it correctly by construction), prefer adopting that over writing bespoke handling.

### Attachments
**What it does:** attach one or more local files to a draft (already functional in the current codebase — this section exists to confirm it stays correct as the composition path is touched, not to redesign it).

**Edge cases:** referenced local file doesn't exist or isn't readable → clear failure, not a silently empty attachment.

### Send Allowlist (Self-Preview)
**What it does:** the tool can send email, but only to addresses on an explicit allowlist. The allowlist is seeded with the owner's own addresses (personal + tamu) and is enforced by the tool itself — not by the agent's judgment, not by conversational instruction. Any attempt to send to an address not on the list is rejected outright, regardless of how the request is phrased or how confident the agent is that it's fine.

**How it's used (provisional pattern, not a fixed requirement):** the owner's current working pattern is: agent drafts something intended for a real recipient → agent sends a copy to the owner's own address as a preview → owner reviews it as a real recipient would see it → if it looks right, owner tells the agent to go ahead and create the actual draft for the real recipient → owner sends that one manually from Gmail. The tool is never the one to take the last step.

This self-send-as-preview habit exists *because* of the draft-vs-sent bug — it's a workaround for not being able to fully trust that what's drafted is what gets delivered. It is explicitly open to revision: if the research pass finds that draft/sent fidelity can be guaranteed by construction (a library or technique that makes the divergence class of bug structurally impossible, not just handled for the one case already found), the self-send step becomes optional rather than a required ritual. The allowlist mechanism itself (hard boundary on real sends) stays valuable regardless of what happens to the preview workflow — those two things are separable.

**Edge cases:** allowlist is empty or misconfigured → sending fails closed (no send happens), not open.

## Acceptance Criteria

- Given a vague multi-thread description, the agent finds and reasons over the right threads across the relevant account(s) and sent mail without the owner supplying exact search terms.
- Given a request scoped to one account by an informal name, the agent resolves it correctly and doesn't need to touch the other account to satisfy it.
- Labels, archive, trash, and block/unblock actions all work against both accounts and take effect immediately and visibly in Gmail.
- `mute_thread` archives the thread and states plainly that Gmail's API exposes no real mute, rather than reporting a mute that did not happen.
- A composed draft, viewed after being sent by the owner, contains the same paragraph structure it had while being edited as a draft — no reflowed or broken line breaks, regardless of length or paragraph count.
- A draft with a local file attachment shows that attachment as a normal Gmail attachment on send.
- Attempting to send to any address outside the allowlist fails, every time, with no phrasing of the request able to override it.
- Sending to an allowlisted address (the owner's own) succeeds and the resulting email, opened as a real recipient would, matches what was drafted.
- Any modern MCP client can connect to the single public endpoint and, after the owner completes a Google login, use the tool — no shared secret to configure on the client side.
- A login attempt from a Google account other than the owner's two fails, every time; a revoked client's access stops working immediately.

## Known Symptom To Avoid (observed fact, not diagnosis)

While testing the current implementation: a draft built with `Content-Type: text/plain` containing one long, unbroken paragraph displayed correctly — as a single flowing paragraph — while being edited in Gmail's web compose UI. After the owner clicked Send, the delivered message displayed with hard line breaks inserted partway through the paragraph, roughly every 70–80 characters, breaking it into a dozen short lines instead of one paragraph. Switching the same content to `Content-Type: text/html` with the paragraph wrapped in a `<p>` tag resolved the visible symptom in that specific test, verified by an actual send and inspection of the delivered message, not just visual inspection of the draft. This is the exact failure mode any solution must avoid reproducing.

## Error Handling & Edge Cases

- **Expired/invalid Gmail credentials:** surfaced as a clear, specific failure ("this account's token needs re-auth") — never silently retried into a different account or silently dropped.
- **Gmail API rate limiting:** surfaced as a wait/retry condition to the owner, not disguised as a different kind of failure.
- **Send attempted to a non-allowlisted address:** rejected before any network call to actually send; the agent should explain that the tool itself won't allow it, not that it "chose" not to.
- **Ambiguous search/reasoning results:** the agent presents candidates and asks, rather than guessing silently.

