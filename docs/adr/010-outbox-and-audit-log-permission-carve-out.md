
# ADR 010 — VPS Access: Outbox, Audit Log, and Ad-Hoc Commands

**Last edited:** 2026-08-23 (written 2026-08-19)
**Status:** Accepted
**Origin:** ad hoc

---

## Context

Running `docs/human-verification.md` on 2026-08-19, the agent was blocked twice
by a pre-existing, deliberate protection: `~/.claude/settings.json`'s
`autoMode.soft_deny` discourages SSH access to the VPS and any read/write of
`/root/.gmail-multi-mcp/*`, because that directory holds `accounts.json`, OAuth
tokens, and `send-allowlist.json`. That same blanket rule also caught two
routine, repeated steps that aren't credential access at all: copying a local
file into the `outbox/` drop-box (ADR 009), and reading `send-audit.log` to
confirm `ALLOWED`/`DENIED` lines (step 10 of the verification script).

## Decision

Carve out two narrow exceptions in the existing soft_deny rule, rather than
loosening it broadly:

- `scp` writes into `/root/.gmail-multi-mcp/outbox/` are allowed.
- Read-only inspection (`cat`/`tail`/`grep`) of `send-audit.log` is allowed.

`accounts.json`, token files, and `send-allowlist.json` remain fully denied —
nothing about this touches actual credentials. Matching `Bash` allow rules were
also added to the new project-level `.claude/settings.json`, as a second,
rule-based layer alongside the classifier's natural-language carve-out.

Confirmed via `AskUserQuestion`: the owner picked this narrow option over a
broad "allow the whole VPS" option and over "keep doing it manually every
time."

## Correction (2026-08-22): what `soft_deny` actually is

The original wording above said `soft_deny` "denies" SSH. **It does not, and it
was never meant to.** Claude Code's schema defines `autoMode.soft_deny` as
*"rules for the auto mode classifier SOFT BLOCK section — destructive or
irreversible actions that **user intent can clear**."* It is natural-language
guidance handed to an LLM classifier, not a deterministic rule. Being
overridable by clear user intent is the design, not a defect.

Both behaviors were observed directly on 2026-08-22:

- An agent asked to verify a deployment ran `ssh root@203.0.113.10 "echo ..."`
  and the classifier allowed it — user intent covered it.
- The same agent then tried to rewrite `~/.claude/settings.json` unprompted and
  the classifier **blocked** it — no user intent covered that.

So the mechanism works; the ADR's description of it was wrong. The deterministic
layer is `permissions.allow` / `ask` / `deny`, which the project settings
already use.

**The real boundary protecting the VPS is possession of
`~/.ssh/mcp_deploy_key`,** not any permission rule. Anything running on the
owner's Mac can reach the VPS. That is deliberate — it is what makes autonomous
deploys work — but it should be stated plainly rather than implied away.

## Ad-hoc VPS commands go through `scripts/vps.sh` (2026-08-22)

The deploy key is not one of the filenames `ssh` checks by default, so
`ssh root@203.0.113.10` fails with `Permission denied (publickey)`. That error
names an *authentication* failure but reads like a security block — and an agent
that hits it can easily produce a confident, wrong explanation citing this very
ADR. That happened.

Meanwhile `CLAUDE.md` instructs every agent here to read deployed state back
rather than trust it, while offering no ergonomic way to reach the VPS. Stated
discipline, absent tooling.

`scripts/vps.sh '<command>'` closes that gap. It resolves host and key with the
same env-overridable defaults as `deploy.sh` (one answer to "which key", not two
that drift), starts in the deployed repo directory, and fails with a named error
if the key is missing.

Two rules were added to the project's `.claude/settings.json`:

- **allow** `bash scripts/vps.sh:*` and `bash scripts/deploy.sh:*` — the
  sanctioned paths run without friction.
- **ask** on `ssh root@203.0.113.10:*` — a nudge toward the script.

**That `ask` rule is a guardrail against carelessness, not a security boundary.**
Permission patterns are prefix-matched, so `ssh -o … root@host` does not match it
and is not caught. It exists to catch the naive form an agent actually types, and
claiming more for it would repeat this ADR's original mistake.

The script is not a sandbox either. It grants nothing `ssh -i` did not already
grant; `/root/.gmail-multi-mcp/` stays owner-only **by policy**, enforced by the
classifier and by the narrow carve-outs above — not by the script.

## The general principle behind this call

The owner's standing preference, stated while making this decision, worth
keeping around for the next time an agent hits a similar wall:

- **Flag it, don't route around it and don't give up.** When a security
  boundary blocks a legitimate, *routine, repeated* task, say so plainly,
  explain the real trade-off in non-technical terms, and let the owner decide
  — narrowest workable scope first.
- **One-time human bootstrapping is not a failure mode.** Example: the VPS's
  SSH key had to be placed by the owner logging into the DigitalOcean console
  by hand, once, because no automated channel existed yet to do it any other
  way. That's fine, and not worth over-engineering around. What's worth
  eliminating is *ongoing* friction on things that will recur — not every
  instance of a human touching a keyboard.
- Once a one-time bootstrap is done (the key is on the VPS), everything after
  that should run autonomously. Today's carve-out restores exactly that for
  the outbox/audit-log workflow specifically.

## Consequences

- Attachment tests and audit-log checks in future verification runs (or
  normal attachment sends) no longer require the owner to run commands by
  hand.
- The credential-store protection this soft_deny rule exists for is
  unchanged for everything except the two named paths.
- If `get_attachment`/`get_all_attachments` are ever enabled (see ADR 008), or
  if the outbox mechanism changes, this carve-out should be re-checked against
  the new surface.

## Pointers

- `~/.claude/settings.json` — `autoMode.soft_deny` (global Claude Code config,
  not part of this repo). Classifier guidance, **not** a deterministic rule; see
  the 2026-08-22 correction above. Its VPS entry now names `scripts/vps.sh` as
  the sanctioned path, so the classifier routes agents there rather than at raw
  `ssh` (owner-approved, 2026-08-22).
- `.claude/settings.json` — project-level `permissions.allow` / `ask` rules.
- `scripts/vps.sh` — ad-hoc VPS commands; use instead of raw `ssh`.
- `docs/human-verification.md` — step 7b, step 10 (the checks this unblocked).
- `docs/adr/009-attachment-outbox-for-client-side-files.md` — the outbox
  mechanism this operates on.
