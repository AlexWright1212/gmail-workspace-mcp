# ADR 006 — The Spec and the ADRs Are Living Documents

**Last edited:** 2026-08-30 (written 2026-08-17; date-line convention added 2026-08-30)
**Status:** Accepted
**Origin:** ad hoc

---

## Context

Three divergences between `docs/specs/001-email-tool.md` and the actual tool accumulated within a single day:

- **Signatures** — specified in-scope with an acceptance criterion, then disabled (ADR 005).
- **Unsubscribe** — specified in-scope in four places, then deleted outright over a blind SSRF (ADR 002).
- **Mute** — the acceptance criterion required it to "take effect immediately and visibly in Gmail," which Gmail's API makes impossible for any client.

Each was handled the same way: implement the change, then write an ADR saying the spec was *deliberately left unchanged* and recording the gap as known-and-intentional. ADR 002 and ADR 005 both contained a paragraph to that effect.

The pattern is defensible one instance at a time and corrosive in aggregate. After three rounds, `docs/specs/001-email-tool.md` — the document explicitly named as "the source of truth for behavior," and the only artifact tied directly to what the owner actually wants — described a tool that did not exist. Worse, the divergences were discoverable only by reading every ADR and mentally diffing them against the spec. An agent reading the spec alone would have built the wrong thing and had no signal it was wrong.

`docs/adr/README.md` compounded this from the other side. It stated that ADRs are "never renumbered or edited after acceptance — a decision that gets reversed is superseded by a new ADR, not rewritten in place." Append-only ADRs are a reasonable convention for large teams needing an audit trail of institutional decisions. Here, with one owner and agents doing the writing, it meant every follow-up change to an already-decided topic had to become its own numbered ADR. Adding an enforcement test to a decision made an hour earlier would have produced ADR 006 about signatures, immediately after ADR 005 about signatures.

## Options Considered

**Keep the spec frozen; record divergence in ADRs.** The status quo. Treats the spec as a historical record of original intent and the ADR set as the true current state. Rejected: it inverts which document is authoritative, and the spec is the one artifact whose entire job is to represent the owner. Being "the source of truth" and "a historical record of what we once wanted" are incompatible.

**Let agents edit the spec freely whenever implementation diverges.** Keeps the spec accurate with no friction. Rejected outright — the spec is the owner's statement of desired behavior. An agent silently editing it to match whatever got built makes the spec a mirror of the code and destroys its only real function: catching the case where the code is wrong. A spec an agent can rewrite to agree with itself cannot disagree with anything.

**Living spec, gated on owner confirmation.** The agent flags the divergence with exact lines and proposed wording, the owner confirms or redirects, the agent edits in the same session and states plainly what changed.

## Decision

**Both the spec and the ADRs are living documents.**

The spec may change, and staying accurate beats staying original. When work implies the spec is wrong, unachievable, or being diverged from, the agent stops and flags it — naming the exact lines and the proposed wording — edits on the owner's confirmation, and reports what now reads differently. Proactively, without waiting to be asked. An ADR records *why* a decision was made; it is not a place to park behavior the spec still claims. Spec and code disagreeing is a bug in the spec.

**ADRs are grouped by topic, not by event, and edited in place.** A later change to how signatures work belongs in the signature ADR. A new ADR is for a genuinely different decision, or to reverse an earlier one wholesale — in which case it says what it supersedes. One ADR per change is wrong; so is cramming unrelated decisions together.

**The owner is asked before an ADR or ticket is written, including its shape** — new or edit, one or several. That call is theirs. The proposing is the agent's job; the structuring decision is not.

Tickets follow the same spirit: proactively raise real problems that aren't being fixed now, rather than noticing and moving on.

## Addendum (2026-08-30): the date line means *last edited*, not *written*

An unresolved consequence of the edit-in-place rule above, noticed by the
owner two weeks after it was made.

**The problem.** Every ADR carried a `**Date:**` line, and it was never
updated when the file was edited. Once ADRs became living documents, that made
the field actively misleading rather than merely incomplete: ADR 007 read
`2026-08-19` while carrying a status rewritten on 2026-08-30, and ADR 013 read
`2026-08-28` after a same-day security correction and a Phase 4 section. A
reader scanning dates to judge "how current is this?" — the only question that
field is useful for — got the wrong answer, and got it most wrong for the
files that had changed most. Under the append-only convention this ADR
reversed, a creation date was a perfectly good answer. Under edit-in-place it
is a stale one by construction.

**Decision.** The field is `**Last edited:**`, and an agent editing an ADR
updates it in the same pass. All fifteen existing ADRs were relabelled and
back-filled from git history. Where the creation date differs and carries
meaning, it is kept parenthetically — `**Last edited:** 2026-08-30 (written
2026-08-19)` — so nothing is lost, just demoted.

**What was considered and rejected.** *Both dates as separate fields* — two
lines of header on every file to serve one question anybody actually asks.
*Dropping the date entirely and relying on `git log`* — correct information,
wrong ergonomics: the index is read as prose, often by an agent that will not
run git against every file to decide which ADR is worth opening.

**Cost, accepted.** A trivial edit — fixing a typo, updating a pointer — now
bumps the date and makes an old, settled decision look freshly revised. That
is the right failure direction: it over-reports recency rather than
under-reporting staleness, and staleness is the one this project keeps getting
bitten by. The rule is also written into the `write-adr` skill, so it survives
sessions that never open this file.

## Consequences

- **The spec is authoritative again.** All three divergences were flagged, confirmed, and synced the same session: signatures and unsubscribe moved to "Explicitly out of scope" with their reasons, and the mute criterion was reworded to describe what `mute_thread` actually does.
- **Five documents had to be corrected**, because they asserted the spec had deliberately been left diverged — ADR 002, ADR 005, both their index rows, and `CLAUDE.md`. A stale doc claiming a known gap is worse than no doc: it sends the next agent hunting for a divergence that no longer exists.
- **This ADR reverses a rule that ADR 002 and ADR 005 were written under.** Their in-place corrections technically violated the append-only convention at the time they were made. Recorded here rather than smoothed over — the convention was wrong, but the edits did precede its removal.
- **Cost, accepted knowingly:** more interruptions. Every divergence now requires a confirmation round-trip before work continues, and the spec will churn. That is the point — the alternative was a spec nobody could trust, which is worth less than no spec at all.
- **The same staleness class recurred, and was caught late.** The date-line
  problem in the addendum above is this ADR's own rule biting: making documents
  editable without saying what "date" then means left every ADR quietly
  misdated for two weeks. It generalizes — when a document becomes living, ask
  which of its fields were only ever true of a static document.
- **Residual risk:** the process depends on an agent *noticing* divergence. Nothing enforces it — no test can check whether prose matches intent. The three divergences here accumulated precisely because each was individually reasonable. This will happen again; the mitigation is that flagging is now explicitly a proactive duty rather than a courtesy.

## Pointers

- `CLAUDE.md`: "The spec is live, not frozen" and "How work here is tracked".
- `docs/adr/README.md`: the topic-grouping and edit-in-place rules.
- `docs/tickets/README.md`: ticket conventions, unchanged by this ADR.
- The sync itself: commit `b46294d` (spec edits + the five corrected documents).
- `~/.claude/skills/write-adr/SKILL.md` — carries the date-line rule (and the
  edit-in-place convention) into repos that have no ADRs yet.
