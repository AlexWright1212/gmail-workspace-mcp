/**
 * Shared arg interfaces and formatting/coercion helpers used by every tool
 * module under src/tools/. Moved verbatim out of src/index.ts during the
 * plan 002 Phase 1 registry restructure -- content is unchanged, only the
 * location and (for module-private declarations) the `export` keyword.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AccountConfig } from '../config.js';
import type {
  CalendarEvent,
  CalendarInfo,
  DriveFileDetail,
  DriveFileSummary,
  SpreadsheetMetadata,
} from '../gmail-client.js';
import type { AttachmentContent } from '../attachments.js';

export interface ReadEmailsArgs {
  account?: string;
  query?: string;
  max_results?: number;
  include_body?: boolean;
}

export interface SearchEmailsArgs {
  account?: string;
  query: string;
  max_results?: number;
}

export interface SearchDriveFilesArgs {
  account?: string;
  query: string;
  max_results?: number;
}

export interface ThreadArgs {
  account: string;
  thread_id: string;
}

export interface LabelsArgs {
  account: string;
}

export interface MessageIdsArgs {
  account: string;
  message_ids: string[];
}

export interface AddLabelsArgs extends MessageIdsArgs {
  label_ids: string[];
}

export interface DeleteLabelArgs {
  account: string;
  label_id: string;
}

export interface CreateLabelArgs {
  account: string;
  name: string;
  label_list_visibility?: string;
  message_list_visibility?: string;
}

export interface DeleteDraftsArgs {
  account: string;
  draft_ids: string[];
}

export interface OutgoingEmailArgs {
  account: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  attachments?: OutgoingEmailAttachmentArgs[];
}

export interface OutgoingEmailAttachmentArgs {
  path: string;
  filename?: string;
  content_type?: string;
}

export interface BeginAuthArgs {
  account_id: string;
  email: string;
  display_name?: string;
  credentials_json?: unknown;
  credentials_path?: string;
}

export interface FinishAuthArgs {
  account_id: string;
  authorization_code: string;
}

export interface GetAttachmentArgs {
  account: string;
  email_id: string;
  attachment_id: string;
}

export interface GetAllAttachmentsArgs {
  account: string;
  email_id: string;
}

export type BlockAction = 'trash' | 'archive' | 'spam';

export interface BlockSenderArgs {
  account: string;
  sender: string;
  action?: BlockAction;
  also_trash_existing?: boolean;
}

export interface UnblockSenderArgs {
  account: string;
  filter_id?: string;
  sender?: string;
}

export type MuteScope = 'subject' | 'thread_only';

// ─── Drive arg interfaces ────────────────────────────────────────────────────

export interface ListDriveFilesArgs {
  account?: string;
  folder_id?: string;
  query?: string;
  max_results?: number;
  page_token?: string;
}

export interface DriveFileIdArgs {
  account: string;
  file_id: string;
}

export interface UploadDriveFileArgs {
  account: string;
  local_path: string;
  name?: string;
  folder_id?: string;
  mime_type?: string;
}

export interface CreateDriveFolderArgs {
  account: string;
  name: string;
  parent_id?: string;
}

export interface UpdateDriveFileArgs {
  account: string;
  file_id: string;
  name?: string;
  add_parents?: string;
  remove_parents?: string;
  starred?: boolean;
  description?: string;
}

export interface ShareDriveFileArgs {
  account: string;
  file_id: string;
  email?: string;
  role: string;
  type: string;
  send_notification?: boolean;
  notification_message?: string;
}

// ─── Sheets arg interfaces ───────────────────────────────────────────────────

export interface SheetsSpreadsheetArgs {
  account: string;
  spreadsheet_id: string;
}

export interface SheetsReadArgs extends SheetsSpreadsheetArgs {
  range: string;
  value_render_option?: string;
}

export interface SheetsWriteArgs extends SheetsSpreadsheetArgs {
  range: string;
  values: unknown[][];
  value_input_option?: string;
}

export interface SheetsAppendArgs extends SheetsSpreadsheetArgs {
  range: string;
  values: unknown[][];
}

export interface SheetsCreateArgs {
  account: string;
  title: string;
}

export interface SheetsTabArgs extends SheetsSpreadsheetArgs {
  sheet_title: string;
}

export interface SheetsAddTabArgs extends SheetsSpreadsheetArgs {
  title: string;
  index?: number;
}

export interface SheetsRenameTabArgs extends SheetsSpreadsheetArgs {
  current_title: string;
  new_title: string;
}

export interface SheetsDimensionArgs extends SheetsSpreadsheetArgs {
  sheet_title: string;
  dimension: 'ROWS' | 'COLUMNS';
  start_index: number;
  count: number;
}

export interface SheetsFormatArgs extends SheetsSpreadsheetArgs {
  sheet_title: string;
  range: string;
  bold?: boolean;
  italic?: boolean;
  font_size?: number;
  background_color?: string;
  text_color?: string;
  horizontal_alignment?: 'LEFT' | 'CENTER' | 'RIGHT';
  number_format?: string;
  wrap_strategy?: 'OVERFLOW_CELL' | 'LEGACY_WRAP' | 'CLIP' | 'WRAP';
}

export interface SheetsAddChartArgs extends SheetsSpreadsheetArgs {
  sheet_title: string;
  chart_type: 'BAR' | 'LINE' | 'PIE' | 'COLUMN' | 'AREA' | 'SCATTER';
  data_range: string;
  title?: string;
  anchor_row?: number;
  anchor_col?: number;
  width_pixels?: number;
  height_pixels?: number;
}

// ─── Docs arg interfaces ─────────────────────────────────────────────────────

export interface DocsDocumentArgs {
  account: string;
  document_id: string;
}

export interface DocsCreateArgs {
  account: string;
  title: string;
}

export interface DocsAppendArgs extends DocsDocumentArgs {
  text: string;
  style?: 'NORMAL_TEXT' | 'HEADING_1' | 'HEADING_2' | 'HEADING_3';
  bold?: boolean;
  italic?: boolean;
}

export interface DocsReplaceArgs extends DocsDocumentArgs {
  find: string;
  replace_with: string;
  match_case?: boolean;
}

export interface DocsInsertTableArgs extends DocsDocumentArgs {
  rows: number;
  columns: number;
}

export interface DocsApplyStyleArgs extends DocsDocumentArgs {
  start_index: number;
  end_index: number;
  style: 'NORMAL_TEXT' | 'HEADING_1' | 'HEADING_2' | 'HEADING_3' | 'HEADING_4';
}

// ─── Calendar arg interfaces ─────────────────────────────────────────────────

export interface CalendarAccountArgs {
  account?: string;
}

export interface ListCalendarEventsArgs {
  account?: string;
  calendar_id?: string;
  time_min?: string;
  time_max?: string;
  query?: string;
  max_results?: number;
  single_events?: boolean;
}

export interface CalendarEventArgs {
  account: string;
  calendar_id: string;
  event_id: string;
}

export interface CreateCalendarEventArgs {
  account: string;
  calendar_id?: string;
  summary: string;
  description?: string;
  location?: string;
  start_date_time?: string;
  start_date?: string;
  end_date_time?: string;
  end_date?: string;
  time_zone?: string;
  attendees?: string[];
  recurrence?: string[];
  send_notifications?: boolean;
}

export interface UpdateCalendarEventArgs {
  account: string;
  calendar_id: string;
  event_id: string;
  summary?: string;
  description?: string;
  location?: string;
  start_date_time?: string;
  start_date?: string;
  end_date_time?: string;
  end_date?: string;
  time_zone?: string;
  attendees?: string[];
  status?: string;
  send_notifications?: boolean;
}

export interface DeleteCalendarEventArgs {
  account: string;
  calendar_id: string;
  event_id: string;
  send_notifications?: boolean;
}

export interface MuteThreadArgs {
  account: string;
  thread_id: string;
  scope?: MuteScope;
}

export function textResult(text: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

/**
 * From header for outgoing mail. Gmail rewrites this to the authenticated
 * account anyway, but supplying it makes the generated Message-ID use the real
 * sending domain instead of nodemailer's "@localhost" fallback.
 */
export function formatAccountFrom(account: AccountConfig): string {
  const name = account.displayName?.trim();
  return name ? `${name.replace(/[\r\n"]/g, ' ')} <${account.email}>` : account.email;
}

export function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(value, maxValue));
}

export function valueToString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function valueToBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function valueToNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function valueToStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).map((item) => item.trim()).filter(Boolean);
}

export function valueToAttachmentArray(value: unknown): OutgoingEmailAttachmentArgs[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Record<string, unknown>;
    const filePath = valueToString(candidate.path).trim();
    if (!filePath) return [];

    return [
      {
        path: filePath,
        filename: valueToString(candidate.filename, '').trim() || undefined,
        content_type: valueToString(candidate.content_type, '').trim() || undefined,
      },
    ];
  });
}

export const GENERIC_SUBJECTS = new Set([
  'hi',
  'hey',
  'hello',
  'test',
  'update',
  'updates',
  'news',
  'newsletter',
  '(no subject)',
  'notification',
  'notifications',
  'alert',
  'alerts',
]);

export function isGenericSubject(subject: string): boolean {
  const normalized = subject.trim().toLowerCase();
  if (normalized.length < 4) return true;
  return GENERIC_SUBJECTS.has(normalized);
}

export function driveFileDateForSort(file: DriveFileSummary): number {
  if (!file.modifiedTime) return 0;
  const timestamp = Date.parse(file.modifiedTime);
  return Number.isFinite(timestamp) ? timestamp : 0;
}


export function formatAttachmentContent(content: AttachmentContent): string {
  const lines = [
    `**Filename**: ${content.filename}`,
    `**Content-Type**: ${content.contentType}`,
    `**Size**: ${content.sizeBytes} bytes`,
    `**Saved to**: ${content.savedPath}`,
    `**Extraction Method**: ${content.extractionMethod}`,
  ];

  if (content.textTruncated) {
    lines.push('**Text Truncated**: true (exceeds 500 KB; saved file is complete)');
  }

  if (content.extractionError) {
    lines.push(`**Extraction Error**: ${content.extractionError}`);
  }

  if (content.text !== null) {
    lines.push('', '**Extracted Text**:', '', content.text);
  }

  return lines.join('\n');
}

export function formatDriveFileItem(file: DriveFileSummary): string {
  const lines = [
    `**Account**: ${file.accountId} (${file.accountEmail})`,
    `**File ID**: ${file.id}`,
    `**MIME Type**: ${file.mimeType}`,
    `**Modified**: ${file.modifiedTime || '(unknown)'}`,
    `**Owners**: ${file.owners.length > 0 ? file.owners.join(', ') : '(unknown)'}`,
  ];

  if (file.webViewLink) {
    lines.push(`**Open**: ${file.webViewLink}`);
  }

  return lines.join('\n');
}


export function formatDriveFileDetail(file: DriveFileDetail): string {
  const lines = [
    `**Account**: ${file.accountId} (${file.accountEmail})`,
    `**File ID**: ${file.id}`,
    `**Name**: ${file.name}`,
    `**MIME Type**: ${file.mimeType}`,
    `**Size**: ${file.size !== undefined ? `${file.size.toLocaleString()} bytes` : '(unavailable)'}`,
    `**Created**: ${file.createdTime || '(unknown)'}`,
    `**Modified**: ${file.modifiedTime || '(unknown)'}`,
    `**Owners**: ${file.owners.length > 0 ? file.owners.join(', ') : '(unknown)'}`,
    `**Shared**: ${file.shared ? 'yes' : 'no'}`,
    `**Trashed**: ${file.trashed ? 'yes' : 'no'}`,
    `**Starred**: ${file.starred ? 'yes' : 'no'}`,
  ];
  if (file.parents?.length) lines.push(`**Parent IDs**: ${file.parents.join(', ')}`);
  if (file.webViewLink) lines.push(`**Open**: ${file.webViewLink}`);
  if (file.exportLinks && Object.keys(file.exportLinks).length > 0) {
    lines.push('**Export Links**:');
    for (const [mime, link] of Object.entries(file.exportLinks)) {
      lines.push(`  - ${mime}: ${link}`);
    }
  }
  return lines.join('\n');
}

export function formatSpreadsheetMetadata(meta: SpreadsheetMetadata): string {
  const lines = [
    `**Spreadsheet ID**: ${meta.id}`,
    `**Title**: ${meta.title}`,
    `**URL**: ${meta.url}`,
    `**Sheets** (${meta.sheets.length}):`,
  ];
  for (const s of meta.sheets) {
    lines.push(`  - [${s.index}] "${s.title}" — ${s.rowCount} rows × ${s.columnCount} cols (sheetId: ${s.sheetId})`);
  }
  return lines.join('\n');
}

export function formatCalendarInfo(cal: CalendarInfo): string {
  const primary = cal.primary ? ' (primary)' : '';
  const lines = [
    `**Calendar ID**: ${cal.id}`,
    `**Name**: ${cal.summary}${primary}`,
    `**Account**: ${cal.accountId} (${cal.accountEmail})`,
    `**Access Role**: ${cal.accessRole ?? '(unknown)'}`,
  ];
  if (cal.timeZone) lines.push(`**Time Zone**: ${cal.timeZone}`);
  if (cal.description) lines.push(`**Description**: ${cal.description}`);
  return lines.join('\n');
}

/**
 * The UTC offset a named zone has at a given instant, as "-05:00", or
 * undefined when the zone name is unknown to ICU. Used only to decide how to
 * label an event time, never to convert one.
 */
function offsetOfZoneAt(timeZone: string, instant: Date): string | undefined {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(instant)
      .find((p) => p.type === 'timeZoneName')?.value; // "GMT-05:00" or "GMT"
    if (!part) return undefined;
    const m = part.match(/([+-]\d{2}:\d{2})$/);
    return m ? m[1] : '+00:00';
  } catch {
    return undefined;
  }
}

/**
 * An event time as Google gives it: an RFC3339 timestamp whose offset is the
 * calendar's, plus the zone name the event was stored with. Those two agree
 * for an event the owner made, and disagree for one an outside system
 * created (a Teams invite stored in Etc/UTC shows up as "15:00:00-05:00
 * (Etc/UTC)", which reads as a contradiction -- an agent in plan 002 Phase 5
 * flagged it as a bug). The timestamp's offset is always the truth about the
 * instant; when the named zone disagrees, say so instead of printing both
 * side by side as if they were the same claim.
 */
export function formatEventTime(t: { dateTime?: string; date?: string; timeZone?: string }): string {
  if (t.dateTime) {
    if (!t.timeZone) return t.dateTime;
    const offsetInStamp = t.dateTime.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1];
    const stampOffset = offsetInStamp === 'Z' ? '+00:00' : offsetInStamp;
    const zoneOffset = stampOffset ? offsetOfZoneAt(t.timeZone, new Date(t.dateTime)) : undefined;
    if (stampOffset && zoneOffset && zoneOffset !== stampOffset) {
      return `${t.dateTime} (offset ${stampOffset} is authoritative; the event's stored zone name is ${t.timeZone})`;
    }
    return `${t.dateTime} (${t.timeZone})`;
  }
  if (t.date) return `${t.date} (all day)`;
  return '(unknown)';
}

export function formatCalendarEvent(event: CalendarEvent): string {
  const startTime = formatEventTime(event.start);
  const endTime = formatEventTime(event.end);
  const lines = [
    `**Account**: ${event.accountId} (${event.accountEmail})`,
    `**Calendar**: ${event.calendarSummary ? `${event.calendarSummary} (${event.calendarId})` : event.calendarId}`,
    `**Event ID**: ${event.id}`,
    `**Status**: ${event.status ?? 'confirmed'}`,
    `**Start**: ${startTime}`,
    `**End**: ${endTime}`,
  ];
  if (event.location) lines.push(`**Location**: ${event.location}`);
  if (event.description) {
    const desc = event.description.length > 400 ? `${event.description.slice(0, 400)}…` : event.description;
    lines.push(`**Description**: ${desc}`);
  }
  if (event.organizer) lines.push(`**Organizer**: ${event.organizer.displayName || event.organizer.email}`);
  if (event.attendees.length > 0) {
    lines.push(`**Attendees** (${event.attendees.length}):`);
    for (const a of event.attendees) {
      const status = a.responseStatus ? ` [${a.responseStatus}]` : '';
      const self = a.self ? ' (you)' : '';
      lines.push(`  - ${a.displayName || a.email}${status}${self}`);
    }
  }
  if (event.htmlLink) lines.push(`**Open**: ${event.htmlLink}`);
  if (event.recurrence?.length) lines.push(`**Recurrence**: ${event.recurrence.join(', ')}`);
  if (event.conferenceData?.entryPoints?.length) {
    const meet = event.conferenceData.entryPoints.find((ep) => ep.entryPointType === 'video');
    if (meet) lines.push(`**Meet Link**: ${meet.uri}`);
  }
  return lines.join('\n');
}

/**
 * The lines that open any aggregate (both-accounts) result when one account
 * failed -- the same banner the mail endpoint uses (src/gmail-format.ts, ADR
 * 011): errors FIRST, because a per-account failure at the bottom of a long
 * list reads as "that account had nothing" (a Phase 5 agent called it
 * "buried in a field you'd have to notice"). Empty when nothing failed.
 */
export function incompleteBanner(errors: string[]): string[] {
  if (errors.length === 0) return [];
  return [
    '> ⚠️ **Some accounts failed — these results are INCOMPLETE.**',
    errors.map((error) => `> - ${error}`).join('\n'),
    '',
  ];
}

export function formatDriveFileListOutput(input: {
  title: string;
  scopeText: string;
  queryText: string;
  totalFound: number;
  returned: DriveFileSummary[];
  /** Per-account failures. Printed first, as an INCOMPLETE banner. */
  errors: string[];
  /** Non-failure footnotes (a next-page token). Printed last. */
  notes?: string[];
}): string {
  const sections: string[] = [];

  sections.push(`# ${input.title}`);
  sections.push('');
  sections.push(...incompleteBanner(input.errors));
  sections.push(`**Scope**: ${input.scopeText}`);
  sections.push(`**Query**: ${input.queryText}`);
  sections.push(`**Total Found**: ${input.totalFound}`);
  sections.push(`**Returned**: ${input.returned.length}`);

  if (input.returned.length > 0) {
    sections.push('');
    input.returned.forEach((file, index) => {
      sections.push(`## ${index + 1}. ${file.name}`);
      sections.push(formatDriveFileItem(file));
      sections.push('');
    });
  }

  if (input.notes && input.notes.length > 0) {
    sections.push('## Notes');
    sections.push(input.notes.map((note) => `- ${note}`).join('\n'));
  }

  return sections.join('\n');
}
