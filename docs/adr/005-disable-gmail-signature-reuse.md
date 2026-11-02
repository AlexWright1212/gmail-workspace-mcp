# ADR 005 — Disable Gmail Signature Reuse

**Last edited:** 2026-08-18
**Status:** Accepted
**Origin:** ad hoc

---

## Context

`docs/specs/001-email-tool.md` lists signature reuse as in-scope: "when a draft should include a signature, reuse whatever signature is already configured in that Gmail account's own native settings — no separate signature template maintained inside this tool," with a matching acceptance criterion. It was built: `GmailAccountClient.getSignature()` reads `users.settings.sendAs.list`, and `compose.ts` accepts a `signatureHtml` trusted channel that inserts the owner's own markup into the HTML part while deriving a plain-text equivalent for the text part.

It never worked, and the reason turned out not to be our code.

The `gmail.settings.basic` scope was missing until 2026-08-17, so signature reads could not have worked before that date at all. Once granted, a direct dump of `users.settings.sendAs.list` for both accounts returned:

```json
{ "sendAsEmail": "ownerpersonal@gmail.com",
  "signature": "",
  "isPrimary": true, "isDefault": true }
```

Empty — straight from Google, with none of our code in between. The owner meanwhile has signatures configured and visible in the Gmail UI ("Main" on personal, two on tamu including "Alex Wright TAMU").

The cause is Gmail's **multiple signatures** feature. The Gmail API exposes exactly one signature per send-as address — the one assigned as that address's **default**. Google's own documentation describes the field as "an optional HTML signature that is included in messages composed with this alias in the Gmail web interface… added to new emails only." Named signatures picked from the compose-window signature button have no API surface. The owner inserts them manually per email, which means "Signature defaults" is set to *No signature*, so there is nothing for the API to report.

Making the signature API-visible therefore requires setting a Gmail signature **default** — which also makes Gmail auto-insert that signature into every new compose in the web UI. That is a change to the owner's day-to-day email behavior, imposed purely to satisfy a tool.

There was also an unresolved risk sitting on top of this. The owner's working pattern is to have the agent create a draft, then open it in Gmail and click Send. If Gmail's compose UI injects its own default signature into a draft that already carries one, the delivered mail contains it twice. Our implementation wrapped the injected signature in Gmail's own `class="gmail_signature"` marker — the only available lever — but no claim was ever made that this suppresses duplication, and it was never tested against a real delivered message.

## Options Considered

**Set a Gmail signature default on both accounts.** Makes the API report the signature and the feature work as specified. Rejected by the owner: it forces auto-insertion into every compose in the Gmail UI, changing normal email behavior to serve the tool, and it leaves the duplication risk live and unverified.

**Store a signature template in this server.** Sidesteps the API limitation entirely. Rejected — it directly contradicts the spec's explicit "no separate signature template maintained inside this tool," and creates a second source of truth that drifts from Gmail's.

**Leave the feature enabled but non-functional.** It technically already behaves correctly for the empty case (the spec says an account with no signature should simply produce a draft without one). Rejected — an enabled `get_signature` tool that always reports "no signature configured" invites an agent to keep trying, and `include_signature: true` would silently start injecting content the moment a default is ever set in Gmail for unrelated reasons.

**Disable it.** Drafts are reviewed by hand before sending, so a plain sign-off written into the body ("Best, Alex") covers the need.

## Decision

**Disable Gmail signature reuse.** The agent writes an ordinary sign-off into the body like any other text; the owner adds their real signature by hand if they want one, in the same pass where they review the draft before sending.

Concretely:
- `get_signature` removed from `tools-enabled.json`. Combined with ADR 003, a blocked tool is now genuinely unreachable rather than dependent on a fail-open config.
- `include_signature` removed from the `create_draft` and `send_message` input schemas.
- `includeSignature` **hard-wired to `false`** in both handlers, rather than read from arguments.
- `getSignature()`, `signatureHtml`, and `htmlToPlainText()` left intact and dormant.
- `test/signature-disabled.test.mjs` makes all of the above **structural**, so the decision fails CI if undone.

The hard-wiring matters and is not redundant with removing the schema property: **this server does not validate tool arguments against the declared `inputSchema`** — there is no ajv or zod, and handlers read `rawArgs` directly. `additionalProperties: false` is advisory. Removing the parameter from the schema alone would only hide it from well-behaved callers; anything that passed `include_signature: true` regardless would still have been honored. Documenting a decision is not the same as enforcing it.

## Consequences

- **The one genuinely unresolved risk in the send path is gone.** Signature duplication on the open-draft-and-send-manually workflow can no longer occur, because we never inject a signature. That question no longer needs a real delivered email to answer.
- **`docs/specs/001-email-tool.md` was updated to match, 2026-08-17.** The Signatures section and its acceptance criterion were removed and signature reuse moved under "Explicitly out of scope" with this reasoning, on the owner's explicit confirmation. An earlier draft of this ADR proposed leaving the spec diverged and recording the gap here; that was reversed — an ADR records *why* a decision was made, it is not a place to park behavior the spec still claims. See the spec-sync rule in `CLAUDE.md`.
- **The decision is cheap to reverse.** The code path is intact. Re-enabling means: set a signature default in Gmail for each account, restore `get_signature` to `tools-enabled.json`, re-add the schema property, and revert the two hard-wired `false` assignments. Do not do this without asking — the auto-insert side effect is the owner's to accept, not ours.
- **`describeSignatureUse()` is now unreachable** while `includeSignature` is constant `false`. Left in place as part of the dormant path.
- Steps 4, 5, and 6 of `docs/human-verification.md` (signature fidelity, duplication, cross-account non-bleed) are moot and should be skipped.

## Pointers

- `src/index.ts`: the two `const includeSignature = false;` assignments in the `create_draft` and `send_message` handlers, and the comments where the schema property used to sit.
- `src/gmail-client.ts`: `getSignature()` — dormant.
- `src/compose.ts`: the "ONE exception" docblock explaining the `signatureHtml` trusted channel, and `signatureHtmlBlock()` — dormant.
- `tools-enabled.json`: `get_signature` absent.
- `test/send.test.mjs`: signature tests still pass and are retained deliberately — they cover the dormant code so a future re-enable starts from a verified base.
- `test/signature-disabled.test.mjs`: enforces this ADR. Asserts `get_signature` is absent from `tools-enabled.json`, no `inputSchema` declares `include_signature`, both handlers hard-wire `false` and never read `rawArgs.include_signature`, and the dormant code still exists so the "cheap to reverse" claim above stays true. Verified to fail red by re-enabling one handler in `dist/`.

**Why the enforcement test exists:** the dormant code is the hazard. A future agent reading `getSignature()` and `signatureHtml` could reasonably conclude the feature is meant to work and "fix" it by re-adding the tool argument — a change that would look like a bug fix and pass every other test. This ADR alone would not have stopped that.
