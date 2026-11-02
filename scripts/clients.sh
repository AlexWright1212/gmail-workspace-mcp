#!/usr/bin/env bash
# Enumerate and revoke OAuth clients on the VPS, without an agent ever
# reading a credential.
#
# Why this exists: Phase 3 of docs/plans/001-remote-access-migration.md
# onboards several distinct OAuth clients (claude.ai, phone, ChatGPT, Codex,
# Cursor). Their registrations and tokens live under
# /root/.gmail-multi-mcp/oauth/ -- a directory agents are fenced out of by
# policy (ADR 010), for the same reason accounts.json and
# send-allowlist.json are: it can hold secrets (client_secret, access and
# refresh token values). Revocation still has to be possible without an
# agent (or the owner) ever needing to open those files directly. Same
# carve-out shape as ADR 010's outbox/audit-log exceptions: a narrow,
# purpose-built tool instead of a blanket permission loosening.
#
# Reaches the VPS EXCLUSIVELY through scripts/vps.sh -- never raw ssh (the
# deploy key is not one of the filenames ssh checks by default; see
# CLAUDE.md and docs/adr/010 for why that reads like a security block and
# isn't). The actual JSON-store logic lives in one place,
# scripts/lib/oauth-clients.cjs, a dependency-free Node script that:
#
#  - can be run directly against a local fixture directory for testing:
#      node scripts/lib/oauth-clients.cjs /path/to/fixture/oauth list
#  - is piped, byte-for-byte, over this script's stdin to a `node -` process
#    on the VPS (see the case block below) -- so there is exactly one copy
#    of the logic, never a local version and a separate remote one that can
#    drift apart.
#
# `revoke` without --yes is a DRY RUN: it prints exactly what would be
# deleted (the client's name/redirect_uris and how many access/refresh
# tokens, in-flight codes, and pending authorizations reference it) and
# changes nothing. Only --yes performs the deletion, and the underlying
# script re-reads every store afterward to confirm the deletion actually
# landed before it will say so -- see oauth-clients.cjs's own comments for
# why ("never trust a tool that only reports success" is this whole
# project's standing rule; see CLAUDE.md).
#
# NEVER prints a client_secret or a token/refresh-token value, on `list` or
# on `revoke`. Client ids are not secret -- DCR is open by design (ADR 013)
# -- so they, names, and redirect URIs are shown freely.
#
# Usage:
#   bash scripts/clients.sh list
#   bash scripts/clients.sh revoke <client_id>          # dry run, changes nothing
#   bash scripts/clients.sh revoke <client_id> --yes    # actually deletes
#   bash scripts/clients.sh migrate-scopes              # dry run: which stored tokens still say mail:read/mail:write
#   bash scripts/clients.sh migrate-scopes --yes        # rewrite them to read/write (plan 002 Phase 6, 2026-09-20)
#
# DO NOT run `revoke --yes` against production casually: `gmail-remote`, the
# owner's real daily Claude Code connection (docs/adr/013), is a live
# registered client under here. Killing it breaks their working setup.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib/oauth-clients.cjs"
OAUTH_DIR="${GMAIL_MCP_OAUTH_DIR:-/root/.gmail-multi-mcp/oauth}"

usage() {
  cat >&2 <<'EOF'
usage:
  bash scripts/clients.sh list
  bash scripts/clients.sh revoke <client_id> [--yes]
  bash scripts/clients.sh migrate-scopes [--yes]

Reads/writes /root/.gmail-multi-mcp/oauth/ on the VPS through scripts/vps.sh
(never raw ssh). Never prints a client secret or token value.

`revoke` without --yes is a dry run: it prints exactly what would be
deleted (client registration, access tokens, refresh tokens, in-flight
codes, pending authorizations) and changes nothing. Pass --yes to actually
delete -- do this deliberately, never as a first attempt.

`migrate-scopes` rewrites stored tokens still carrying the retired
`mail:read`/`mail:write` scope names to `read`/`write` (plan 002 Phase 6,
run 2026-09-20). Dry run without --yes; idempotent; never prints a token.
EOF
}

if [[ ! -f "$LIB" ]]; then
  echo "clients.sh: missing $LIB" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  usage
  exit 2
fi

SUBCOMMAND="$1"
shift

case "$SUBCOMMAND" in
  list)
    bash "$SCRIPT_DIR/vps.sh" "node - '$OAUTH_DIR' list" < "$LIB"
    ;;
  revoke)
    if [[ $# -lt 1 ]]; then
      echo "clients.sh: revoke requires a client_id" >&2
      usage
      exit 2
    fi
    CLIENT_ID="$1"
    shift
    CONFIRM_FLAG=""
    if [[ "${1:-}" == "--yes" ]]; then
      CONFIRM_FLAG="--yes"
    elif [[ -n "${1:-}" ]]; then
      echo "clients.sh: unrecognized argument '$1' (did you mean --yes?)" >&2
      usage
      exit 2
    fi
    # client_id is attacker-reachable data -- DCR is open to the public
    # internet by design (ADR 013), so anyone can register one and choose
    # its value. %q shell-escapes it so a hostile client_id (quotes,
    # semicolons, backticks) cannot break out of the remote command string
    # this builds -- it becomes exactly one literal argv entry on the far
    # side, never a chance to inject a second command.
    printf -v CLIENT_ID_Q '%q' "$CLIENT_ID"
    bash "$SCRIPT_DIR/vps.sh" "node - '$OAUTH_DIR' revoke $CLIENT_ID_Q $CONFIRM_FLAG" < "$LIB"
    ;;
  migrate-scopes)
    CONFIRM_FLAG=""
    if [[ "${1:-}" == "--yes" ]]; then
      CONFIRM_FLAG="--yes"
    elif [[ -n "${1:-}" ]]; then
      echo "clients.sh: unrecognized argument '$1' (did you mean --yes?)" >&2
      usage
      exit 2
    fi
    bash "$SCRIPT_DIR/vps.sh" "node - '$OAUTH_DIR' migrate-scopes $CONFIRM_FLAG" < "$LIB"
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    echo "clients.sh: unknown subcommand '$SUBCOMMAND'" >&2
    usage
    exit 2
    ;;
esac
