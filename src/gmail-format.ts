import type { ModifyResult, ParsedEmail } from './gmail-client.js';

/** Default body cap for list-style output. 0 anywhere means "no cap". */
export const DEFAULT_LIST_BODY_CHARS = 2000;

export interface EmailItemOptions {
  includeBody: boolean;
  /** 0 or undefined = emit the entire body. */
  maxBodyChars?: number;
  /**
   * Attachment ids are 300-400 char opaque blobs. They belong on the read path
   * (get_email_thread / get_attachment), not in search listings where they
   * crowd out actual content.
   */
  showAttachmentIds?: boolean;
  /** Name of the tool parameter that lifts the body cap, for the hint text. */
  fullBodyParamHint?: string;
  /**
   * Name of the ENABLED tool that reads attachment content, if any. The server
   * filters its tool list through tools-enabled.json, so pointing at a tool the
   * caller cannot invoke is worse than saying nothing — leave this undefined
   * when no such tool is exposed and the hint says so plainly.
   */
  attachmentReadTool?: string;
}

export function formatEmailItem(email: ParsedEmail, options: EmailItemOptions): string {
  const labelDisplay = email.labelNames?.length ? email.labelNames : email.labels;

  const lines = [
    `**Account**: ${email.accountId} (${email.accountEmail})`,
    `**From**: ${email.from || '(unknown)'}`,
    `**To**: ${email.to || '(unknown)'}`,
    ...(email.cc ? [`**Cc**: ${email.cc}`] : []),
    `**Date**: ${email.date || (email.internalDate ? new Date(email.internalDate).toISOString() : '(unknown)')}`,
    `**Gmail ID**: ${email.id}`,
    `**Thread ID**: ${email.threadId}`,
    ...(email.messageHeaderId ? [`**Message-ID**: ${email.messageHeaderId}`] : []),
    ...(email.inReplyTo ? [`**In-Reply-To**: ${email.inReplyTo}`] : []),
    ...(email.references ? [`**References**: ${email.references}`] : []),
    `**Labels**: ${labelDisplay.length > 0 ? labelDisplay.join(', ') : '(none)'}`,
    `**Label IDs**: ${email.labels.length > 0 ? email.labels.join(', ') : '(none)'}`,
    `**Preview**: ${email.snippet || '(none)'}`,
  ];

  if (options.includeBody) {
    const body = (email.body || '').trim();
    if (body) {
      const cap = options.maxBodyChars ?? 0;
      if (cap > 0 && body.length > cap) {
        const hint = options.fullBodyParamHint
          ? ` — pass ${options.fullBodyParamHint} for the rest`
          : '';
        lines.push(
          `**Body** (truncated: showing ${cap} of ${body.length} characters${hint}):\n${body.slice(0, cap)}…`
        );
      } else {
        lines.push(`**Body** (complete, ${body.length} characters):\n${body}`);
      }
    } else {
      lines.push('**Body**: (empty)');
    }
  }

  if (email.attachments.length > 0) {
    lines.push(`**Attachments** (${email.attachments.length}):`);
    for (const att of email.attachments) {
      const idPart = options.showAttachmentIds ? ` — attachment_id: ${att.id}` : '';
      lines.push(`  - ${att.filename} (${att.contentType}, ${att.sizeBytes} bytes)${idPart}`);
    }
    lines.push(
      options.attachmentReadTool
        ? `  → To read attachment content: call ${options.attachmentReadTool} with account="${email.accountId}" email_id="${email.id}"`
        : `  → Attachment CONTENT cannot be read through this server (no attachment-reading tool is enabled). Only the metadata above is available here; open the message in Gmail to download the file.`
    );
  }

  return lines.join('\n');
}

/**
 * Where one account stands in a paged query.
 *
 * An aggregate call fetches up to `max_results` from EACH account, merges by
 * date and returns the top `max_results` overall. The losers of that merge are
 * real matches that were fetched and not shown, so their ids ride along in
 * `carry` — otherwise the account's Gmail cursor would advance past messages
 * the caller never saw and they would be lost for good.
 */
export interface AccountPageState {
  /** Gmail's `nextPageToken` for this account. Absent = Gmail has no more. */
  cursor?: string;
  /** Ids fetched but NOT yet delivered, newest first. Never dropped. */
  carry?: string[];
  /** Gmail's resultSizeEstimate, carried so it stays stable across pages. */
  estimate?: number;
  /**
   * This account has not been listed yet — set when page 1 failed for it, so a
   * retry starts from the beginning instead of being mistaken for "finished".
   */
  restart?: boolean;
}

const PAGE_TOKEN_VERSION = 2;

/** True when this account has nothing left to deliver or fetch. */
function isExhausted(state: AccountPageState): boolean {
  return !state.cursor && !state.restart && (state.carry?.length ?? 0) === 0;
}

/**
 * One opaque token carrying every account's position — in single-account mode
 * too. Handing back Gmail's raw token whenever only one account had a cursor
 * made an aggregate token indistinguishable from a single-account one, and the
 * decoder then silently restarted every OTHER account at page 1 forever.
 *
 * Returns undefined only when every account is genuinely finished.
 */
export function encodePageToken(states: Record<string, AccountPageState>): string | undefined {
  const entries = Object.entries(states);
  if (entries.length === 0) return undefined;
  if (entries.every(([, state]) => isExhausted(state))) return undefined;
  const payload = { v: PAGE_TOKEN_VERSION, a: Object.fromEntries(entries) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Thrown for a page token that cannot be trusted. Never swallowed. */
export class PageTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageTokenError';
  }
}

const TOKEN_ADVICE =
  'Page tokens are produced by this server and are tied to the exact account scope of the call that produced them. Drop page_token to start the query over from page 1, or re-run the original call to get a fresh token.';

/**
 * Decodes and VALIDATES a page token against the accounts this call targets.
 *
 * Anything unrecognised throws. A token that silently decodes to "start over"
 * is the worst possible outcome: the caller pages forever, getting the same
 * first page back every time and never seeing an error.
 */
export function decodePageToken(
  token: string | undefined,
  accountIds: string[]
): Record<string, AccountPageState> {
  const trimmed = (token ?? '').trim();
  if (!trimmed) return {};

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(trimmed, 'base64url').toString('utf8'));
  } catch {
    throw new PageTokenError(`page_token is not a valid token issued by this server. ${TOKEN_ADVICE}`);
  }

  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new PageTokenError(`page_token did not decode to a page-position object. ${TOKEN_ADVICE}`);
  }

  const envelope = decoded as { v?: unknown; a?: unknown };
  if (envelope.v !== PAGE_TOKEN_VERSION) {
    throw new PageTokenError(
      `page_token is version ${JSON.stringify(envelope.v)}, but this server issues version ${PAGE_TOKEN_VERSION} tokens. ${TOKEN_ADVICE}`
    );
  }
  if (!envelope.a || typeof envelope.a !== 'object' || Array.isArray(envelope.a)) {
    throw new PageTokenError(`page_token is missing its per-account positions. ${TOKEN_ADVICE}`);
  }

  const raw = envelope.a as Record<string, unknown>;
  const tokenAccounts = Object.keys(raw);
  const targeted = new Set(accountIds);
  const unknown = tokenAccounts.filter((id) => !targeted.has(id));
  const missing = accountIds.filter((id) => !(id in raw));
  if (unknown.length > 0 || missing.length > 0) {
    throw new PageTokenError(
      `page_token was issued for account(s) [${tokenAccounts.join(', ')}] but this call targets [${accountIds.join(', ')}]` +
        `${unknown.length > 0 ? `; unknown here: [${unknown.join(', ')}]` : ''}` +
        `${missing.length > 0 ? `; not in the token: [${missing.join(', ')}]` : ''}. ` +
        `Keep the same \`account\` argument when paging. ${TOKEN_ADVICE}`
    );
  }

  const out: Record<string, AccountPageState> = {};
  for (const [accountId, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new PageTokenError(
        `page_token holds a malformed position for account "${accountId}". ${TOKEN_ADVICE}`
      );
    }
    const entry = value as { cursor?: unknown; carry?: unknown; estimate?: unknown; restart?: unknown };
    const state: AccountPageState = {};
    if (entry.cursor !== undefined) {
      if (typeof entry.cursor !== 'string' || entry.cursor === '') {
        throw new PageTokenError(
          `page_token holds a non-string Gmail cursor for account "${accountId}". ${TOKEN_ADVICE}`
        );
      }
      state.cursor = entry.cursor;
    }
    if (entry.carry !== undefined) {
      if (!Array.isArray(entry.carry) || entry.carry.some((id) => typeof id !== 'string' || !id)) {
        throw new PageTokenError(
          `page_token holds a malformed carry-over id list for account "${accountId}". ${TOKEN_ADVICE}`
        );
      }
      state.carry = entry.carry as string[];
    }
    if (entry.estimate !== undefined) {
      if (typeof entry.estimate !== 'number' || !Number.isFinite(entry.estimate)) {
        throw new PageTokenError(
          `page_token holds a non-numeric estimate for account "${accountId}". ${TOKEN_ADVICE}`
        );
      }
      state.estimate = entry.estimate;
    }
    if (entry.restart === true) state.restart = true;
    out[accountId] = state;
  }
  return out;
}

/** One account's contribution to a page, before the cross-account merge. */
export interface AccountPageCandidates {
  accountId: string;
  /** Candidate messages for this page, newest first. Empty if the fetch failed. */
  candidates: ParsedEmail[];
  /** Gmail cursor to use for this account's NEXT list call. */
  cursor?: string;
  estimate?: number;
  /**
   * Set when this account's fetch threw. Its incoming position is preserved
   * verbatim so a retry resumes exactly where it left off.
   */
  failedWithState?: AccountPageState;
}

/**
 * Merges the per-account candidates into one page and works out where each
 * account now stands.
 *
 * The invariant this exists to enforce: every candidate that is fetched but not
 * returned ends up in the next token's `carry`. Nothing is fetched and dropped.
 */
export function planPage(
  accounts: AccountPageCandidates[],
  maxResults: number
): { returned: ParsedEmail[]; nextStates: Record<string, AccountPageState> } {
  const merged = accounts
    .flatMap((entry) => entry.candidates)
    .sort((a, b) => b.internalDate - a.internalDate);
  const returned = merged.slice(0, Math.max(0, maxResults));

  const deliveredKeys = new Set(returned.map((email) => `${email.accountId}:${email.id}`));

  const nextStates: Record<string, AccountPageState> = {};
  for (const entry of accounts) {
    if (entry.failedWithState) {
      nextStates[entry.accountId] = entry.failedWithState;
      continue;
    }
    const carry = entry.candidates
      .filter((email) => !deliveredKeys.has(`${entry.accountId}:${email.id}`))
      .map((email) => email.id);
    const state: AccountPageState = {};
    if (entry.cursor) state.cursor = entry.cursor;
    if (carry.length > 0) state.carry = carry;
    if (typeof entry.estimate === 'number') state.estimate = entry.estimate;
    nextStates[entry.accountId] = state;
  }

  return { returned, nextStates };
}

export function formatEmailListOutput(input: {
  title: string;
  scopeText: string;
  queryText: string;
  /**
   * Gmail's resultSizeEstimate per account. Undefined entries mean Gmail did
   * not report one — never substitute the number of rows we happen to return.
   */
  estimates: Array<{ accountId: string; estimate?: number }>;
  returned: ParsedEmail[];
  itemOptions: EmailItemOptions;
  nextPageToken?: string;
  errors: string[];
  /** Non-fatal problems with the query itself (e.g. an unresolvable label id). */
  warnings?: string[];
}): string {
  const sections: string[] = [];

  sections.push(`# ${input.title}`);
  sections.push('');

  // Errors first: in aggregate mode a silent per-account failure is otherwise
  // indistinguishable from "that inbox had no matches".
  if (input.errors.length > 0) {
    sections.push('> ⚠️ **Some accounts failed — these results are INCOMPLETE.**');
    sections.push(input.errors.map((error) => `> - ${error}`).join('\n'));
    sections.push('');
  }

  // A query clause that cannot match anything looks exactly like "no results".
  if (input.warnings && input.warnings.length > 0) {
    sections.push('> ⚠️ **Query warnings — part of this query may match nothing.**');
    sections.push(input.warnings.map((warning) => `> - ${warning}`).join('\n'));
    sections.push('');
  }

  sections.push(`**Scope**: ${input.scopeText}`);
  sections.push(`**Query**: ${input.queryText || '(none)'}`);
  sections.push(`**Returned**: ${input.returned.length}`);

  const known = input.estimates.filter((entry) => typeof entry.estimate === 'number');
  if (known.length === 0) {
    sections.push('**Estimated Total Matches**: unknown (Gmail did not report an estimate)');
  } else {
    const total = known.reduce((sum, entry) => sum + (entry.estimate ?? 0), 0);
    const breakdown =
      input.estimates.length > 1
        ? ` (${input.estimates
            .map((entry) => `${entry.accountId}: ${entry.estimate ?? 'unknown'}`)
            .join(', ')})`
        : '';
    sections.push(
      `**Estimated Total Matches**: ~${total}${breakdown} — Gmail's own resultSizeEstimate for the whole query, approximate and independent of max_results.`
    );
  }

  if (input.nextPageToken) {
    sections.push(`**More Results Available**: yes`);
    sections.push(`**Next Page Token**: ${input.nextPageToken}`);
    sections.push(
      '(Pass this back as `page_token` with the same query, max_results AND account scope. It carries every queried account\'s position, including matches already fetched but not shown on this page.)'
    );
  } else if (input.errors.length > 0) {
    sections.push(
      '**More Results Available**: no more pages for the accounts that answered — but the failed account(s) above returned nothing, so this is NOT a complete result set.'
    );
  } else {
    sections.push(
      '**More Results Available**: no — every account queried has been fully paged through and nothing fetched was withheld.'
    );
  }

  if (input.returned.length > 0) {
    sections.push('');
    input.returned.forEach((email, index) => {
      sections.push(`## ${index + 1}. ${email.subject || '(no subject)'}`);
      sections.push(formatEmailItem(email, input.itemOptions));
      sections.push('');
    });
  }

  return sections.join('\n');
}

/** Renders a verified ModifyResult truthfully, including what did NOT happen. */
export function formatModifyResult(input: {
  verb: string;
  accountId: string;
  result: ModifyResult;
  extra?: string[];
  threadHint?: string;
}): string {
  const { result } = input;
  const total = result.requested.length;
  const ok = result.modified.length;
  const allGood = ok === total;

  const lines = [
    `${allGood ? '✅' : '⚠️'} ${input.verb}: ${ok} of ${total} message(s) verified in account ${input.accountId}.`,
  ];

  for (const extra of input.extra ?? []) lines.push(`- ${extra}`);

  if (result.notFound.length > 0) {
    lines.push(
      `- ❌ ${result.notFound.length} not found (no such message in this account — nothing was changed): ${result.notFound.join(', ')}`
    );
    lines.push(
      `- Message ids are per-account. Check the account, or re-run search_emails to get current ids.`
    );
  }
  if (result.unverified.length > 0) {
    lines.push(
      `- ❓ ${result.unverified.length} UNCONFIRMED — not the same as failed: ${result.unverified.join(', ')}`
    );
    lines.push(
      `- Gmail accepted the change; the read-back that proves it either errored or came back without the expected labels. The change may well have been applied. Do NOT report these as failures — re-run the same call (it is idempotent) or look at the messages in Gmail to settle it.`
    );
  }
  if (result.threadIdLookalikes.length > 0 && input.threadHint) {
    lines.push(
      `- ℹ️ These ids are also thread ids, so only the FIRST message of each conversation was changed: ${result.threadIdLookalikes.join(', ')}. ${input.threadHint}`
    );
  }

  return lines.join('\n');
}
