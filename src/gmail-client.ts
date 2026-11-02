import { OAuth2Client, type Credentials } from 'google-auth-library';
import { google, type calendar_v3, type docs_v1, type drive_v3, type gmail_v1, type sheets_v4 } from 'googleapis';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { AccountConfig, type AccountPaths, getAccountPaths } from './config.js';
import { buildRawMessage } from './compose.js';
import { assertAddressAllowed, assertSendAllowed } from './allowlist.js';
// Type-only: erased at compile time, so this does not create a runtime cycle
// with gmail-format.ts (which imports ParsedEmail/ModifyResult from here).
import type { AccountPageState } from './gmail-format.js';

export const GMAIL_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.basic',
] as const;

export const DRIVE_METADATA_SCOPE =
  'https://www.googleapis.com/auth/drive.metadata.readonly' as const;

export const DRIVE_FULL_SCOPE =
  'https://www.googleapis.com/auth/drive' as const;

export const SHEETS_SCOPE =
  'https://www.googleapis.com/auth/spreadsheets' as const;

export const DOCS_SCOPE =
  'https://www.googleapis.com/auth/documents' as const;

export const CALENDAR_SCOPE =
  'https://www.googleapis.com/auth/calendar' as const;

export const GOOGLE_ACCOUNT_SCOPES = [
  ...GMAIL_SCOPES,
  DRIVE_FULL_SCOPE,
  SHEETS_SCOPE,
  DOCS_SCOPE,
  CALENDAR_SCOPE,
] as const;

export interface AttachmentMetadata {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  isInline: boolean;
}

export interface ParsedEmail {
  id: string;
  threadId: string;
  snippet: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  internalDate: number;
  messageHeaderId: string;
  inReplyTo: string;
  references: string;
  body?: string;
  /** Raw Gmail labelIds, e.g. INBOX, UNREAD, STARRED, Label_5. */
  labels: string[];
  /** `labels` resolved to display names where the label map was available. */
  labelNames?: string[];
  attachments: AttachmentMetadata[];
  accountId: string;
  accountEmail: string;
}

export interface ParsedThread {
  threadId: string;
  messages: ParsedEmail[];
}

export interface LabelInfo {
  id: string;
  name: string;
  type?: string;
  /**
   * Undefined means "Gmail did not report a count" — which is the normal case
   * for `users.labels.list`. Callers MUST render `undefined` as "unknown" and
   * never as `0`; printing a fabricated `0` is worse than printing nothing.
   */
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
}

/**
 * Result of a label/state mutation that has been VERIFIED against Gmail rather
 * than assumed from the request. `messages.batchModify` returns HTTP 204 with
 * an empty body and silently ignores ids that do not exist, so the only way to
 * report a truthful count is to read the affected messages back.
 */
export interface ModifyResult {
  /** Ids that were asked for (deduped/trimmed). */
  requested: string[];
  /** Ids confirmed to be in the requested state afterwards. */
  modified: string[];
  /** Ids Gmail has no message for. Nothing happened to these. */
  notFound: string[];
  /**
   * Ids whose outcome is UNKNOWN — not ids that failed.
   *
   * Gmail accepted the mutation; the read-back either errored (after retries)
   * or came back without the expected labels. The change may well have landed.
   * Anything rendering this must not describe it as a failure.
   */
  unverified: string[];
  /**
   * Modified ids whose message id equals its thread id — i.e. the caller may
   * have passed a THREAD id intending to act on the whole conversation, but
   * only the first message was touched.
   */
  threadIdLookalikes: string[];
}

export interface MessageListPage {
  messages: ParsedEmail[];
  /**
   * Gmail's own `resultSizeEstimate` for the query. It is an ESTIMATE from
   * Gmail, not a count of what we returned. Undefined if Gmail omitted it.
   */
  resultSizeEstimate?: number;
  /** Gmail's cursor for this account's NEXT list call, if any remain. */
  nextPageToken?: string;
  /** Non-fatal problems with the query (e.g. an unresolvable `label:` id). */
  warnings?: string[];
}

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  owners: string[];
  webViewLink?: string;
  accountId: string;
  accountEmail: string;
}

export interface DriveFileDetail extends DriveFileSummary {
  createdTime?: string;
  size?: number;
  parents?: string[];
  trashed?: boolean;
  starred?: boolean;
  shared?: boolean;
  exportLinks?: Record<string, string>;
}

export interface SpreadsheetSheetInfo {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number;
  columnCount: number;
}

export interface SpreadsheetMetadata {
  id: string;
  title: string;
  url: string;
  sheets: SpreadsheetSheetInfo[];
}

export interface CalendarInfo {
  id: string;
  summary: string;
  description?: string;
  primary?: boolean;
  /** Shown in the owner's Google Calendar sidebar (calendarList.selected). list_events sweeps these by default. */
  selected?: boolean;
  accessRole?: string;
  backgroundColor?: string;
  timeZone?: string;
  accountId: string;
  accountEmail: string;
}

export interface CalendarEventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  /** The calendar's display name, when the caller knew it (list_events' sweep sets it). */
  calendarSummary?: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees: CalendarEventAttendee[];
  organizer?: { email: string; displayName?: string; self?: boolean };
  status?: string;
  htmlLink?: string;
  recurrence?: string[];
  recurringEventId?: string;
  created?: string;
  updated?: string;
  conferenceData?: { entryPoints?: Array<{ uri: string; entryPointType: string }> };
  accountId: string;
  accountEmail: string;
}

interface OAuthClientOptions {
  credentials: unknown;
}

export interface EmailAttachment {
  path: string;
  filename?: string;
  contentType?: string;
}

/**
 * Application-level input for an outgoing message. `body` is plain text with a
 * small markdown-ish subset; both the text/plain and text/html MIME parts are
 * derived from it in src/compose.ts. There is no "html" flag: callers never
 * hand us raw HTML, because then the two parts could disagree.
 */
export interface OutgoingMessageInput {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  attachments?: EmailAttachment[];
  inReplyTo?: string;
  references?: string;
  /**
   * Append this account's Gmail signature.
   *
   * Deliberately a BOOLEAN, not the signature markup. Signature HTML is trusted
   * HTML (see src/compose.ts) and the only way to earn that trust is to have
   * come from `users.settings.sendAs` for this very account — so the markup is
   * fetched here, inside the client, and there is no field on this type for a
   * caller to put HTML into.
   */
  includeSignature?: boolean;
}

/** One account's Gmail-configured signature, exactly as Gmail stores it. */
export interface AccountSignature {
  /** The sendAs address the signature was read from. */
  sendAsEmail: string;
  /** Gmail stores signatures as HTML. Empty string means none configured. */
  signatureHtml: string;
  isDefault: boolean;
  /** True when a sendAs entry for this account's own address was found. */
  matchedAccountEmail: boolean;
  /** Every sendAs address on the account, for reporting when nothing matched. */
  availableSendAs: string[];
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function decodeBase64UrlBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function isInlineDisposition(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
): boolean {
  if (!headers) return false;
  const disposition = headers.find((h) => h.name?.toLowerCase() === 'content-disposition');
  return Boolean(disposition?.value?.trim().toLowerCase().startsWith('inline'));
}

function extractAttachmentsMetadata(
  payload: gmail_v1.Schema$MessagePart | undefined,
): AttachmentMetadata[] {
  if (!payload) return [];

  const out: AttachmentMetadata[] = [];
  const consider = (part: gmail_v1.Schema$MessagePart) => {
    if (!part.filename) return;
    if (part.body?.attachmentId) {
      out.push({
        id: part.body.attachmentId,
        filename: part.filename,
        contentType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: Number(part.body.size ?? 0),
        isInline: isInlineDisposition(part.headers),
      });
    } else if (part.body?.data) {
      // Small attachment inlined by Gmail — use a synthetic ID so agents can fetch it
      out.push({
        id: `inline:${part.filename}`,
        filename: part.filename,
        contentType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: Number(part.body.size ?? 0),
        isInline: isInlineDisposition(part.headers),
      });
    }
  };

  consider(payload);

  const stack: gmail_v1.Schema$MessagePart[] = payload.parts ? [...payload.parts] : [];
  while (stack.length > 0) {
    const part = stack.shift();
    if (!part) continue;
    consider(part);
    if (part.parts?.length) stack.push(...part.parts);
  }

  return out;
}

function collectAttachmentParts(
  payload: gmail_v1.Schema$MessagePart | undefined,
): gmail_v1.Schema$MessagePart[] {
  if (!payload) return [];

  const out: gmail_v1.Schema$MessagePart[] = [];
  const consider = (part: gmail_v1.Schema$MessagePart) => {
    if (part.filename && part.body?.attachmentId && !isInlineDisposition(part.headers)) {
      out.push(part);
    }
  };

  consider(payload);
  const stack: gmail_v1.Schema$MessagePart[] = payload.parts ? [...payload.parts] : [];
  while (stack.length > 0) {
    const part = stack.shift();
    if (!part) continue;
    consider(part);
    if (part.parts?.length) stack.push(...part.parts);
  }

  return out;
}

function findAttachmentPart(
  payload: gmail_v1.Schema$MessagePart | undefined,
  attachmentId: string,
): gmail_v1.Schema$MessagePart | null {
  if (!payload) return null;
  if (payload.body?.attachmentId === attachmentId) return payload;

  const stack: gmail_v1.Schema$MessagePart[] = payload.parts ? [...payload.parts] : [];
  while (stack.length > 0) {
    const part = stack.shift();
    if (!part) continue;
    if (part.body?.attachmentId === attachmentId) return part;
    if (part.parts?.length) stack.push(...part.parts);
  }

  return null;
}

function findAttachmentPartByFilename(
  payload: gmail_v1.Schema$MessagePart | undefined,
  filename: string,
): gmail_v1.Schema$MessagePart | null {
  if (!payload) return null;
  if (payload.filename === filename && payload.body?.data) return payload;

  const stack: gmail_v1.Schema$MessagePart[] = payload.parts ? [...payload.parts] : [];
  while (stack.length > 0) {
    const part = stack.shift();
    if (!part) continue;
    if (part.filename === filename && part.body?.data) return part;
    if (part.parts?.length) stack.push(...part.parts);
  }

  return null;
}

function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getHeaderValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  if (!headers) return '';
  const found = headers.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return found?.value?.trim() ?? '';
}

function extractEmailBody(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return '';

  if (payload.body?.data && !payload.parts?.length) {
    return decodeBase64Url(payload.body.data);
  }

  if (!payload.parts || payload.parts.length === 0) {
    return '';
  }

  let textPlain = '';
  let textHtml = '';

  const stack = [...payload.parts];
  while (stack.length > 0) {
    const part = stack.shift();
    if (!part) continue;

    if (part.parts?.length) {
      stack.push(...part.parts);
    }

    if (!part.body?.data) continue;

    if (part.mimeType === 'text/plain' && !textPlain) {
      textPlain = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && !textHtml) {
      textHtml = decodeBase64Url(part.body.data);
    }
  }

  if (textPlain) return textPlain;
  if (textHtml) return stripHtmlTags(textHtml);

  return '';
}

// Used by the Drive upload path (not by email composition — that lives in
// src/compose.ts and lets nodemailer detect types).
function inferContentType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  switch (extension) {
    case '.pdf':
      return 'application/pdf';
    case '.txt':
      return 'text/plain';
    case '.csv':
      return 'text/csv';
    case '.json':
      return 'application/json';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.doc':
      return 'application/msword';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:
      return 'application/octet-stream';
  }
}

function normalizeAttachments(attachments?: EmailAttachment[]): EmailAttachment[] {
  return (attachments ?? [])
    .map((attachment) => ({
      path: attachment.path.trim(),
      filename: attachment.filename?.trim() || undefined,
      contentType: attachment.contentType?.trim() || undefined,
    }))
    .filter((attachment) => attachment.path !== '');
}

/**
 * The one and only path from application input to MIME bytes.
 * Everything outgoing funnels through src/compose.ts — see that file for why.
 *
 * `signatureHtml` is a SEPARATE parameter rather than a field on
 * `OutgoingMessageInput` on purpose: application input (which ultimately comes
 * from MCP tool arguments) has no way to reach it. The only caller that supplies
 * it is GmailAccountClient.buildOutgoing, from users.settings.sendAs.
 */
async function createRawEmailMessage(
  input: OutgoingMessageInput,
  signatureHtml?: string
): Promise<string> {
  return buildRawMessage({
    to: input.to,
    subject: input.subject,
    body: input.body,
    from: input.from,
    cc: input.cc,
    bcc: input.bcc,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: normalizeAttachments(input.attachments),
    signatureHtml,
  });
}

export function createOAuthClientFromCredentials(options: OAuthClientOptions): OAuth2Client {
  if (!options.credentials || typeof options.credentials !== 'object') {
    throw new Error('Invalid credentials content.');
  }

  const credentialsObject = options.credentials as {
    installed?: {
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
    };
    web?: {
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
    };
  };

  const source = credentialsObject.installed ?? credentialsObject.web;
  if (!source?.client_id || !source.client_secret) {
    throw new Error('Credentials must include client_id and client_secret under "installed" or "web".');
  }

  const redirectUri = source.redirect_uris?.[0] ?? 'http://localhost';
  return new OAuth2Client(source.client_id, source.client_secret, redirectUri);
}

export async function readCredentialsFile(credentialsPath: string): Promise<unknown> {
  const raw = await fs.readFile(credentialsPath, 'utf8');
  return JSON.parse(raw);
}

export async function buildOAuthClientFromCredentialsFile(
  credentialsPath: string
): Promise<OAuth2Client> {
  const credentials = await readCredentialsFile(credentialsPath);
  return createOAuthClientFromCredentials({ credentials });
}

export function generateAuthUrlFromCredentials(credentials: unknown): {
  oauth2Client: OAuth2Client;
  authUrl: string;
} {
  const oauth2Client = createOAuthClientFromCredentials({ credentials });
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [...GOOGLE_ACCOUNT_SCOPES],
    prompt: 'consent',
  });
  return { oauth2Client, authUrl };
}

export async function exchangeCodeForToken(
  credentials: unknown,
  authorizationCode: string
): Promise<Credentials> {
  const oauth2Client = createOAuthClientFromCredentials({ credentials });
  const { tokens } = await oauth2Client.getToken(authorizationCode);
  return tokens;
}

function sanitizeMessageIds(messageIds: string[]): string[] {
  return Array.from(
    new Set(
      messageIds
        .map((messageId) => messageId.trim())
        .filter((messageId) => messageId.length > 0)
    )
  );
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * The `type` filter search_drive_files accepts (plan 002 Phase 3), mapped to
 * the Drive `mimeType` clause it becomes. `any` (or omitted) adds no clause.
 */
export const DRIVE_FILE_TYPES = {
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  document: 'application/vnd.google-apps.document',
  folder: 'application/vnd.google-apps.folder',
  pdf: 'application/pdf',
  presentation: 'application/vnd.google-apps.presentation',
} as const;
export type DriveFileType = keyof typeof DRIVE_FILE_TYPES | 'any';

export function buildDriveSearchQuery(query: string, type?: DriveFileType): string {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new Error('Drive search query is required.');
  }

  const escapedQuery = escapeDriveQueryValue(normalizedQuery);
  const parts = [`trashed = false`, `(name contains '${escapedQuery}' or fullText contains '${escapedQuery}')`];
  if (type && type !== 'any') {
    const mime = DRIVE_FILE_TYPES[type];
    if (!mime) {
      throw new Error(`Unknown type "${type}". Use one of: ${Object.keys(DRIVE_FILE_TYPES).join(', ')}, any.`);
    }
    parts.push(`mimeType = '${mime}'`);
  }
  return parts.join(' and ');
}

export type GoogleService = 'Drive' | 'Sheets' | 'Docs' | 'Calendar';

/**
 * Turns a googleapis error from any Workspace service into the sentence the
 * spec asks for at the point of use: a disabled API names the API and the
 * activation link; a missing scope or a dead refresh token says the OWNER
 * must re-consent on the server (no in-server auth tool is listed on any
 * endpoint); a 404 says "not found in this account" so the caller tries the
 * other account instead of concluding the file does not exist.
 */
export function describeGoogleApiError(
  error: unknown,
  opts: { service: GoogleService; accountId?: string; fallback: string },
): string {
  const googleError = error as {
    code?: number | string;
    message?: string;
    response?: {
      status?: number;
      data?: {
        error?: string | {
          message?: string;
          details?: Array<{
            '@type'?: string;
            reason?: string;
            metadata?: {
              activationUrl?: string;
              containerInfo?: string;
            };
          }>;
        };
        error_description?: string;
      };
    };
  };

  const dataError = typeof googleError.response?.data?.error === 'object' ? googleError.response.data.error : undefined;
  const message =
    dataError?.message ||
    (typeof googleError.response?.data?.error === 'string' ? googleError.response.data.error : undefined) ||
    googleError.message ||
    opts.fallback;
  const details = dataError?.details ?? [];
  const serviceDisabled = details.find((detail) => detail.reason === 'SERVICE_DISABLED');
  const rawCode = googleError.code ?? googleError.response?.status;
  const code = typeof rawCode === 'string' && /^\d+$/.test(rawCode) ? Number(rawCode) : rawCode;
  const account = opts.accountId ? `account "${opts.accountId}"` : 'this account';
  const reconsent = opts.accountId
    ? `The owner must re-consent on the server: node tools/reauth.mjs ${opts.accountId}`
    : 'The owner must re-consent on the server (node tools/reauth.mjs <account>).';

  if (serviceDisabled) {
    const activationUrl = serviceDisabled.metadata?.activationUrl;
    const projectId = serviceDisabled.metadata?.containerInfo;
    const parts = [`Enable the Google ${opts.service} API in Google Cloud for this OAuth client project first.`];
    if (projectId) parts.push(`Project: ${projectId}.`);
    if (activationUrl) parts.push(`Activation URL: ${activationUrl}`);
    return parts.join(' ');
  }

  if (/invalid_grant/i.test(message) || /invalid_grant/i.test(googleError.response?.data?.error_description ?? '')) {
    return `Google authorization for ${account} has lapsed (invalid_grant). ${reconsent}`;
  }

  if (code === 403 && /insufficient.*scope|insufficient.*permission|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message)) {
    return `${account} has not consented to Google ${opts.service} access (token lacks the scope). ${reconsent}`;
  }

  if (code === 404) {
    return `Not found in ${account} (${opts.service}: ${message}). An id belongs to one account's view -- try the other account before concluding it does not exist.`;
  }

  if (code === 429 || /rate ?limit|quota exceeded/i.test(message)) {
    return `Google ${opts.service} rate limit hit for ${account}: ${message}. Wait a moment and retry.`;
  }

  return message;
}

/** Drive-only wrapper kept for the pre-Phase-3 call sites and test/drive-error.test.mjs. */
export function describeDriveApiError(error: unknown, fallback: string, accountId?: string): string {
  return describeGoogleApiError(error, { service: 'Drive', accountId, fallback });
}

interface GoogleApiErrorShape {
  code?: number | string;
  status?: number | string;
  message?: string;
  errors?: Array<{ message?: string; reason?: string }>;
  response?: {
    status?: number;
    data?: {
      error?:
        | string
        | {
            code?: number;
            message?: string;
            status?: string;
            errors?: Array<{ message?: string; reason?: string }>;
          };
      error_description?: string;
    };
  };
}

export interface GmailErrorContext {
  accountId?: string;
  accountEmail?: string;
  labelIds?: string[];
  messageIds?: string[];
  threadId?: string;
  operation?: string;
}

function gmailErrorParts(error: unknown): {
  status: number | undefined;
  message: string;
  reasons: string[];
} {
  const err = (error ?? {}) as GoogleApiErrorShape;
  const rawStatus = err.code ?? err.status ?? err.response?.status;
  const status =
    typeof rawStatus === 'number'
      ? rawStatus
      : typeof rawStatus === 'string' && /^\d+$/.test(rawStatus)
        ? Number(rawStatus)
        : undefined;

  const data = err.response?.data;
  const dataError = typeof data?.error === 'object' ? data.error : undefined;
  const message =
    dataError?.message ||
    (typeof data?.error === 'string' ? data.error : undefined) ||
    data?.error_description ||
    err.message ||
    '';

  const reasons = [...(err.errors ?? []), ...(dataError?.errors ?? [])]
    .map((entry) => entry.reason ?? '')
    .filter(Boolean);

  return { status, message, reasons };
}

function describeAccount(context: GmailErrorContext): string {
  if (!context.accountId) return 'this account';
  return context.accountEmail
    ? `account "${context.accountId}" (${context.accountEmail})`
    : `account "${context.accountId}"`;
}

/**
 * Turns a raw googleapis Gmail error into something a model (or a human) can
 * act on. The spec calls out two failures by name that must never be vague:
 * expired credentials and rate limiting. Everything else falls through to a
 * message that at least names the account and the ids involved, so that a
 * per-account failure in aggregate mode is never mistaken for "no results".
 */
export function describeGmailApiError(
  error: unknown,
  fallback: string,
  context: GmailErrorContext = {}
): string {
  const { status, message, reasons } = gmailErrorParts(error);
  const who = describeAccount(context);
  const detail = message || fallback;
  const said = message ? ` Gmail said: "${message}".` : '';
  // Do NOT point at begin_account_auth / finish_account_auth here: both are
  // filtered out by tools-enabled.json and are rejected before they ever run,
  // so naming them sends the caller into a dead end. Re-auth is an operator
  // task performed on the server host with the repo script.
  const reAuth = context.accountId
    ? ` Fixing this is an OWNER task on the server, not something callable from here: run \`node tools/reauth.mjs ${context.accountId}\` on the VPS, open the printed consent URL, then re-run it with the returned code. No tool exposed by this server can re-authorize an account.`
    : ' Fixing this is an OWNER task on the server, not something callable from here: run `node tools/reauth.mjs <account>` on the VPS, open the printed consent URL, then re-run it with the returned code. No tool exposed by this server can re-authorize an account.';

  const isAuth =
    status === 401 ||
    reasons.some((reason) => /authError|invalid_grant|unauthorized|invalidCredentials/i.test(reason)) ||
    /invalid[_ ]grant|invalid credentials|token has been expired or revoked|invalid authentication/i.test(
      detail
    );
  if (isAuth) {
    return `Gmail authentication failed for ${who} — this account's token needs re-auth.${reAuth}${said}`;
  }

  const isRateLimited =
    status === 429 ||
    reasons.some((reason) =>
      /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded|backendError/i.test(reason)
    ) ||
    /rate limit|too many requests|user-rate limit|quota exceeded/i.test(detail);
  if (isRateLimited) {
    return `Gmail rate limit / quota exceeded for ${who}. This is a wait-and-retry condition, not a permanent failure: pause ~30-60s, then retry (lowering max_results or batching fewer ids also helps).${said}`;
  }

  if (status === 403 && /insufficient.*(scope|permission)/i.test(detail)) {
    return `Gmail access scope is insufficient for ${who}.${reAuth}${said}`;
  }

  const labelList = (context.labelIds ?? []).filter(Boolean);
  const looksLikeLabelProblem =
    /invalid label|labelid not found|label not found|invalid label id/i.test(detail) ||
    (labelList.length > 0 && (status === 400 || status === 500));
  if (labelList.length > 0 && looksLikeLabelProblem) {
    return [
      `Gmail rejected the label id(s) [${labelList.join(', ')}] for ${who}.`,
      `Label ids are per-account and are NOT the label's display name — get the exact id from get_labels for this same account.`,
      `Note that reserved names such as "MUTE" and "YELLOW_STAR" are not modifiable label ids.`,
      `In a *search* query use the display name instead: label:"My Label".`,
      said.trim(),
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (status === 404) {
    const what = context.threadId
      ? `thread ${context.threadId}`
      : context.messageIds?.length
        ? `message id(s) [${context.messageIds.join(', ')}]`
        : 'the requested resource';
    return `Not found in ${who}: Gmail has no ${what}. Ids are per-account — an id from one inbox will not resolve in the other.${said}`;
  }

  if (status === 400) {
    return `Gmail rejected the request for ${who} as malformed (HTTP 400).${said} Check ids, label ids, and query syntax.`;
  }

  if (status !== undefined && status >= 500) {
    return [
      `Gmail returned a server error (HTTP ${status}) for ${who}.${said}`,
      `This is usually transient — retry once.`,
      labelList.length > 0
        ? `If it repeats, one of the supplied label ids [${labelList.join(', ')}] is probably invalid (Gmail reports some bad label ids as a 500).`
        : `If it repeats, one of the supplied ids is probably invalid.`,
    ].join(' ');
  }

  return context.accountId ? `${who}: ${detail}` : detail;
}

/** Matches `label:Label_123` / `-label:Label_123` (Gmail user-label id form). */
const LABEL_ID_IN_QUERY = /(-?label:)(Label_[A-Za-z0-9_-]+)/gi;

/**
 * Splits a Gmail query into quoted and unquoted runs, preserving every
 * character so the pieces rejoin into the original string.
 *
 * Anything inside `"..."` is a literal phrase Gmail searches for verbatim —
 * `subject:"see label:Label_1 here"` must come out untouched. An unterminated
 * quote swallows the rest of the string, which is how Gmail reads it too.
 */
function splitQuotedSegments(query: string): Array<{ quoted: boolean; text: string }> {
  const segments: Array<{ quoted: boolean; text: string }> = [];
  let index = 0;
  let start = 0;
  while (index < query.length) {
    if (query[index] !== '"') {
      index += 1;
      continue;
    }
    if (index > start) segments.push({ quoted: false, text: query.slice(start, index) });
    const close = query.indexOf('"', index + 1);
    if (close === -1) {
      segments.push({ quoted: true, text: query.slice(index) });
      return segments;
    }
    segments.push({ quoted: true, text: query.slice(index, close + 1) });
    index = close + 1;
    start = index;
  }
  if (start < query.length) segments.push({ quoted: false, text: query.slice(start) });
  return segments;
}

export function queryHasLabelIdCandidate(query: string): boolean {
  return splitQuotedSegments(query).some((segment) => {
    if (segment.quoted) return false;
    LABEL_ID_IN_QUERY.lastIndex = 0;
    return LABEL_ID_IN_QUERY.test(segment.text);
  });
}

/**
 * A display name safe to drop into a `label:` clause bare. Anything else — a
 * space, a quote, a paren, a brace, a colon, a backslash, a leading `-` — has
 * meaning in Gmail's query grammar and must be quoted or refused.
 */
const BARE_LABEL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

export interface LabelRewriteResult {
  query: string;
  /** Non-fatal problems the caller must surface; each names the exact id. */
  warnings: string[];
}

/**
 * Gmail's `label:` operator matches on a label's DISPLAY NAME. A label id
 * (`label:Label_5459357416068177365`) silently matches zero messages — and our
 * own get_labels shows ids prominently, which invites exactly that mistake.
 * This rewrites recognized ids to their correctly quoted display name.
 *
 * Two things it deliberately does NOT do:
 *  - rewrite inside a quoted phrase (that would corrupt a literal search);
 *  - emit a clause it cannot quote faithfully. Confirmed live against the
 *    Gmail API (2026-09-15, see docs/tickets/005): simply wrapping a name in
 *    `"..."` does not work for `(` `)` `{` `}` `[` `]` `:` the way it does for
 *    a plain space, and a `"` or `\` has no escape at all in Gmail's query
 *    grammar. A name containing any of these is reported as a warning instead
 *    of being silently mangled into a clause that matches nothing.
 */
const UNQUOTABLE_LABEL_CHARS = /["\\(){}[\]:]/;
export function rewriteLabelIdsInQuery(
  query: string,
  nameMap: Map<string, string>
): LabelRewriteResult {
  const warnings: string[] = [];

  const rewritten = splitQuotedSegments(query)
    .map((segment) => {
      if (segment.quoted) return segment.text;
      LABEL_ID_IN_QUERY.lastIndex = 0;
      return segment.text.replace(LABEL_ID_IN_QUERY, (match, prefix: string, labelId: string) => {
        const name = nameMap.get(labelId);
        if (!name) {
          warnings.push(
            `\`${match}\` — no label with id ${labelId} exists in this account. Gmail's label: operator matches the DISPLAY NAME, not the id, so this clause matches ZERO messages and was left as-is. Run get_labels for this account and use the name (quoted if it contains spaces).`
          );
          return match;
        }
        if (UNQUOTABLE_LABEL_CHARS.test(name)) {
          warnings.push(
            `\`${match}\` resolves to the label named ${JSON.stringify(name)}, which contains a character Gmail's search syntax cannot express in a label: clause (a quote, backslash, parenthesis, brace, bracket, or colon). The clause was left as-is and matches ZERO messages. Filter on a parent label, or use label_messages/unlabel_messages with the label id instead of searching for it.`
          );
          return match;
        }
        return `${prefix}${BARE_LABEL_NAME.test(name) ? name : `"${name}"`}`;
      });
    })
    .join('');

  return { query: rewritten, warnings };
}

function isNotFoundError(error: unknown): boolean {
  const { status, message } = gmailErrorParts(error);
  return status === 404 || /not found/i.test(message);
}

/** 429 and 5xx are Gmail saying "later", not "no". */
export function isRetryableGmailError(error: unknown): boolean {
  const { status, message, reasons } = gmailErrorParts(error);
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  if (
    reasons.some((reason) =>
      /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|backendError|internalError/i.test(reason)
    )
  ) {
    return true;
  }
  return /rate limit|too many requests|user-rate limit|backend error/i.test(message);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries a Gmail call on 429/5xx with exponential backoff and jitter.
 *
 * This matters most on the post-mutation read-back: without it a single rate
 * limit turns a mutation that ACTUALLY SUCCEEDED into a reported failure. The
 * read-back is also the densest part of the request (5 quota units per id), so
 * it is the path most likely to trip the limit it then has to survive.
 */
export async function withGmailRetry<T>(
  operation: () => Promise<T>,
  options: { retries?: number; baseDelayMs?: number; maxDelayMs?: number } = {}
): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 4000;

  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isRetryableGmailError(error)) throw error;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await sleep(backoff + Math.floor(Math.random() * baseDelayMs));
      attempt += 1;
    }
  }
}

/**
 * In-flight `messages.get` read-backs. See verifyMessageLabels for the quota
 * arithmetic that picked this number.
 */
const VERIFY_CONCURRENCY = 4;

/** Ids per batchModify request. Gmail's own ceiling is 1000; this is quota. */
const BATCH_MODIFY_CHUNK = 100;

/**
 * Hard ceiling on ids per mutating call. Every id costs 5 quota units to read
 * back, so 1000 ids (Gmail's batchModify max) is 5000 units — twenty seconds of
 * the entire per-user budget for one tool call. Refusing loudly beats being
 * throttled into a pile of unconfirmed results.
 */
export const MAX_MODIFY_IDS = 200;

function assertModifyBatchSize(ids: string[]): void {
  if (ids.length > MAX_MODIFY_IDS) {
    throw new Error(
      `Too many message ids in one call: ${ids.length} (limit ${MAX_MODIFY_IDS}). Each id costs a verification read-back, and a batch this size would exhaust Gmail's per-user rate limit and come back mostly unconfirmed. Split the ids across several calls of ${MAX_MODIFY_IDS} or fewer.`
    );
  }
}

function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

/** Runs `worker` over `items` with a bounded number of in-flight requests. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

const WORKSPACE_EXPORT_MAP: Record<string, { exportMime: string; ext: string; contentType: string }> = {
  'application/vnd.google-apps.document': {
    exportMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  'application/vnd.google-apps.spreadsheet': {
    exportMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  'application/vnd.google-apps.presentation': {
    exportMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: '.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
};

export class GmailAccountClient {
  readonly account: AccountConfig;
  readonly paths: AccountPaths;
  private readonly gmail: gmail_v1.Gmail;
  private readonly drive: drive_v3.Drive;
  private readonly sheets: sheets_v4.Sheets;
  private readonly docs: docs_v1.Docs;
  private readonly calendar: calendar_v3.Calendar;
  /**
   * Where accounts.json lives — and therefore where send-allowlist.json lives.
   * The send gate reads its policy from here on every call; nothing caches it.
   */
  private readonly configRoot: string;
  private labelNameCache: Map<string, string> | null = null;

  private constructor(
    account: AccountConfig,
    paths: AccountPaths,
    gmail: gmail_v1.Gmail,
    drive: drive_v3.Drive,
    sheets: sheets_v4.Sheets,
    docs: docs_v1.Docs,
    calendar: calendar_v3.Calendar,
    configRoot: string,
  ) {
    this.account = account;
    this.paths = paths;
    this.gmail = gmail;
    this.drive = drive;
    this.sheets = sheets;
    this.docs = docs;
    this.calendar = calendar;
    this.configRoot = configRoot;
  }

  static async create(configRoot: string, account: AccountConfig): Promise<GmailAccountClient> {
    const paths = getAccountPaths(configRoot, account);

    const oauth2Client = await buildOAuthClientFromCredentialsFile(paths.credentialsPath);

    let cachedTokens: Credentials;
    try {
      const rawToken = await fs.readFile(paths.tokenPath, 'utf8');
      cachedTokens = JSON.parse(rawToken) as Credentials;
    } catch (error) {
      throw new Error(
        `Token file missing or invalid for account "${account.id}" at ${paths.tokenPath}: ${(error as Error).message}`
      );
    }

    oauth2Client.setCredentials(cachedTokens);
    oauth2Client.on('tokens', (incomingTokens) => {
      cachedTokens = { ...cachedTokens, ...incomingTokens };
      void fs
        .writeFile(paths.tokenPath, `${JSON.stringify(cachedTokens, null, 2)}\n`, 'utf8')
        .catch((error) => {
          console.error(
            `[ghub] Failed to persist refreshed token for account ${account.id}:`,
            error
          );
        });
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    const docs = google.docs({ version: 'v1', auth: oauth2Client });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    return new GmailAccountClient(account, paths, gmail, drive, sheets, docs, calendar, configRoot);
  }

  async getProfileEmail(): Promise<string> {
    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    if (!profile.data.emailAddress) {
      throw new Error(`Gmail profile did not return an email address for account "${this.account.id}".`);
    }
    return profile.data.emailAddress;
  }

  async readEmails(
    query: string,
    maxResults: number,
    includeBody: boolean,
    state?: AccountPageState
  ): Promise<MessageListPage> {
    return this.fetchMessages(query, maxResults, includeBody, state);
  }

  async searchEmails(
    query: string,
    maxResults: number,
    state?: AccountPageState
  ): Promise<MessageListPage> {
    if (!query || query.trim() === '') {
      throw new Error('Search query is required.');
    }
    return this.fetchMessages(query, maxResults, false, state);
  }

  async searchDriveFiles(query: string, maxResults: number, type?: DriveFileType): Promise<DriveFileSummary[]> {
    const boundedMax = Math.max(1, Math.min(maxResults, 500));

    try {
      const response = await this.drive.files.list({
        q: buildDriveSearchQuery(query, type),
        pageSize: boundedMax,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        orderBy: 'modifiedTime desc',
        fields:
          'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress))',
      });

      return (response.data.files ?? []).map((file) => ({
        id: file.id ?? '',
        name: file.name ?? '(untitled)',
        mimeType: file.mimeType ?? 'application/octet-stream',
        modifiedTime: file.modifiedTime ?? undefined,
        owners: (file.owners ?? []).map((owner) => owner.displayName || owner.emailAddress || '(unknown)'),
        webViewLink: file.webViewLink ?? undefined,
        accountId: this.account.id,
        accountEmail: this.account.email,
      }));
    } catch (error) {
      throw new Error(describeDriveApiError(error, 'Drive search failed.', this.account.id));
    }
  }

  /**
   * One page of candidates for this account.
   *
   * `state.carry` holds ids that a previous page fetched but did not show —
   * they lost the cross-account merge. They come FIRST and count against the
   * page budget, so the total hydrated per page is still at most `maxResults`
   * (no extra quota versus fetching a plain page) and nothing that was fetched
   * is ever thrown away.
   *
   * `state.cursor` is only consumed when the carry does not already fill the
   * page, so an account with a backlog does not race ahead of the others.
   */
  private async fetchMessages(
    query: string,
    maxResults: number,
    includeBody: boolean,
    state?: AccountPageState
  ): Promise<MessageListPage> {
    const boundedMax = Math.max(1, Math.min(maxResults, 500));

    let effectiveQuery = query;
    let warnings: string[] = [];
    if (queryHasLabelIdCandidate(query)) {
      const rewrite = rewriteLabelIdsInQuery(query, await this.getLabelNameMap());
      effectiveQuery = rewrite.query;
      warnings = rewrite.warnings.map((warning) => `${this.account.id}: ${warning}`);
    }

    const carry = state?.carry ?? [];
    // No state at all = first page. A state with no cursor and no restart flag
    // means Gmail has already handed over everything it has for this query.
    const mayList = !state || state.restart === true || Boolean(state.cursor);
    const deficit = boundedMax - carry.length;

    let resultSizeEstimate = state?.estimate;
    let nextPageToken = state?.cursor;
    let listedIds: string[] = [];

    if (mayList && deficit > 0) {
      let listResponse: { data: gmail_v1.Schema$ListMessagesResponse };
      try {
        listResponse = await withGmailRetry(() =>
          this.gmail.users.messages.list({
            userId: 'me',
            q: effectiveQuery.trim() === '' ? undefined : effectiveQuery,
            maxResults: deficit,
            pageToken: state?.restart ? undefined : state?.cursor,
          })
        );
      } catch (error) {
        throw new Error(describeGmailApiError(error, 'Gmail search failed.', this.errorContext()));
      }

      // Gmail's own estimate for the whole query, independent of maxResults.
      // Reporting `messages.length` here would just echo the page size back as
      // if it were the corpus size.
      resultSizeEstimate = listResponse.data.resultSizeEstimate ?? resultSizeEstimate;
      nextPageToken = listResponse.data.nextPageToken ?? undefined;
      listedIds = (listResponse.data.messages ?? [])
        .map((message) => message.id)
        .filter((id): id is string => Boolean(id));
    }

    const seen = new Set<string>();
    const messageIds = [...carry, ...listedIds].filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    if (messageIds.length === 0) {
      return { messages: [], resultSizeEstimate, nextPageToken, warnings };
    }

    let fullMessages: Array<{ data: gmail_v1.Schema$Message }>;
    try {
      fullMessages = await mapWithConcurrency(messageIds, 10, (messageId) =>
        withGmailRetry(() =>
          this.gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
          })
        )
      );
    } catch (error) {
      throw new Error(describeGmailApiError(error, 'Gmail message fetch failed.', this.errorContext()));
    }

    const messages = fullMessages
      .map((response) => this.parseMessage(response.data, includeBody))
      .sort((a, b) => b.internalDate - a.internalDate);

    await this.attachLabelNames(messages);

    return { messages, resultSizeEstimate, nextPageToken, warnings };
  }

  async listAttachments(messageId: string): Promise<AttachmentMetadata[]> {
    if (!messageId || messageId.trim() === '') {
      throw new Error('message_id is required.');
    }

    const response = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    return extractAttachmentsMetadata(response.data.payload).filter((a) => !a.isInline);
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
    filenameHint?: string,
  ): Promise<{ bytes: Buffer; metadata: AttachmentMetadata }> {
    if (!messageId || messageId.trim() === '') {
      throw new Error('message_id is required.');
    }
    if (!attachmentId || attachmentId.trim() === '') {
      throw new Error('attachment_id is required.');
    }

    const messageResponse = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    // Handle synthetic inline IDs (small attachments Gmail embeds as body.data)
    const isInlineId = attachmentId.startsWith('inline:');
    let part: gmail_v1.Schema$MessagePart | null;

    if (isInlineId) {
      const filename = attachmentId.slice('inline:'.length);
      part = findAttachmentPartByFilename(messageResponse.data.payload, filename);
    } else {
      part = findAttachmentPart(messageResponse.data.payload, attachmentId);

      // Gmail rotates attachment IDs on every messages.get, so an ID obtained
      // from an earlier fetch routinely fails exact matching. Fall back to
      // stable identifiers: the filename, then the sole attachment part.
      if (!part) {
        const candidates = collectAttachmentParts(messageResponse.data.payload);
        if (filenameHint) {
          part = candidates.find((p) => p.filename === filenameHint) ?? null;
        }
        if (!part && candidates.length === 1) {
          part = candidates[0];
        }
      }
    }

    if (!part || !part.filename) {
      const available = extractAttachmentsMetadata(messageResponse.data.payload)
        .map((a) => a.filename)
        .join(', ');
      throw new Error(
        `Attachment ${attachmentId} not found on message ${messageId}.` +
          (available ? ` Available attachments: ${available}.` : ''),
      );
    }

    // If the part has inline data (no external attachmentId), decode it directly
    if (part.body?.data && !part.body?.attachmentId) {
      const bytes = decodeBase64UrlBuffer(part.body.data);
      return {
        bytes,
        metadata: {
          id: attachmentId,
          filename: part.filename,
          contentType: part.mimeType ?? 'application/octet-stream',
          sizeBytes: Number(part.body?.size ?? bytes.length),
          isInline: isInlineDisposition(part.headers),
        },
      };
    }

    // Use the FRESH attachment ID from the re-fetched message, not the (possibly stale) passed-in one
    const freshAttachmentId = part.body?.attachmentId ?? attachmentId;

    const attachmentResponse = await this.gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: freshAttachmentId,
    });

    const data = attachmentResponse.data.data;
    if (!data) {
      throw new Error(`Attachment ${attachmentId} has no data payload.`);
    }

    const bytes = decodeBase64UrlBuffer(data);

    return {
      bytes,
      metadata: {
        id: attachmentId,
        filename: part.filename,
        contentType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: Number(part.body?.size ?? bytes.length),
        isInline: isInlineDisposition(part.headers),
      },
    };
  }

  /**
   * Fetch all attachments for a message in a single API round-trip.
   *
   * The previous pattern called `listAttachments` (one `messages.get`) then
   * `getAttachment` per attachment (another `messages.get` each time). Gmail
   * attachment IDs are session-scoped tokens that can rotate between requests,
   * causing sporadic "Attachment <id> not found on message <id>" errors. This
   * method fetches the message exactly once, extracts fresh attachment IDs from
   * that single response, and pipes them directly to `attachments.get` —
   * eliminating the stale-token window entirely.
   *
   * Per-attachment failures are returned as `{ error }` entries so callers can
   * report partial success without aborting the entire fetch.
   */
  async fetchAllAttachments(
    messageId: string,
  ): Promise<Array<{ bytes: Buffer; metadata: AttachmentMetadata } | { error: string; metadata: AttachmentMetadata }>> {
    if (!messageId || messageId.trim() === '') {
      throw new Error('message_id is required.');
    }

    const messageResponse = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const allMeta = extractAttachmentsMetadata(messageResponse.data.payload);
    const nonInline = allMeta.filter((a) => !a.isInline);

    return Promise.all(
      nonInline.map(async (meta): Promise<{ bytes: Buffer; metadata: AttachmentMetadata } | { error: string; metadata: AttachmentMetadata }> => {
        try {
          // Inline attachments have a synthetic `inline:<filename>` ID and their
          // data is already embedded in the message payload — decode directly.
          if (meta.id.startsWith('inline:')) {
            const filename = meta.id.slice('inline:'.length);
            const part = findAttachmentPartByFilename(messageResponse.data.payload, filename);
            if (!part?.body?.data) {
              return { error: `Inline attachment data missing for ${filename} on message ${messageId}.`, metadata: meta };
            }
            return { bytes: decodeBase64UrlBuffer(part.body.data), metadata: meta };
          }

          // Use the fresh attachment ID extracted from this same response.
          // No re-fetch means no token-rotation window.
          const attRes = await this.gmail.users.messages.attachments.get({
            userId: 'me',
            messageId,
            id: meta.id,
          });

          const data = attRes.data.data;
          if (!data) {
            return { error: `Attachment ${meta.id} has no data payload on message ${messageId}.`, metadata: meta };
          }

          return { bytes: decodeBase64UrlBuffer(data), metadata: meta };
        } catch (err) {
          return { error: (err as Error).message ?? String(err), metadata: meta };
        }
      }),
    );
  }

  async getThread(threadId: string): Promise<ParsedThread> {
    if (!threadId || threadId.trim() === '') {
      throw new Error('thread_id is required.');
    }

    let threadResponse: { data: gmail_v1.Schema$Thread };
    try {
      threadResponse = await this.gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      });
    } catch (error) {
      throw new Error(
        describeGmailApiError(error, 'Failed to load thread.', this.errorContext({ threadId }))
      );
    }

    const messages = (threadResponse.data.messages ?? [])
      .map((message) => this.parseMessage(message, true))
      .sort((a, b) => a.internalDate - b.internalDate);

    await this.attachLabelNames(messages);

    return {
      threadId,
      messages,
    };
  }

  /**
   * Resolves each message's raw labelIds to display names. Falls back to raw
   * ids on failure so a label lookup can never break a search.
   *
   * Cost: one `labels.list` (1 quota unit) per tool call per account. The cache
   * below is per client INSTANCE and the server builds a fresh client for every
   * tool call, so it never survives a request — it only dedupes the two lookups
   * within one call. That is deliberate: it also means create_label results are
   * visible to the very next search instead of being masked by a stale map.
   */
  private async attachLabelNames(messages: ParsedEmail[]): Promise<void> {
    if (messages.length === 0) return;
    const nameMap = await this.getLabelNameMap();
    if (nameMap.size === 0) return;
    for (const message of messages) {
      message.labelNames = message.labels.map((labelId) => nameMap.get(labelId) ?? labelId);
    }
  }

  /**
   * @param includeCounts when true, issues one `labels.get` per label to obtain
   *   real message/thread counts. `labels.list` does NOT populate them, so
   *   without this the counts are genuinely unknown (and must be rendered as
   *   such, never as 0). Costs one extra API call per label.
   */
  async getLabels(includeCounts = false): Promise<LabelInfo[]> {
    let labels: gmail_v1.Schema$Label[];
    try {
      const labelsResponse = await this.gmail.users.labels.list({ userId: 'me' });
      labels = labelsResponse.data.labels ?? [];
    } catch (error) {
      throw new Error(describeGmailApiError(error, 'Failed to list labels.', this.errorContext()));
    }

    const base = labels.map((label) => ({
      id: label.id ?? '',
      name: label.name ?? '(unnamed)',
      type: label.type ?? undefined,
      // labels.list never populates these; leave undefined = "unknown".
      messagesTotal: label.messagesTotal ?? undefined,
      messagesUnread: label.messagesUnread ?? undefined,
      threadsTotal: label.threadsTotal ?? undefined,
      threadsUnread: label.threadsUnread ?? undefined,
    }));

    if (!includeCounts) return base;

    return mapWithConcurrency(base, 8, async (label) => {
      if (!label.id) return label;
      try {
        const detail = await this.gmail.users.labels.get({ userId: 'me', id: label.id });
        return {
          ...label,
          messagesTotal: detail.data.messagesTotal ?? undefined,
          messagesUnread: detail.data.messagesUnread ?? undefined,
          threadsTotal: detail.data.threadsTotal ?? undefined,
          threadsUnread: detail.data.threadsUnread ?? undefined,
        };
      } catch {
        // Count stays undefined => rendered as "unknown", never as 0.
        return label;
      }
    });
  }

  /**
   * Label id -> display name, for rendering labelIds on search results.
   *
   * The cache lives as long as this client instance does, which is one tool
   * call — it is NOT a cross-request cache.
   */
  async getLabelNameMap(): Promise<Map<string, string>> {
    if (this.labelNameCache) return this.labelNameCache;
    try {
      const response = await this.gmail.users.labels.list({ userId: 'me' });
      const map = new Map<string, string>();
      for (const label of response.data.labels ?? []) {
        if (label.id) map.set(label.id, label.name ?? label.id);
      }
      this.labelNameCache = map;
      return map;
    } catch {
      // Non-fatal: callers fall back to raw label ids.
      this.labelNameCache = new Map();
      return this.labelNameCache;
    }
  }

  private errorContext(extra: Partial<GmailErrorContext> = {}): GmailErrorContext {
    return { accountId: this.account.id, accountEmail: this.account.email, ...extra };
  }

  /**
   * Keeps a multi-message thread id out of the "you may have meant the whole
   * conversation" warning list.
   *
   * Every single-message thread has messageId === threadId, so that equality on
   * its own fires on ordinary messages and the warning becomes noise nobody
   * reads. Only a thread that actually holds MORE than one message means the
   * caller might have touched one message when they meant the conversation.
   */
  private async keepMultiMessageThreads(candidateIds: string[]): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    const kept = await mapWithConcurrency(candidateIds, VERIFY_CONCURRENCY, async (id) => {
      try {
        const thread = await withGmailRetry(() =>
          this.gmail.users.threads.get({ userId: 'me', id, format: 'minimal' })
        );
        return (thread.data.messages ?? []).length > 1 ? id : null;
      } catch {
        // Could not tell. Keep the warning: a missed real one is worse than an
        // extra one, and this path is rare.
        return id;
      }
    });
    return kept.filter((id): id is string => id !== null);
  }

  /**
   * Reads messages back after a mutation and reports what actually changed.
   *
   * `messages.batchModify` answers 204 with an empty body and silently drops
   * ids it cannot resolve, so "the call succeeded" says nothing about whether
   * anything happened. One `messages.get(format=minimal)` per id (5 quota
   * units, no payload) is the cheapest truthful confirmation available.
   *
   * Quota shape, and why the concurrency is what it is: Gmail allows 250 units
   * per user per second. At ~100ms per call, concurrency C issues ~10*C calls/s
   * = ~50*C units/s. C=4 sits at ~200 units/s, leaving room for the
   * batchModify (50 units) that precedes it. The previous C=8 ran at ~400
   * units/s and could SELF-INFLICT the 429 it then reported as a failed
   * mutation. Every read-back also retries with backoff, so a rate limit
   * arriving anyway costs latency rather than truth.
   */
  private async verifyMessageLabels(
    ids: string[],
    expect: { has?: string[]; lacks?: string[] }
  ): Promise<Omit<ModifyResult, 'requested'>> {
    const modified: string[] = [];
    const notFound: string[] = [];
    const unverified: string[] = [];
    const lookalikeCandidates: string[] = [];

    await mapWithConcurrency(ids, VERIFY_CONCURRENCY, async (id) => {
      try {
        const response = await withGmailRetry(() =>
          this.gmail.users.messages.get({
            userId: 'me',
            id,
            format: 'minimal',
          })
        );
        const labels = response.data.labelIds ?? [];
        const hasAll = (expect.has ?? []).every((label) => labels.includes(label));
        const lacksAll = (expect.lacks ?? []).every((label) => !labels.includes(label));
        if (hasAll && lacksAll) {
          modified.push(id);
          if (response.data.threadId && response.data.threadId === id) {
            lookalikeCandidates.push(id);
          }
        } else {
          unverified.push(id);
        }
      } catch (error) {
        if (isNotFoundError(error)) notFound.push(id);
        else unverified.push(id);
      }
    });

    const threadIdLookalikes = await this.keepMultiMessageThreads(lookalikeCandidates);

    return { modified, notFound, unverified, threadIdLookalikes };
  }

  private async batchModifyVerified(
    messageIds: string[],
    body: { addLabelIds?: string[]; removeLabelIds?: string[] },
    expect: { has?: string[]; lacks?: string[] }
  ): Promise<ModifyResult> {
    const ids = sanitizeMessageIds(messageIds);
    if (ids.length === 0) throw new Error('message_ids must include at least one value.');
    assertModifyBatchSize(ids);

    const labelIds = [...(body.addLabelIds ?? []), ...(body.removeLabelIds ?? [])];

    try {
      for (const chunk of chunkIds(ids, BATCH_MODIFY_CHUNK)) {
        await withGmailRetry(() =>
          this.gmail.users.messages.batchModify({
            userId: 'me',
            requestBody: { ids: chunk, ...body },
          })
        );
      }
    } catch (error) {
      throw new Error(
        describeGmailApiError(error, 'Gmail rejected the modify request.', this.errorContext({ labelIds, messageIds: ids }))
      );
    }

    const verified = await this.verifyMessageLabels(ids, expect);
    return { requested: ids, ...verified };
  }

  async markAsRead(messageIds: string[]): Promise<ModifyResult> {
    return this.batchModifyVerified(messageIds, { removeLabelIds: ['UNREAD'] }, { lacks: ['UNREAD'] });
  }

  async addLabels(messageIds: string[], labelIds: string[]): Promise<ModifyResult> {
    const labels = labelIds.map((labelId) => labelId.trim()).filter(Boolean);
    if (labels.length === 0) throw new Error('label_ids must include at least one value.');
    return this.batchModifyVerified(messageIds, { addLabelIds: labels }, { has: labels });
  }

  async removeLabels(messageIds: string[], labelIds: string[]): Promise<ModifyResult> {
    const labels = labelIds.map((labelId) => labelId.trim()).filter(Boolean);
    if (labels.length === 0) throw new Error('label_ids must include at least one value.');
    return this.batchModifyVerified(messageIds, { removeLabelIds: labels }, { lacks: labels });
  }

  async archiveEmails(messageIds: string[]): Promise<ModifyResult> {
    return this.batchModifyVerified(messageIds, { removeLabelIds: ['INBOX'] }, { lacks: ['INBOX'] });
  }

  async trashEmails(messageIds: string[]): Promise<ModifyResult> {
    const ids = sanitizeMessageIds(messageIds);
    if (ids.length === 0) throw new Error('message_ids must include at least one value.');
    assertModifyBatchSize(ids);

    const modified: string[] = [];
    const notFound: string[] = [];
    const unverified: string[] = [];

    await mapWithConcurrency(ids, VERIFY_CONCURRENCY, async (messageId) => {
      try {
        const response = await withGmailRetry(() =>
          this.gmail.users.messages.trash({ userId: 'me', id: messageId })
        );
        if ((response.data.labelIds ?? []).includes('TRASH')) modified.push(messageId);
        else unverified.push(messageId);
      } catch (error) {
        if (isNotFoundError(error)) notFound.push(messageId);
        else unverified.push(messageId);
      }
    });

    return { requested: ids, modified, notFound, unverified, threadIdLookalikes: [] };
  }

  /**
   * Thread-level label mutation. Gmail thread ids usually equal the id of the
   * first message in the thread, so passing a thread id to a message-level
   * call silently touches exactly one message. This acts on every message in
   * the conversation and reports the verified per-message outcome.
   */
  async modifyThreadLabels(
    threadId: string,
    modifications: { addLabelIds?: string[]; removeLabelIds?: string[] }
  ): Promise<{ threadId: string; messageIds: string[]; modified: string[]; unverified: string[] }> {
    const id = threadId.trim();
    if (!id) throw new Error('thread_id is required.');

    const addLabelIds = (modifications.addLabelIds ?? []).map((v) => v.trim()).filter(Boolean);
    const removeLabelIds = (modifications.removeLabelIds ?? []).map((v) => v.trim()).filter(Boolean);
    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      throw new Error('At least one label to add or remove is required.');
    }

    let response: { data: gmail_v1.Schema$Thread };
    try {
      response = await this.gmail.users.threads.modify({
        userId: 'me',
        id,
        requestBody: { addLabelIds, removeLabelIds },
      });
    } catch (error) {
      throw new Error(
        describeGmailApiError(error, 'Gmail rejected the thread modify request.', this.errorContext({
          labelIds: [...addLabelIds, ...removeLabelIds],
          threadId: id,
        }))
      );
    }

    const messages = response.data.messages ?? [];
    const messageIds = messages.map((m) => m.id ?? '').filter(Boolean);
    const modified: string[] = [];
    const unverified: string[] = [];

    if (messages.length > 0 && messages.some((m) => m.labelIds !== undefined)) {
      // threads.modify echoes the post-modify thread; verify straight from it.
      for (const message of messages) {
        if (!message.id) continue;
        const labels = message.labelIds ?? [];
        const ok =
          addLabelIds.every((label) => labels.includes(label)) &&
          removeLabelIds.every((label) => !labels.includes(label));
        if (ok) modified.push(message.id);
        else unverified.push(message.id);
      }
    } else {
      const verified = await this.verifyMessageLabels(messageIds, {
        has: addLabelIds,
        lacks: removeLabelIds,
      });
      modified.push(...verified.modified);
      unverified.push(...verified.unverified, ...verified.notFound);
    }

    return { threadId: id, messageIds, modified, unverified };
  }

  /**
   * Creates a label, creating any missing parent labels first.
   *
   * Gmail models nesting purely through `/` in the name — creating "a/b/c"
   * without "a" and "a/b" leaves orphaned-looking leaves in the sidebar.
   */
  async createLabel(
    name: string,
    labelListVisibility = 'labelShow',
    messageListVisibility = 'show'
  ): Promise<{ label: LabelInfo; createdParents: string[] }> {
    const trimmed = (name ?? '').trim();
    if (trimmed === '') {
      throw new Error('Label name is required.');
    }

    const segments = trimmed.split('/').map((segment) => segment.trim()).filter(Boolean);
    const fullName = segments.join('/');
    if (!fullName) throw new Error('Label name is required.');

    const existing = await this.getLabelNameMap();
    const existingNames = new Set(existing.values());

    const createdParents: string[] = [];
    for (let index = 1; index < segments.length; index += 1) {
      const parentName = segments.slice(0, index).join('/');
      if (existingNames.has(parentName)) continue;
      try {
        await this.gmail.users.labels.create({
          userId: 'me',
          requestBody: { name: parentName, labelListVisibility, messageListVisibility },
        });
        createdParents.push(parentName);
      } catch (error) {
        // 409 = already exists (race or case-insensitive match). Anything else
        // is worth surfacing, but a missing parent should not block the leaf.
        const { status } = gmailErrorParts(error);
        if (status !== 409) {
          console.error(`[ghub] Could not create parent label "${parentName}":`, error);
        }
      }
    }

    let response: { data: gmail_v1.Schema$Label };
    try {
      response = await this.gmail.users.labels.create({
        userId: 'me',
        requestBody: { name: fullName, labelListVisibility, messageListVisibility },
      });
    } catch (error) {
      throw new Error(
        describeGmailApiError(error, `Failed to create label "${fullName}".`, this.errorContext())
      );
    }

    return {
      label: {
        id: response.data.id ?? '',
        name: response.data.name ?? fullName,
        type: response.data.type ?? undefined,
        messagesTotal: response.data.messagesTotal ?? undefined,
      },
      createdParents,
    };
  }

  async deleteLabel(labelId: string): Promise<void> {
    if (!labelId || labelId.trim() === '') {
      throw new Error('label_id is required.');
    }

    await this.gmail.users.labels.delete({
      userId: 'me',
      id: labelId,
    });
  }

  async createFilter(
    criteria: gmail_v1.Schema$FilterCriteria,
    action: gmail_v1.Schema$FilterAction
  ): Promise<gmail_v1.Schema$Filter> {
    const response = await this.gmail.users.settings.filters.create({
      userId: 'me',
      requestBody: { criteria, action },
    });
    return response.data;
  }

  async listFilters(): Promise<gmail_v1.Schema$Filter[]> {
    const response = await this.gmail.users.settings.filters.list({ userId: 'me' });
    return response.data.filter ?? [];
  }

  async deleteFilter(filterId: string): Promise<void> {
    if (!filterId || filterId.trim() === '') {
      throw new Error('filter_id is required.');
    }
    await this.gmail.users.settings.filters.delete({
      userId: 'me',
      id: filterId.trim(),
    });
  }

  async createBlockFilter(
    sender: string,
    action: 'trash' | 'archive' | 'spam'
  ): Promise<gmail_v1.Schema$Filter> {
    const trimmed = sender.trim();
    if (!trimmed) throw new Error('sender is required.');

    const criteria: gmail_v1.Schema$FilterCriteria = { from: trimmed };
    const filterAction: gmail_v1.Schema$FilterAction =
      action === 'archive'
        ? { removeLabelIds: ['INBOX'] }
        : action === 'spam'
          ? { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }
          : { addLabelIds: ['TRASH'], removeLabelIds: ['INBOX', 'UNREAD'] };

    return this.createFilter(criteria, filterAction);
  }

  /**
   * Attempts Gmail's native conversation mute by applying the reserved `MUTE`
   * label to the thread.
   *
   * The Gmail API does not document `MUTE` and `users.labels.list` never
   * returns it; `users.messages.batchModify` rejects it outright with
   * "Invalid label: MUTE" (verified against the live API). This tries the
   * thread-level endpoint and reports honestly whether it worked, so callers
   * never claim a mute they did not perform.
   */
  async tryNativeMuteThread(threadId: string): Promise<{ muted: boolean; error?: string }> {
    const id = threadId.trim();
    if (!id) throw new Error('thread_id is required.');
    try {
      const response = await this.gmail.users.threads.modify({
        userId: 'me',
        id,
        requestBody: { addLabelIds: ['MUTE'] },
      });
      const applied = (response.data.messages ?? []).some((message) =>
        (message.labelIds ?? []).includes('MUTE')
      );
      if (applied) return { muted: true };
      return {
        muted: false,
        error: 'Gmail accepted the request but did not report the MUTE label on the thread.',
      };
    } catch (error) {
      return {
        muted: false,
        error: describeGmailApiError(error, 'Gmail rejected the MUTE label.', this.errorContext({ threadId: id })),
      };
    }
  }

  async getThreadSubject(threadId: string): Promise<string> {
    if (!threadId || threadId.trim() === '') {
      throw new Error('thread_id is required.');
    }

    const response = await this.gmail.users.threads.get({
      userId: 'me',
      id: threadId.trim(),
      format: 'metadata',
      metadataHeaders: ['Subject'],
    });

    const firstMessage = response.data.messages?.[0];
    const raw = getHeaderValue(firstMessage?.payload?.headers, 'Subject');
    return raw.replace(/^(?:\s*(?:re|fwd?|aw)\s*:\s*)+/i, '').trim();
  }

  /**
   * This account's Gmail signature, read fresh from Gmail every time.
   *
   * Nothing is cached and nothing is stored: the spec requires the signature to
   * BE whatever the account's Gmail settings currently say. Caching it in this
   * process would also be the mechanism by which one account's signature could
   * end up on the other account's mail — each client instance is bound to one
   * account's OAuth credentials, so a per-account fetch cannot bleed.
   *
   * An account with no signature configured returns an empty string. That is a
   * valid answer, not an error (spec: "account has no signature configured in
   * Gmail -> draft simply has no signature appended").
   */
  async getSignature(): Promise<AccountSignature> {
    const response = await this.gmail.users.settings.sendAs.list({ userId: 'me' });
    const entries = response.data.sendAs ?? [];
    const availableSendAs = entries
      .map((entry) => entry.sendAsEmail ?? '')
      .filter((email) => email !== '');

    const own = this.account.email.trim().toLowerCase();
    const mine = entries.filter(
      (entry) => (entry.sendAsEmail ?? '').trim().toLowerCase() === own
    );

    // Prefer the default sendAs among the entries for this account's own
    // address. Never fall back to some OTHER address's signature — that would
    // be exactly the cross-account/alias bleed the spec forbids.
    const chosen = mine.find((entry) => entry.isDefault) ?? mine[0];

    if (!chosen) {
      return {
        sendAsEmail: this.account.email,
        signatureHtml: '',
        isDefault: false,
        matchedAccountEmail: false,
        availableSendAs,
      };
    }

    return {
      sendAsEmail: chosen.sendAsEmail ?? this.account.email,
      signatureHtml: (chosen.signature ?? '').trim(),
      isDefault: Boolean(chosen.isDefault),
      matchedAccountEmail: true,
      availableSendAs,
    };
  }

  /**
   * Build the MIME bytes for an outgoing message, fetching the account's own
   * Gmail signature when asked for. The signature markup enters compose.ts ONLY
   * from here — see the trusted-channel note in src/compose.ts.
   */
  private async buildOutgoing(input: OutgoingMessageInput): Promise<string> {
    const signatureHtml = input.includeSignature
      ? (await this.getSignature()).signatureHtml
      : undefined;
    return createRawEmailMessage(input, signatureHtml);
  }

  /**
   * THE SEND CHOKE POINT. Every `users.messages.send` and `users.drafts.send`
   * call in this codebase is inside this method, and the allowlist gate is its
   * first statement.
   *
   * The gate reads the FINAL bytes, not the caller's intent, and it throws on
   * anything it cannot approve — so an unapproved recipient never reaches a
   * network call. Do not add a send elsewhere and do not add a parameter that
   * skips the gate; the point of funnelling through one method is that a future
   * call site cannot bypass the check by construction.
   */
  private async deliver(
    request:
      | { kind: 'raw'; rawMessage: string; threadId?: string }
      | { kind: 'draft'; draftId: string; rawMessage: string }
  ): Promise<{ messageId: string; threadId?: string }> {
    await assertSendAllowed({
      rawMessage: request.rawMessage,
      accountId: this.account.id,
      configRoot: this.configRoot,
    });

    const response =
      request.kind === 'draft'
        ? await this.gmail.users.drafts.send({
            userId: 'me',
            requestBody: { id: request.draftId },
          })
        : await this.gmail.users.messages.send({
            userId: 'me',
            requestBody: {
              raw: request.rawMessage,
              ...(request.threadId ? { threadId: request.threadId } : {}),
            },
          });

    return {
      messageId: response.data.id ?? '',
      threadId: response.data.threadId ?? undefined,
    };
  }

  async createDraft(
    input: OutgoingMessageInput & { threadId?: string }
  ): Promise<{ draftId: string; threadId?: string }> {
    const raw = await this.buildOutgoing(input);

    const message: { raw: string; threadId?: string } = { raw };
    if (input.threadId) message.threadId = input.threadId;

    const response = await this.gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message },
    });

    return {
      draftId: response.data.id ?? '',
      threadId: response.data.message?.threadId ?? undefined,
    };
  }

  async deleteDrafts(draftIds: string[]): Promise<number> {
    const ids = draftIds.map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) throw new Error('draft_ids must include at least one value.');

    await Promise.all(
      ids.map((draftId) =>
        this.gmail.users.drafts.delete({
          userId: 'me',
          id: draftId,
        })
      )
    );

    return ids.length;
  }

  /**
   * Send an existing draft — after re-reading what that draft ACTUALLY contains.
   *
   * A draft may have been created in an earlier session, or edited in the Gmail
   * UI, or created against a different recipient entirely. Anything recorded at
   * creation time is therefore a claim about the past, not a fact about the
   * bytes that are going to leave. So the raw draft is fetched here and those
   * exact bytes are what the gate reads.
   *
   * Residual window, stated honestly: Gmail's `drafts.send` takes an id, not
   * bytes, so between this fetch and that call the draft could in principle be
   * rewritten by something else holding the same credentials. This server
   * exposes no draft-editing tool, so there is no in-band way to drive that
   * race, but it is not zero and is not claimed to be.
   */
  async sendDraft(draftId: string): Promise<{ messageId: string; threadId?: string }> {
    const id = draftId.trim();
    if (!id) throw new Error('draft_id is required.');

    const draft = await this.gmail.users.drafts.get({
      userId: 'me',
      id,
      format: 'raw',
    });

    const rawMessage = draft.data.message?.raw;
    if (!rawMessage) {
      throw new Error(
        `Draft ${id} came back from Gmail without raw content, so its recipients ` +
          'could not be checked against the send allowlist. Nothing was sent.'
      );
    }

    return this.deliver({ kind: 'draft', draftId: id, rawMessage });
  }

  async listDrafts(maxResults = 20): Promise<Array<{ draftId: string; messageId: string; threadId?: string; subject: string; to: string; internalDate: number }>> {
    const listRes = await this.gmail.users.drafts.list({
      userId: 'me',
      maxResults,
    });

    const drafts = listRes.data.drafts ?? [];
    if (drafts.length === 0) return [];

    const details = await Promise.all(
      drafts.map((d) =>
        this.gmail.users.drafts.get({
          userId: 'me',
          id: d.id!,
          format: 'metadata',
        })
      )
    );

    const results = details.map((res) => {
      const headers = res.data.message?.payload?.headers ?? [];
      const get = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
      return {
        draftId: res.data.id ?? '',
        messageId: res.data.message?.id ?? '',
        threadId: res.data.message?.threadId ?? undefined,
        subject: get('Subject'),
        to: get('To'),
        internalDate: Number(res.data.message?.internalDate ?? 0),
      };
    });

    return results.sort((a, b) => a.internalDate - b.internalDate);
  }

  async searchDrafts(query: string, maxResults = 20): Promise<Array<{ draftId: string; messageId: string; threadId?: string; subject: string; to: string; snippet: string }>> {
    const listRes = await this.gmail.users.drafts.list({
      userId: 'me',
      maxResults,
      q: query,
    });

    const drafts = listRes.data.drafts ?? [];
    if (drafts.length === 0) return [];

    const details = await Promise.all(
      drafts.map((d) =>
        this.gmail.users.drafts.get({
          userId: 'me',
          id: d.id!,
          format: 'metadata',
        })
      )
    );

    return details.map((res) => {
      const headers = res.data.message?.payload?.headers ?? [];
      const get = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
      return {
        draftId: res.data.id ?? '',
        messageId: res.data.message?.id ?? '',
        threadId: res.data.message?.threadId ?? undefined,
        subject: get('Subject'),
        to: get('To'),
        snippet: res.data.message?.snippet ?? '',
      };
    });
  }

  async sendEmail(
    input: OutgoingMessageInput & { threadId?: string }
  ): Promise<{ messageId: string; threadId?: string }> {
    const rawMessage = await this.buildOutgoing(input);
    return this.deliver({ kind: 'raw', rawMessage, threadId: input.threadId });
  }

  private parseMessage(message: gmail_v1.Schema$Message, includeBody: boolean): ParsedEmail {
    const headers = message.payload?.headers;
    const internalDate = Number(message.internalDate ?? 0);
    const attachments = extractAttachmentsMetadata(message.payload).filter(
      (a) => !a.isInline,
    );

    return {
      id: message.id ?? '',
      threadId: message.threadId ?? '',
      snippet: message.snippet ?? '',
      from: getHeaderValue(headers, 'From'),
      to: getHeaderValue(headers, 'To'),
      cc: getHeaderValue(headers, 'Cc'),
      subject: getHeaderValue(headers, 'Subject') || '(no subject)',
      date: getHeaderValue(headers, 'Date'),
      internalDate: Number.isFinite(internalDate) ? internalDate : 0,
      messageHeaderId: getHeaderValue(headers, 'Message-ID'),
      inReplyTo: getHeaderValue(headers, 'In-Reply-To'),
      references: getHeaderValue(headers, 'References'),
      body: includeBody ? extractEmailBody(message.payload) : undefined,
      labels: message.labelIds ?? [],
      attachments,
      accountId: this.account.id,
      accountEmail: this.account.email,
    };
  }

  /**
   * The underlying googleapis handles. Two users: verification tooling
   * (tools/live/*.mjs -- a harness must read Google back independently of
   * the tool it is checking, and must never open a token file itself), and
   * the plan 002 Phase 4 write modules (src/sheets/writes.ts,
   * src/docs/writes.ts, the Drive folder-move in src/tools/*.ts), which take
   * a handle plus the account id rather than growing this class further.
   * Errors from those calls go through describeGoogleApiError at the caller.
   */
  rawApis(): { drive: drive_v3.Drive; sheets: sheets_v4.Sheets; docs: docs_v1.Docs; calendar: calendar_v3.Calendar } {
    return { drive: this.drive, sheets: this.sheets, docs: this.docs, calendar: this.calendar };
  }

  private describe(service: GoogleService, fallback: string): (error: unknown) => Error {
    return (error) => new Error(describeGoogleApiError(error, { service, accountId: this.account.id, fallback }));
  }

  // ─── Drive ───────────────────────────────────────────────────────────────

  async listDriveFiles(options: {
    folderId?: string;
    query?: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ files: DriveFileSummary[]; nextPageToken?: string }> {
    const parts: string[] = ['trashed = false'];
    if (options.folderId?.trim()) parts.push(`'${options.folderId.trim()}' in parents`);
    if (options.query?.trim()) {
      const esc = escapeDriveQueryValue(options.query.trim());
      parts.push(`(name contains '${esc}' or fullText contains '${esc}')`);
    }

    try {
      const response = await this.drive.files.list({
        q: parts.join(' and '),
        pageSize: Math.max(1, Math.min(options.maxResults ?? 25, 500)),
        pageToken: options.pageToken,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        orderBy: 'modifiedTime desc',
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress))',
      });
      return {
        files: (response.data.files ?? []).map((f) => ({
          id: f.id ?? '',
          name: f.name ?? '(untitled)',
          mimeType: f.mimeType ?? 'application/octet-stream',
          modifiedTime: f.modifiedTime ?? undefined,
          owners: (f.owners ?? []).map((o) => o.displayName || o.emailAddress || '(unknown)'),
          webViewLink: f.webViewLink ?? undefined,
          accountId: this.account.id,
          accountEmail: this.account.email,
        })),
        nextPageToken: response.data.nextPageToken ?? undefined,
      };
    } catch (error) {
      throw new Error(describeDriveApiError(error, 'Drive list failed.', this.account.id));
    }
  }

  async getDriveFile(fileId: string): Promise<DriveFileDetail> {
    if (!fileId?.trim()) throw new Error('file_id is required.');
    try {
      const response = await this.drive.files.get({
        fileId: fileId.trim(),
        supportsAllDrives: true,
        fields: 'id,name,mimeType,modifiedTime,createdTime,size,parents,owners(displayName,emailAddress),webViewLink,trashed,starred,shared,exportLinks',
      });
      const f = response.data;
      return {
        id: f.id ?? '',
        name: f.name ?? '(untitled)',
        mimeType: f.mimeType ?? 'application/octet-stream',
        modifiedTime: f.modifiedTime ?? undefined,
        createdTime: f.createdTime ?? undefined,
        size: f.size ? Number(f.size) : undefined,
        parents: f.parents ?? undefined,
        owners: (f.owners ?? []).map((o) => o.displayName || o.emailAddress || '(unknown)'),
        webViewLink: f.webViewLink ?? undefined,
        trashed: f.trashed ?? false,
        starred: f.starred ?? false,
        shared: f.shared ?? false,
        exportLinks: f.exportLinks ? f.exportLinks as Record<string, string> : undefined,
        accountId: this.account.id,
        accountEmail: this.account.email,
      };
    } catch (error) {
      throw new Error(describeDriveApiError(error, 'Drive file get failed.', this.account.id));
    }
  }

  async getDriveFileContent(fileId: string): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    if (!fileId?.trim()) throw new Error('file_id is required.');
    const meta = await this.getDriveFile(fileId.trim());
    const wsExport = WORKSPACE_EXPORT_MAP[meta.mimeType];

    try {
      if (wsExport) {
        const response = await this.drive.files.export(
          { fileId: fileId.trim(), mimeType: wsExport.exportMime },
          { responseType: 'arraybuffer' },
        );
        return {
          bytes: Buffer.from(response.data as unknown as ArrayBuffer),
          contentType: wsExport.contentType,
          filename: `${meta.name}${wsExport.ext}`,
        };
      }
      const response = await this.drive.files.get(
        { fileId: fileId.trim(), alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      );
      return {
        bytes: Buffer.from(response.data as unknown as ArrayBuffer),
        contentType: meta.mimeType,
        filename: meta.name,
      };
    } catch (error) {
      throw new Error(describeDriveApiError(error, 'Drive file download failed.', this.account.id));
    }
  }

  async uploadDriveFile(input: {
    localPath: string;
    name?: string;
    folderId?: string;
    mimeType?: string;
  }): Promise<DriveFileDetail> {
    const localPath = input.localPath.trim();
    if (!localPath) throw new Error('local_path is required.');
    const filename = input.name?.trim() || path.basename(localPath);
    const mimeType = input.mimeType?.trim() || inferContentType(filename);
    const requestBody: drive_v3.Schema$File = { name: filename };
    if (input.folderId?.trim()) requestBody.parents = [input.folderId.trim()];

    try {
      const response = await this.drive.files.create({
        supportsAllDrives: true,
        requestBody,
        media: { mimeType, body: createReadStream(localPath) },
        fields: 'id,name,mimeType,modifiedTime,createdTime,size,parents,owners(displayName,emailAddress),webViewLink,trashed,starred,shared',
      });
      const f = response.data;
      return {
        id: f.id ?? '',
        name: f.name ?? filename,
        mimeType: f.mimeType ?? mimeType,
        modifiedTime: f.modifiedTime ?? undefined,
        createdTime: f.createdTime ?? undefined,
        size: f.size ? Number(f.size) : undefined,
        parents: f.parents ?? undefined,
        owners: (f.owners ?? []).map((o) => o.displayName || o.emailAddress || '(unknown)'),
        webViewLink: f.webViewLink ?? undefined,
        trashed: false,
        starred: false,
        shared: false,
        accountId: this.account.id,
        accountEmail: this.account.email,
      };
    } catch (error) {
      throw new Error(describeDriveApiError(error, 'Drive upload failed.', this.account.id));
    }
  }

  async createDriveFolder(name: string, parentId?: string): Promise<DriveFileSummary> {
    if (!name?.trim()) throw new Error('name is required.');
    const requestBody: drive_v3.Schema$File = {
      name: name.trim(),
      mimeType: 'application/vnd.google-apps.folder',
    };
    if (parentId?.trim()) requestBody.parents = [parentId.trim()];

    try {
      const response = await this.drive.files.create({
        supportsAllDrives: true,
        requestBody,
        fields: 'id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress)',
      });
      const f = response.data;
      return {
        id: f.id ?? '',
        name: f.name ?? name,
        mimeType: f.mimeType ?? 'application/vnd.google-apps.folder',
        modifiedTime: f.modifiedTime ?? undefined,
        owners: (f.owners ?? []).map((o) => o.displayName || o.emailAddress || '(unknown)'),
        webViewLink: f.webViewLink ?? undefined,
        accountId: this.account.id,
        accountEmail: this.account.email,
      };
    } catch (error) {
      throw new Error(describeDriveApiError(error, 'Create folder failed.', this.account.id));
    }
  }

  async updateDriveFile(
    fileId: string,
    updates: { name?: string; addParents?: string; removeParents?: string; starred?: boolean; description?: string },
  ): Promise<DriveFileSummary> {
    if (!fileId?.trim()) throw new Error('file_id is required.');
    const requestBody: drive_v3.Schema$File = {};
    if (updates.name !== undefined) requestBody.name = updates.name.trim();
    if (updates.starred !== undefined) requestBody.starred = updates.starred;
    if (updates.description !== undefined) requestBody.description = updates.description;

    try {
      const response = await this.drive.files.update({
        fileId: fileId.trim(),
        supportsAllDrives: true,
        addParents: updates.addParents?.trim() || undefined,
        removeParents: updates.removeParents?.trim() || undefined,
        requestBody,
        fields: 'id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress)',
      });
      const f = response.data;
      return {
        id: f.id ?? '',
        name: f.name ?? '(untitled)',
        mimeType: f.mimeType ?? 'application/octet-stream',
        modifiedTime: f.modifiedTime ?? undefined,
        owners: (f.owners ?? []).map((o) => o.displayName || o.emailAddress || '(unknown)'),
        webViewLink: f.webViewLink ?? undefined,
        accountId: this.account.id,
        accountEmail: this.account.email,
      };
    } catch (error) {
      throw new Error(describeDriveApiError(error, 'Drive file update failed.', this.account.id));
    }
  }

  async trashDriveFile(fileId: string): Promise<void> {
    if (!fileId?.trim()) throw new Error('file_id is required.');
    try {
      await this.drive.files.update({
        fileId: fileId.trim(),
        supportsAllDrives: true,
        requestBody: { trashed: true },
      });
    } catch (error) {
      throw new Error(describeDriveApiError(error, 'Drive trash failed.', this.account.id));
    }
  }

  async shareDriveFile(
    fileId: string,
    input: { email?: string; role: string; type: string; sendNotification?: boolean; notificationMessage?: string },
  ): Promise<{ permissionId: string }> {
    if (!fileId?.trim()) throw new Error('file_id is required.');

    // 'anyone' and 'domain' grant access to a population, not one address, so
    // there is nothing for the allowlist to check them against — refuse
    // outright rather than silently widening the boundary this exists to hold.
    if (input.type === 'anyone' || input.type === 'domain') {
      throw new Error(
        `share_drive_file type "${input.type}" is not permitted — it would grant access to ` +
          `people other than the account owner, which this server's send boundary exists to prevent. ` +
          `Use type "user" with an allowlisted email address instead.`
      );
    }
    await assertAddressAllowed({
      addresses: input.email ? [input.email] : [],
      accountId: this.account.id,
      configRoot: this.configRoot,
      workaround: 'share it yourself directly in Google Drive',
    });

    try {
      const response = await this.drive.permissions.create({
        fileId: fileId.trim(),
        supportsAllDrives: true,
        sendNotificationEmail: input.sendNotification ?? true,
        emailMessage: input.notificationMessage,
        requestBody: { type: input.type, role: input.role, emailAddress: input.email },
      });
      return { permissionId: response.data.id ?? '' };
    } catch (error) {
      throw new Error(describeDriveApiError(error, 'Drive share failed.', this.account.id));
    }
  }

  // ─── Sheets ──────────────────────────────────────────────────────────────

  /**
   * One tab's cells WITH their data-validation rules, for get_sheet_dropdown
   * (plan 002 Phase 3). `a1Range` already carries the quoted tab name.
   * `fields` is masked to the rule and nothing else, so a big tab costs one
   * small call. src/sheets/validation.ts interprets the result.
   */
  async getSheetValidationGrid(spreadsheetId: string, a1Range: string): Promise<sheets_v4.Schema$Sheet> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    try {
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId.trim(),
        ranges: [a1Range],
        includeGridData: true,
        fields: 'sheets(properties(title),data(startRow,startColumn,rowData(values(dataValidation))))',
      });
      const sheet = response.data.sheets?.[0];
      if (!sheet) throw new Error(`Range ${a1Range} returned no sheet.`);
      return sheet;
    } catch (error) {
      throw this.describe('Sheets', 'Sheets validation read failed.')(error);
    }
  }

  async getSheetsMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    let response;
    try {
      response = await this.sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId.trim(),
        fields: 'spreadsheetId,spreadsheetUrl,properties/title,sheets(properties(sheetId,title,index,gridProperties))',
      });
    } catch (error) {
      throw this.describe('Sheets', 'Sheets metadata read failed.')(error);
    }
    return {
      id: response.data.spreadsheetId ?? '',
      title: response.data.properties?.title ?? '(untitled)',
      url: response.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${response.data.spreadsheetId}`,
      sheets: (response.data.sheets ?? []).map((s) => ({
        sheetId: s.properties?.sheetId ?? 0,
        title: s.properties?.title ?? '(untitled)',
        index: s.properties?.index ?? 0,
        rowCount: s.properties?.gridProperties?.rowCount ?? 0,
        columnCount: s.properties?.gridProperties?.columnCount ?? 0,
      })),
    };
  }

  async readSheetValues(
    spreadsheetId: string,
    range: string,
    valueRenderOption = 'FORMATTED_VALUE',
  ): Promise<{ range: string; values: unknown[][] }> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    if (!range?.trim()) throw new Error('range is required.');
    let response;
    try {
      response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId.trim(),
        range: range.trim(),
        valueRenderOption,
      });
    } catch (error) {
      throw this.describe('Sheets', 'Sheets range read failed.')(error);
    }
    return {
      range: response.data.range ?? range,
      values: (response.data.values ?? []) as unknown[][],
    };
  }

  async writeSheetValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption = 'USER_ENTERED',
  ): Promise<{ updatedRange: string; updatedRows: number; updatedCells: number }> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    if (!range?.trim()) throw new Error('range is required.');
    const response = await this.sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId.trim(),
      range: range.trim(),
      valueInputOption,
      requestBody: { values },
    });
    return {
      updatedRange: response.data.updatedRange ?? range,
      updatedRows: response.data.updatedRows ?? 0,
      updatedCells: response.data.updatedCells ?? 0,
    };
  }

  async appendSheetValues(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    valueInputOption = 'USER_ENTERED',
  ): Promise<{ updatedRange: string; updatedRows: number }> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    if (!range?.trim()) throw new Error('range is required.');
    const response = await this.sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId.trim(),
      range: range.trim(),
      valueInputOption,
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
    return {
      updatedRange: response.data.updates?.updatedRange ?? range,
      updatedRows: response.data.updates?.updatedRows ?? 0,
    };
  }

  async createSpreadsheet(title: string): Promise<{ id: string; url: string }> {
    if (!title?.trim()) throw new Error('title is required.');
    const response = await this.sheets.spreadsheets.create({
      requestBody: { properties: { title: title.trim() } },
    });
    return {
      id: response.data.spreadsheetId ?? '',
      url: response.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${response.data.spreadsheetId}`,
    };
  }

  private async getSheetIdByTitle(spreadsheetId: string, sheetTitle: string): Promise<number> {
    const meta = await this.getSheetsMetadata(spreadsheetId);
    const sheet = meta.sheets.find((s) => s.title === sheetTitle);
    if (!sheet) throw new Error(`Sheet tab "${sheetTitle}" not found in spreadsheet.`);
    return sheet.sheetId;
  }

  private async sheetsBatchUpdate(
    spreadsheetId: string,
    requests: sheets_v4.Schema$Request[],
  ): Promise<sheets_v4.Schema$BatchUpdateSpreadsheetResponse> {
    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId.trim(),
      requestBody: { requests },
    });
    return response.data;
  }

  async addSheetTab(spreadsheetId: string, title: string, index?: number): Promise<{ sheetId: number; title: string }> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    if (!title?.trim()) throw new Error('title is required.');
    const props: sheets_v4.Schema$SheetProperties = { title: title.trim() };
    if (index !== undefined) props.index = index;
    const result = await this.sheetsBatchUpdate(spreadsheetId, [{ addSheet: { properties: props } }]);
    const added = result.replies?.[0]?.addSheet?.properties;
    return { sheetId: added?.sheetId ?? 0, title: added?.title ?? title };
  }

  async renameSheetTab(spreadsheetId: string, currentTitle: string, newTitle: string): Promise<void> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    const sheetId = await this.getSheetIdByTitle(spreadsheetId, currentTitle);
    await this.sheetsBatchUpdate(spreadsheetId, [{
      updateSheetProperties: {
        properties: { sheetId, title: newTitle.trim() },
        fields: 'title',
      },
    }]);
  }

  async deleteSheetTab(spreadsheetId: string, sheetTitle: string): Promise<void> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    const sheetId = await this.getSheetIdByTitle(spreadsheetId, sheetTitle);
    await this.sheetsBatchUpdate(spreadsheetId, [{ deleteSheet: { sheetId } }]);
  }

  async insertDimension(
    spreadsheetId: string,
    sheetTitle: string,
    dimension: 'ROWS' | 'COLUMNS',
    startIndex: number,
    count: number,
  ): Promise<void> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    const sheetId = await this.getSheetIdByTitle(spreadsheetId, sheetTitle);
    await this.sheetsBatchUpdate(spreadsheetId, [{
      insertDimension: {
        range: { sheetId, dimension, startIndex, endIndex: startIndex + count },
        inheritFromBefore: startIndex > 0,
      },
    }]);
  }

  async deleteDimension(
    spreadsheetId: string,
    sheetTitle: string,
    dimension: 'ROWS' | 'COLUMNS',
    startIndex: number,
    count: number,
  ): Promise<void> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    const sheetId = await this.getSheetIdByTitle(spreadsheetId, sheetTitle);
    await this.sheetsBatchUpdate(spreadsheetId, [{
      deleteDimension: {
        range: { sheetId, dimension, startIndex, endIndex: startIndex + count },
      },
    }]);
  }

  private parseA1Range(range: string, sheetId: number): sheets_v4.Schema$GridRange {
    const colToIndex = (letters: string): number => {
      let index = 0;
      for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
      return index - 1;
    };
    const withoutSheet = range.includes('!') ? range.split('!')[1] ?? range : range;
    const [startCell, endCell] = withoutSheet.split(':');
    const parseCell = (cell: string): { row: number; col: number } => {
      const m = (cell ?? '').match(/^([A-Za-z]+)(\d+)$/);
      if (!m) return { row: 0, col: 0 };
      return { col: colToIndex(m[1]), row: parseInt(m[2], 10) - 1 };
    };
    const s = parseCell(startCell ?? '');
    const e = endCell ? parseCell(endCell) : s;
    return { sheetId, startRowIndex: s.row, endRowIndex: e.row + 1, startColumnIndex: s.col, endColumnIndex: e.col + 1 };
  }

  private hexToColor(hex: string): sheets_v4.Schema$Color {
    const h = hex.replace('#', '');
    return {
      red: parseInt(h.substring(0, 2), 16) / 255,
      green: parseInt(h.substring(2, 4), 16) / 255,
      blue: parseInt(h.substring(4, 6), 16) / 255,
    };
  }

  async formatCells(
    spreadsheetId: string,
    sheetTitle: string,
    range: string,
    format: {
      bold?: boolean;
      italic?: boolean;
      fontSize?: number;
      backgroundColor?: string;
      textColor?: string;
      horizontalAlignment?: 'LEFT' | 'CENTER' | 'RIGHT';
      numberFormat?: string;
      wrapStrategy?: 'OVERFLOW_CELL' | 'LEGACY_WRAP' | 'CLIP' | 'WRAP';
    },
  ): Promise<void> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    const sheetId = await this.getSheetIdByTitle(spreadsheetId, sheetTitle);
    const gridRange = this.parseA1Range(range, sheetId);
    const cellFormat: sheets_v4.Schema$CellFormat = {};
    const fields: string[] = [];

    if (format.bold !== undefined || format.italic !== undefined || format.fontSize !== undefined || format.textColor !== undefined) {
      cellFormat.textFormat = {};
      if (format.bold !== undefined) { cellFormat.textFormat.bold = format.bold; fields.push('userEnteredFormat.textFormat.bold'); }
      if (format.italic !== undefined) { cellFormat.textFormat.italic = format.italic; fields.push('userEnteredFormat.textFormat.italic'); }
      if (format.fontSize !== undefined) { cellFormat.textFormat.fontSize = format.fontSize; fields.push('userEnteredFormat.textFormat.fontSize'); }
      if (format.textColor) { cellFormat.textFormat.foregroundColor = this.hexToColor(format.textColor); fields.push('userEnteredFormat.textFormat.foregroundColor'); }
    }
    if (format.backgroundColor) { cellFormat.backgroundColor = this.hexToColor(format.backgroundColor); fields.push('userEnteredFormat.backgroundColor'); }
    if (format.horizontalAlignment) { cellFormat.horizontalAlignment = format.horizontalAlignment; fields.push('userEnteredFormat.horizontalAlignment'); }
    if (format.numberFormat) { cellFormat.numberFormat = { type: 'NUMBER', pattern: format.numberFormat }; fields.push('userEnteredFormat.numberFormat'); }
    if (format.wrapStrategy) { cellFormat.wrapStrategy = format.wrapStrategy; fields.push('userEnteredFormat.wrapStrategy'); }

    if (fields.length === 0) return;
    await this.sheetsBatchUpdate(spreadsheetId, [{
      repeatCell: { range: gridRange, cell: { userEnteredFormat: cellFormat }, fields: fields.join(',') },
    }]);
  }

  async addChart(
    spreadsheetId: string,
    sheetTitle: string,
    options: {
      chartType: 'BAR' | 'LINE' | 'PIE' | 'COLUMN' | 'AREA' | 'SCATTER';
      dataRange: string;
      title?: string;
      anchorRow?: number;
      anchorCol?: number;
      widthPixels?: number;
      heightPixels?: number;
    },
  ): Promise<{ chartId: number }> {
    if (!spreadsheetId?.trim()) throw new Error('spreadsheet_id is required.');
    const sheetId = await this.getSheetIdByTitle(spreadsheetId, sheetTitle);
    const dataRange = this.parseA1Range(options.dataRange, sheetId);

    const domainRange: sheets_v4.Schema$GridRange = { ...dataRange, endColumnIndex: dataRange.startColumnIndex! + 1 };
    const seriesRange: sheets_v4.Schema$GridRange = { ...dataRange, startColumnIndex: dataRange.startColumnIndex! + 1 };

    let spec: sheets_v4.Schema$ChartSpec;
    if (options.chartType === 'PIE') {
      spec = {
        title: options.title,
        pieChart: {
          legendPosition: 'RIGHT_LEGEND',
          domain: { sourceRange: { sources: [domainRange] } },
          series: { sourceRange: { sources: [seriesRange] } },
        },
      };
    } else {
      spec = {
        title: options.title,
        basicChart: {
          chartType: options.chartType as sheets_v4.Schema$BasicChartSpec['chartType'],
          legendPosition: 'BOTTOM_LEGEND',
          axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS' }],
          domains: [{ domain: { sourceRange: { sources: [domainRange] } } }],
          series: [{ series: { sourceRange: { sources: [seriesRange] } }, targetAxis: 'LEFT_AXIS' }],
          headerCount: 1,
        },
      };
    }

    const result = await this.sheetsBatchUpdate(spreadsheetId, [{
      addChart: {
        chart: {
          spec,
          position: {
            overlayPosition: {
              anchorCell: { sheetId, rowIndex: options.anchorRow ?? 0, columnIndex: options.anchorCol ?? 0 },
              widthPixels: options.widthPixels ?? 600,
              heightPixels: options.heightPixels ?? 400,
            },
          },
        },
      },
    }]);

    return { chartId: result.replies?.[0]?.addChart?.chart?.chartId ?? 0 };
  }

  // ─── Docs ─────────────────────────────────────────────────────────────────

  /**
   * The whole document, EVERY tab (plan 002 Phase 3). `includeTabsContent`
   * is what makes Google return `tabs[]`; without it only the first tab comes
   * back and nothing says others exist. src/docs/tabs.ts renders the result.
   */
  async getDocumentWithTabs(documentId: string): Promise<docs_v1.Schema$Document> {
    if (!documentId?.trim()) throw new Error('document_id is required.');
    try {
      const response = await this.docs.documents.get({ documentId: documentId.trim(), includeTabsContent: true });
      return response.data;
    } catch (error) {
      throw this.describe('Docs', 'Docs read failed.')(error);
    }
  }

  async createDocument(title: string): Promise<{ documentId: string; url: string }> {
    if (!title?.trim()) throw new Error('title is required.');
    const response = await this.docs.documents.create({ requestBody: { title: title.trim() } });
    return {
      documentId: response.data.documentId ?? '',
      url: `https://docs.google.com/document/d/${response.data.documentId}/edit`,
    };
  }

  // ─── Calendar ─────────────────────────────────────────────────────────────

  async listCalendars(): Promise<CalendarInfo[]> {
    let response;
    try {
      response = await this.calendar.calendarList.list({});
    } catch (error) {
      throw this.describe('Calendar', 'Calendar list failed.')(error);
    }
    return (response.data.items ?? []).map((cal) => ({
      id: cal.id ?? '',
      summary: cal.summary ?? '(untitled)',
      description: cal.description ?? undefined,
      primary: cal.primary ?? false,
      selected: cal.selected ?? false,
      accessRole: cal.accessRole ?? undefined,
      backgroundColor: cal.backgroundColor ?? undefined,
      timeZone: cal.timeZone ?? undefined,
      accountId: this.account.id,
      accountEmail: this.account.email,
    }));
  }

  async listCalendarEvents(
    calendarId: string,
    options: { timeMin?: string; timeMax?: string; query?: string; maxResults?: number; singleEvents?: boolean },
  ): Promise<CalendarEvent[]> {
    const cid = (calendarId || 'primary').trim();
    let response;
    try {
      response = await this.calendar.events.list({
        calendarId: cid,
        timeMin: options.timeMin,
        timeMax: options.timeMax,
        q: options.query?.trim() || undefined,
        maxResults: Math.max(1, Math.min(options.maxResults ?? 25, 250)),
        singleEvents: options.singleEvents ?? true,
        orderBy: options.singleEvents !== false ? 'startTime' : undefined,
      });
    } catch (error) {
      throw this.describe('Calendar', 'Calendar events list failed.')(error);
    }
    return (response.data.items ?? []).map((e) => this.parseCalendarEvent(e, cid));
  }

  async getCalendarEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    if (!calendarId?.trim()) throw new Error('calendar_id is required.');
    if (!eventId?.trim()) throw new Error('event_id is required.');
    let response;
    try {
      response = await this.calendar.events.get({ calendarId: calendarId.trim(), eventId: eventId.trim() });
    } catch (error) {
      throw this.describe('Calendar', 'Calendar event read failed.')(error);
    }
    return this.parseCalendarEvent(response.data, calendarId);
  }

  async createCalendarEvent(
    calendarId: string,
    input: {
      summary: string;
      description?: string;
      location?: string;
      start: { dateTime?: string; date?: string; timeZone?: string };
      end: { dateTime?: string; date?: string; timeZone?: string };
      attendees?: string[];
      recurrence?: string[];
      sendNotifications?: boolean;
    },
  ): Promise<CalendarEvent> {
    const cid = (calendarId || 'primary').trim();
    await assertAddressAllowed({
      addresses: input.attendees ?? [],
      accountId: this.account.id,
      configRoot: this.configRoot,
      workaround: 'add the attendee yourself directly in Google Calendar',
      outcome: 'No event was created and no request reached Google Calendar.',
    });
    const response = await this.calendar.events.insert({
      calendarId: cid,
      sendNotifications: input.sendNotifications ?? true,
      requestBody: {
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: input.start,
        end: input.end,
        attendees: input.attendees?.map((email) => ({ email })),
        recurrence: input.recurrence,
      },
    });
    return this.parseCalendarEvent(response.data, cid);
  }

  async updateCalendarEvent(
    calendarId: string,
    eventId: string,
    updates: {
      summary?: string;
      description?: string;
      location?: string;
      start?: { dateTime?: string; date?: string; timeZone?: string };
      end?: { dateTime?: string; date?: string; timeZone?: string };
      attendees?: string[];
      status?: string;
      sendNotifications?: boolean;
    },
  ): Promise<CalendarEvent> {
    if (!calendarId?.trim()) throw new Error('calendar_id is required.');
    if (!eventId?.trim()) throw new Error('event_id is required.');
    await assertAddressAllowed({
      addresses: updates.attendees ?? [],
      accountId: this.account.id,
      configRoot: this.configRoot,
      workaround: 'add the attendee yourself directly in Google Calendar',
      outcome: 'The event was not changed and no request reached Google Calendar.',
    });
    const requestBody: calendar_v3.Schema$Event = {};
    if (updates.summary !== undefined) requestBody.summary = updates.summary;
    if (updates.description !== undefined) requestBody.description = updates.description;
    if (updates.location !== undefined) requestBody.location = updates.location;
    if (updates.start !== undefined) requestBody.start = updates.start;
    if (updates.end !== undefined) requestBody.end = updates.end;
    if (updates.status !== undefined) requestBody.status = updates.status;
    if (updates.attendees !== undefined) requestBody.attendees = updates.attendees.map((email) => ({ email }));

    const response = await this.calendar.events.patch({
      calendarId: calendarId.trim(),
      eventId: eventId.trim(),
      sendNotifications: updates.sendNotifications ?? true,
      requestBody,
    });
    return this.parseCalendarEvent(response.data, calendarId);
  }

  async deleteCalendarEvent(calendarId: string, eventId: string, sendNotifications = true): Promise<void> {
    if (!calendarId?.trim()) throw new Error('calendar_id is required.');
    if (!eventId?.trim()) throw new Error('event_id is required.');
    await this.calendar.events.delete({ calendarId: calendarId.trim(), eventId: eventId.trim(), sendNotifications });
  }

  private parseCalendarEvent(event: calendar_v3.Schema$Event, calendarId: string): CalendarEvent {
    return {
      id: event.id ?? '',
      calendarId,
      summary: event.summary ?? '(no title)',
      description: event.description ?? undefined,
      location: event.location ?? undefined,
      start: {
        dateTime: event.start?.dateTime ?? undefined,
        date: event.start?.date ?? undefined,
        timeZone: event.start?.timeZone ?? undefined,
      },
      end: {
        dateTime: event.end?.dateTime ?? undefined,
        date: event.end?.date ?? undefined,
        timeZone: event.end?.timeZone ?? undefined,
      },
      attendees: (event.attendees ?? []).map((a) => ({
        email: a.email ?? '',
        displayName: a.displayName ?? undefined,
        responseStatus: a.responseStatus ?? undefined,
        self: a.self ?? false,
      })),
      organizer: event.organizer
        ? { email: event.organizer.email ?? '', displayName: event.organizer.displayName ?? undefined, self: event.organizer.self ?? false }
        : undefined,
      status: event.status ?? undefined,
      htmlLink: event.htmlLink ?? undefined,
      recurrence: event.recurrence ?? undefined,
      recurringEventId: event.recurringEventId ?? undefined,
      created: event.created ?? undefined,
      updated: event.updated ?? undefined,
      conferenceData: event.conferenceData?.entryPoints?.length
        ? { entryPoints: event.conferenceData.entryPoints.map((ep) => ({ uri: ep.uri ?? '', entryPointType: ep.entryPointType ?? '' })) }
        : undefined,
      accountId: this.account.id,
      accountEmail: this.account.email,
    };
  }
}
