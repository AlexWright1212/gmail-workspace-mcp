# Landscape Research Report — Gmail MCP Composition & Safety

Evaluated against `docs/specs/001-email-tool.md`. Five parallel research passes, synthesized below.

## Bottom line

**Not a solved problem you can adopt off the shelf.** The individual techniques needed (real MIME libraries, `multipart/alternative`, capability allowlisting, threading headers) are each well-understood and documented elsewhere — but no existing open-source project assembles them together, and the *specific* bug that started this whole investigation is not a fluke we happened to hit. It is an **open, unresolved, recurring issue in the two most popular Gmail MCP servers in the entire ecosystem.** That's the single most important finding: this class of bug is a known-hard, still-unsolved problem industry-wide, not something we did unusually wrong.

## Root cause, fully explained

Gmail's backend does a **two-step process** that this whole investigation didn't originally account for: your draft gets written to the Sent folder as-is, but then Gmail's backend separately sanitizes/rewrites the message *before actual delivery*. The Sent-folder view (what looked "fine") and the delivered message (what broke) come from two different processing stages — and nothing you can test locally observes that second stage, because it happens inside Gmail's infrastructure, downstream of anything your code controls.

Concretely: an HTML-only draft gets a plain-text alternative **auto-synthesized by Gmail** on the way out. A plain-text-only draft gets its cosmetic line-wraps (added by Gmail's compose UI for on-screen display) frozen into real line breaks on send. Both are symptoms of the same root issue: **not supplying a proper `multipart/alternative` message with both a `text` part and an `html` part.** When both parts are present and correctly built, Gmail sends what you built — this divergence stops happening. This is well-documented (GMass's Gmail API writeup, Gmail support forums since ~2013) — not obscure.

## Is this bug unique to us? No — it's industry-wide

- **GongRzhe/Gmail-MCP-Server** (1167★, most-forked Gmail MCP server in existence) has an **open, unmerged PR (#90)** — "Fix: Prevent hard line breaks in sent emails" — describing this exact divergence class. Unresolved for 6+ months.
- **ArtyMcLabin/Gmail-MCP-Server** (222★, the most actively-maintained fork of the above) has its **own open PR (#46)** for the same MIME-encoding-fidelity problem, still unresolved.
- **tszaks/gmail-multi-inbox-mcp** (our upstream, now renamed `ghub`) hand-rolls MIME **byte-for-byte identically** to our fork — confirmed by direct source comparison. The bug was inherited wholesale, not introduced by our fork. Upstream has never even discussed it: zero GitHub Issues, 5 PRs total, none touching formatting/encoding/signatures/allowlisting.

## Ecosystem survey — why nothing is adoptable wholesale

| Project | Stars | Maintained? | Multi-account | Real MIME lib | Fidelity fix | Native signature reuse | Send allowlist |
|---|---|---|---|---|---|---|---|
| GongRzhe/Gmail-MCP-Server | 1167 | Stale (~1yr) | No (single cred) | Yes (nodemailer) | Open, unmerged PR | No | No |
| ArtyMcLabin/Gmail-MCP-Server | 222 | Active | Yes (separate instances per account, not unified) | Yes | Open, unmerged PR | No | No |
| jgalea/mailbox-mcp | 6 | Very fresh | Yes, multi-provider | Undocumented | Unknown | Maybe (undocumented) | No (has alias-verification, different thing) |
| navbuildz/gmail-mcp-server | 12 | Active | Yes | N/A | N/A | No | No — send/drafts/attachments unimplemented |
| tszaks/gmail-multi-inbox-mcp (our upstream) | 2 | Solo, scope-crept into Drive/Sheets/Calendar | Yes | No (hand-rolled) | Same bug, unaddressed | No | No |
| mcp-gmail-manager (PyPI) | unverified | unverified | unverified | unverified | unverified | unverified | **Reportedly yes** — closest conceptual match, but source unlocatable, unverified lead only |

No project combines multi-account + a real MIME library + a fixed fidelity bug + native signature reuse + a hard allowlist. **Recommendation stands: keep building/patching the current fork rather than migrating to any of these** — but borrow specific fixes from them (below) rather than reinventing.

## Other divergence bug classes found (proactive hunt, per spec's "unforeseen bugs" concern)

| Bug class | Prevented by adopting nodemailer/mailcomposer? |
|---|---|
| Plain-text wrap-on-send (the one we hit) | Yes, via `multipart/alternative` with both parts |
| HTML-only draft gets a synthesized plain-text part | Yes, same fix |
| RFC 2047 subject/header mojibake (emoji, non-ASCII) | Yes — auto Q/B-encoding, and removes the double-encoding bug that hits people who hand-encode |
| Quoted-printable line-wrap corruption (mid-multibyte-char breaks) | Partial — nodemailer itself has historically shipped this bug (since fixed); "standard library" reduces but doesn't eliminate this risk class |
| Attachment/MIME corruption (bad boundaries, wrong base64 variant, wrong Content-Type) | Yes, by construction |
| **Threading headers (References/In-Reply-To) silently dropped** | **No** — confirmed as an open bug in a sibling MCP project; requires explicit application logic (fetch parent's real Message-ID, prepend to References chain) regardless of library |
| Signature duplication in reply chains | No — this is Gmail's own auto-append-on-reply behavior, orthogonal to MIME construction; needs separate handling if we inject a fetched signature into body text |
| Missing/malformed Date, Message-ID headers | Yes, by construction |
| Unescaped `<`/`&` in HTML body | No — no library escapes content for you; stays application logic |

**Net verdict:** adopting nodemailer/mailcomposer closes most of the *known* bug classes by construction, but explicitly does **not** make this "someone else's problem" for threading, signature duplication, or content escaping — those need to stay in our own test coverage regardless of library choice.

## Draft/sent fidelity — what to do about the self-send-preview ritual

The self-send-preview habit exists because of the original bug. Key finding: **no local tool can fully replace it**, because the divergence happens inside Gmail's backend, downstream of anything testable locally (Mailpit/MailHog/maildev catch SMTP traffic generically — they don't exercise Gmail's actual API/rewrite pipeline). Also notable: **no AI-agent-email framework in the survey uses self-send-as-approval** — that pattern comes from email marketing tools (Mailchimp-style "send test to yourself"), not agent frameworks. Agent frameworks (LangChain, Composio, customer-support AI tools) instead do **in-band human approval of the draft representation itself** — review the text/HTML directly in the chat, no real send involved.

**Recommendation (spec amendment):**
1. Fix the known bug by construction: adopt mailcomposer, always emit both `text` and `html` parts, add an automated test asserting the generated MIME's paragraph structure matches intent.
2. **Downgrade the self-send from "required every time" to "spot-check"** — reserved for new content shapes (first attachment, unusual characters, right after touching composition code), not routine sends. It's still the only way to observe Gmail's real backend behavior, so it's not being removed — just rightsized to match how much residual risk actually remains after the construction-level fix.
3. Don't add Mailpit/local SMTP catchers — for this project, they add setup cost without testing the part that actually broke.

## Send-allowlist — hardening needed

Prior-art search found a real academic treatment of this exact problem: **"Capability Gates Are Not Authorization" (arXiv 2606.28679)**, which audited LangChain/LangGraph, LlamaIndex, and Stripe's Agent Toolkit and found all three do *static* tool-existence gating by default but none does the *dynamic*, deterministic, fail-closed, per-call value check that our allowlist is supposed to be — confirming this is a real, commonly-missed gap even in mature frameworks, not something we're over-engineering. The MCP spec itself backs this placement: it requires servers to enforce access control themselves ("MUST... implement proper access controls"), not rely on client-side confirmation dialogs (which are only a "SHOULD," and rubber-stampable).

**Concrete hardening gaps to close, from the transactional-email industry's own sandbox-mode conventions (Mailgun, Postmark, Mailtrap all ship this pattern already):**
- **Normalize before comparing** — Gmail treats `alex+test@gmail.com` and dot-variants as equivalent to `alex@gmail.com`; a naive string-equality allowlist check is bypassable via plus-addressing/dots.
- **Single choke point** — the check must sit immediately before the actual Gmail send call, not earlier in the pipeline where it could be checked-then-trusted.
- **Out-of-band policy** — the agent must have zero write path (direct or via any tool) to the allowlist config itself.
- **Fail-closed on any error** — config missing/unparseable → deny, never allow.
- **Log rejected attempts** — the current spec has no audit trail requirement; this is the main way to notice an agent trying to escape scope.

## Recommended spec amendments (concrete, ready to apply)

1. Compose & Formatting: require `multipart/alternative` with both `text` and `html` parts on every outgoing message, built via mailcomposer — not just "HTML with `<p>` tags," which was this session's fix but not the complete one.
2. Add explicit acceptance criteria for threading-header correctness (References/In-Reply-To chain built from the real parent Message-ID) and signature-duplication avoidance in reply chains — both confirmed as real, separate bug classes nodemailer won't fix for free.
3. Revise "Send Allowlist" section: self-send-preview becomes a spot-check, not a mandatory step per send.
4. Add allowlist hardening requirements: address normalization, single choke point, out-of-band config, fail-closed, audit logging of rejections.
5. Add an automated test (parse generated MIME, assert structure) as a required acceptance check, cheaper and faster than any real send.

## Sources

- GMass — [Gmail API's quirky handling of HTML and Plain Text message parts](https://www.gmass.co/blog/gmail-api-html-plain-text-messages/)
- Mathias Bynens — [Gmail plain text notes](https://mathiasbynens.be/notes/gmail-plain-text)
- GongRzhe/Gmail-MCP-Server — [PR #90](https://github.com/GongRzhe/Gmail-MCP-Server/pull/90), [issue #66](https://github.com/GongRzhe/Gmail-MCP-Server/issues/66)
- ArtyMcLabin/Gmail-MCP-Server — PR #46
- googleapis/google-api-nodejs-client — [issue #1938](https://github.com/googleapis/google-api-nodejs-client/issues/1938)
- nodemailer/nodemailer — issues #98, #1275 (historical quoted-printable bugs)
- swiftmailer/swiftmailer — issues #72, #334 (equivalent QP bug in another ecosystem)
- arXiv 2606.28679 — "Capability Gates Are Not Authorization: Confused-Deputy Failures in LLM Agent Frameworks"
- modelcontextprotocol.io — 2025-06-18 spec revision, Security Considerations section
- Permit.io / LangChain docs — human-in-the-loop patterns for agent side effects
- Saleshandy / Mailchimp-style "send test to yourself" docs — origin of the self-send-preview pattern (marketing tooling, not agent frameworks)
