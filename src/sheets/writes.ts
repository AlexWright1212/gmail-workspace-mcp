/**
 * Google-calling logic for the Sheets WRITE tools (plan 002 Phase 4, unit A).
 * Split out from src/tools/sheets.ts so the pure parts (index mapping, hex
 * colour validation, the appended-row parser) are unit-testable without a
 * fake client, and so the Google-calling parts have one place that always
 * reports what the RESPONSE says changed, never the request echoed.
 *
 * Two kinds of calls happen here:
 *  - REUSED client methods (src/gmail-client.ts) that are already sound:
 *    readSheetValues, createSpreadsheet, addSheetTab, renameSheetTab,
 *    deleteSheetTab, insertDimension, deleteDimension, formatCells, addChart,
 *    getSheetsMetadata.
 *  - Direct googleapis calls via client.rawApis(), for values.update,
 *    values.append and values.batchUpdate -- the typed client methods for
 *    the first two don't return updatedColumns/updatedData, which the
 *    contract requires reporting, and values.batchUpdate has no typed
 *    wrapper at all (plan 002 Phase 4 contract, Sheets table).
 *
 * Every Google-calling function here goes through guard(), which formats a
 * thrown googleapis error with describeGoogleApiError exactly as the class's
 * own this.describe() does. guard() is safe to wrap around an error that is
 * already one of the class's own plain refusals (e.g. "spreadsheet_id is
 * required.") -- describeGoogleApiError falls through to returning the
 * message unchanged when nothing about it looks like a googleapis error, so
 * re-wrapping is idempotent.
 */
import type { GmailAccountClient, SpreadsheetMetadata } from '../gmail-client.js';
import { describeGoogleApiError, type GoogleService } from '../gmail-client.js';
import { columnIndexToLetter, columnLetterToIndex, parseA1Range, tabRange } from './a1.js';
import { buildHeaders, detectHeaderRow, resolveColumn } from './records.js';

async function guard<T>(accountId: string, service: GoogleService, fallback: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(describeGoogleApiError(error, { service, accountId, fallback }));
  }
}

// ─── Pure helpers (test/sheets-writes.test.mjs) ─────────────────────────────

export type CellValue = string | number | boolean | null;

export function isCellValue(value: unknown): value is CellValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * A `values` 2D array is refused before any Google call if it is not an
 * array of arrays of string/number/boolean/null cells.
 */
export function validateGrid(values: unknown): CellValue[][] {
  if (!Array.isArray(values)) throw new Error('values must be a 2D array (an array of row arrays).');
  values.forEach((row, r) => {
    if (!Array.isArray(row)) throw new Error(`values[${r}] must be an array -- row ${r + 1} is not.`);
    (row as unknown[]).forEach((cell, c) => {
      if (!isCellValue(cell)) {
        throw new Error(`values[${r}][${c}] must be a string, number, boolean, or null (row ${r + 1}, column ${c + 1}).`);
      }
    });
  });
  return values as CellValue[][];
}

/**
 * `before`/`start` for insert_sheet_dimension/delete_sheet_dimension: a
 * 1-based row number, or -- for columns -- a column letter or 1-based
 * column number. Returns the 0-based startIndex the Sheets API wants.
 * `dimensionStartIndex('rows', '9')` -> 8; `dimensionStartIndex('columns', 'C')` -> 2.
 */
export function dimensionStartIndex(dimension: 'rows' | 'columns', value: string): number {
  const v = (value ?? '').toString().trim();
  if (!v) {
    throw new Error(dimension === 'rows' ? 'A row number is required.' : 'A column letter or number is required.');
  }
  if (dimension === 'rows') {
    if (!/^\d+$/.test(v)) throw new Error(`Row must be a positive whole number, got "${value}".`);
    const n = Number(v);
    if (n < 1) throw new Error(`Row must be 1 or greater, got ${n}.`);
    return n - 1;
  }
  let n: number;
  if (/^[A-Za-z]+$/.test(v)) {
    n = columnLetterToIndex(v);
  } else if (/^\d+$/.test(v)) {
    n = Number(v);
  } else {
    throw new Error(`Column must be a letter (e.g. "C") or a positive number, got "${value}".`);
  }
  if (n < 1) throw new Error(`Column must be 1 or greater, got ${n}.`);
  return n - 1;
}

/** "rows 9–10" / "row 9" / "columns C–D" / "column C", for the insert/delete confirmation. */
export function dimensionLabel(dimension: 'rows' | 'columns', startIndex: number, count: number): string {
  if (dimension === 'rows') {
    const first = startIndex + 1;
    const last = startIndex + count;
    return first === last ? `row ${first}` : `rows ${first}–${last}`;
  }
  const first = columnIndexToLetter(startIndex + 1);
  const last = columnIndexToLetter(startIndex + count);
  return first === last ? `column ${first}` : `columns ${first}–${last}`;
}

export function isHexColor(value: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(value.trim());
}

export interface FormatFields {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  backgroundColor?: string;
  textColor?: string;
  horizontalAlignment?: 'LEFT' | 'CENTER' | 'RIGHT';
  numberFormat?: string;
  wrap?: 'OVERFLOW_CELL' | 'CLIP' | 'WRAP';
}

export function hasAnyFormatField(fmt: FormatFields): boolean {
  return (
    fmt.bold !== undefined ||
    fmt.italic !== undefined ||
    fmt.fontSize !== undefined ||
    fmt.backgroundColor !== undefined ||
    fmt.textColor !== undefined ||
    fmt.horizontalAlignment !== undefined ||
    fmt.numberFormat !== undefined ||
    fmt.wrap !== undefined
  );
}

export function appliedFormatFields(fmt: FormatFields): string[] {
  const applied: string[] = [];
  if (fmt.bold !== undefined) applied.push(`bold: ${fmt.bold}`);
  if (fmt.italic !== undefined) applied.push(`italic: ${fmt.italic}`);
  if (fmt.fontSize !== undefined) applied.push(`font size: ${fmt.fontSize}`);
  if (fmt.backgroundColor !== undefined) applied.push(`background: ${fmt.backgroundColor}`);
  if (fmt.textColor !== undefined) applied.push(`text color: ${fmt.textColor}`);
  if (fmt.horizontalAlignment !== undefined) applied.push(`alignment: ${fmt.horizontalAlignment}`);
  if (fmt.numberFormat !== undefined) applied.push(`number format: ${fmt.numberFormat}`);
  if (fmt.wrap !== undefined) applied.push(`wrap: ${fmt.wrap}`);
  return applied;
}

/** The first sheet row number of an A1 range Google handed back, e.g. from `updatedRange`. */
/**
 * The first sheet row in a range Google reported, or undefined when the
 * range carries no row (a whole-tab reference, or anything parseA1Range
 * cannot read). Never throws: this runs AFTER the append succeeded, and a
 * write that happened must never be reported as a failure.
 */
export function firstRowOf(a1Range: string): number | undefined {
  try {
    return parseA1Range(a1Range).startRow ?? undefined;
  } catch {
    return undefined;
  }
}

// ─── Google-calling functions ───────────────────────────────────────────────

export interface WriteRangeResult {
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

export async function writeRange(
  client: GmailAccountClient,
  accountId: string,
  spreadsheetId: string,
  a1: string,
  values: CellValue[][],
  valueInputOption: string,
): Promise<WriteRangeResult> {
  const sheets = client.rawApis().sheets;
  const response = await guard(accountId, 'Sheets', 'Sheet range write failed.', () =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: a1,
      valueInputOption,
      requestBody: { values },
    }));
  return {
    updatedRange: response.data.updatedRange ?? a1,
    updatedRows: response.data.updatedRows ?? 0,
    updatedColumns: response.data.updatedColumns ?? 0,
    updatedCells: response.data.updatedCells ?? 0,
  };
}

export interface AppendRowsResult {
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
  /** Undefined when Google's updatedRange named no row. */
  firstAppendedRow?: number;
}

export async function appendRows(
  client: GmailAccountClient,
  accountId: string,
  spreadsheetId: string,
  quotedTab: string,
  values: CellValue[][],
  valueInputOption: string,
): Promise<AppendRowsResult> {
  const sheets = client.rawApis().sheets;
  const response = await guard(accountId, 'Sheets', 'Row append failed.', () =>
    sheets.spreadsheets.values.append({
      spreadsheetId,
      range: quotedTab,
      valueInputOption,
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    }));
  const updates = response.data.updates ?? {};
  const updatedRange = updates.updatedRange ?? quotedTab;
  return {
    updatedRange,
    updatedRows: updates.updatedRows ?? 0,
    updatedColumns: updates.updatedColumns ?? 0,
    updatedCells: updates.updatedCells ?? 0,
    firstAppendedRow: firstRowOf(updatedRange),
  };
}

export interface UpdateRowCell {
  header: string;
  range: string;
  /** The value Google reports holding after the write; meaningful only when `confirmed`. */
  value: unknown;
  /** False when Google's response carried no updatedData for this cell. */
  confirmed: boolean;
}

export interface UpdateRowResult {
  headerRow: number;
  headerRowDetected: boolean;
  totalUpdatedCells: number;
  cells: UpdateRowCell[];
}

/**
 * Refuses BEFORE any Google write: an unrecognized header (lists the real
 * headers, via resolveColumn) or `row` at or above the header row. Only the
 * read (readSheetValues, to learn the headers) happens before those checks;
 * test/workspace-write-sheets.test.mjs proves no fake batchUpdate runs on a
 * refusal.
 */
export async function updateRow(
  client: GmailAccountClient,
  accountId: string,
  spreadsheetId: string,
  tab: string,
  row: number,
  values: Record<string, unknown>,
  explicitHeaderRow: number | undefined,
  valueInputOption: string,
): Promise<UpdateRowResult> {
  if (!Number.isInteger(row) || row < 1) {
    throw new Error(`row must be a positive whole number, got ${row}.`);
  }
  const entries = Object.entries(values);
  if (entries.length === 0) {
    throw new Error('values must have at least one "header: value" entry.');
  }
  for (const [key, value] of entries) {
    if (!isCellValue(value)) {
      throw new Error(`Value for "${key}" must be a string, number, boolean, or null.`);
    }
  }

  const result = await client.readSheetValues(spreadsheetId, tabRange(tab), 'FORMATTED_VALUE');
  if (result.values.length === 0) throw new Error(`Tab "${tab}" is empty.`);
  const headerRowDetected = explicitHeaderRow === undefined;
  const headerRow = explicitHeaderRow ?? detectHeaderRow(result.values);
  if (headerRow < 1) throw new Error(`Could not detect a header row in tab "${tab}"; pass header_row.`);
  const headers = buildHeaders(result.values[headerRow - 1] ?? []);

  if (row <= headerRow) {
    throw new Error(`Row ${row} is at or above the header row (${headerRow}); nothing was written.`);
  }

  const cellsToWrite = entries.map(([key, value]) => {
    const header = resolveColumn(headers, key); // throws, listing real headers, on a miss
    const colIndex = headers.indexOf(header) + 1; // 1-based
    const colLetter = columnIndexToLetter(colIndex);
    const range = tabRange(tab, `${colLetter}${row}`);
    return { header, range, value };
  });

  const sheets = client.rawApis().sheets;
  const response = await guard(accountId, 'Sheets', 'Row update failed.', () =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption,
        includeValuesInResponse: true,
        data: cellsToWrite.map((c) => ({ range: c.range, values: [[c.value]] })),
      },
    }));

  const responses = response.data.responses ?? [];
  // Only Google's response is reported. A cell whose response carries no
  // updatedData is printed as unconfirmed rather than echoing the caller's
  // value as if Google had confirmed it (adversarial review, 2026-09-19).
  const cells: UpdateRowCell[] = cellsToWrite.map((c, i) => {
    const single = responses[i];
    const confirmed = single?.updatedData?.values?.[0]?.[0];
    const hasValues = Array.isArray(single?.updatedData?.values);
    return {
      header: c.header,
      range: single?.updatedRange ?? c.range,
      value: hasValues ? (confirmed ?? '') : undefined,
      confirmed: hasValues,
    };
  });

  return {
    headerRow,
    headerRowDetected,
    totalUpdatedCells: response.data.totalUpdatedCells ?? cells.length,
    cells,
  };
}

export interface AddTabResult {
  sheetId: number;
  title: string;
  index?: number;
  headerUpdatedRange?: string;
}

export async function addTab(
  client: GmailAccountClient,
  accountId: string,
  spreadsheetId: string,
  title: string,
  headers: string[] | undefined,
  index: number | undefined,
): Promise<AddTabResult> {
  const added = await guard(accountId, 'Sheets', 'Add tab failed.', () => client.addSheetTab(spreadsheetId, title, index));

  let tabIndex: number | undefined;
  try {
    const meta = await client.getSheetsMetadata(spreadsheetId);
    tabIndex = meta.sheets.find((s) => s.sheetId === added.sheetId)?.index;
  } catch {
    tabIndex = undefined; // best-effort only; the tab was already created
  }

  let headerUpdatedRange: string | undefined;
  if (headers && headers.length > 0) {
    const sheets = client.rawApis().sheets;
    const response = await guard(accountId, 'Sheets', 'Header row write failed.', () =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: tabRange(added.title, 'A1'),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [headers] },
      }));
    headerUpdatedRange = response.data.updatedRange ?? undefined;
  }

  return { sheetId: added.sheetId, title: added.title, index: tabIndex, headerUpdatedRange };
}

function requireTab(meta: SpreadsheetMetadata, tab: string): void {
  const titles = meta.sheets.map((s) => s.title);
  if (!titles.includes(tab)) {
    throw new Error(`No tab named "${tab}". Tabs are: ${titles.map((t) => `"${t}"`).join(', ')}.`);
  }
}

export interface RenameTabResult {
  oldTitle: string;
  newTitle: string;
  confirmed: boolean;
  tabs: string[];
}

export async function renameTab(
  client: GmailAccountClient,
  accountId: string,
  spreadsheetId: string,
  tab: string,
  newTitle: string,
): Promise<RenameTabResult> {
  const meta = await client.getSheetsMetadata(spreadsheetId);
  requireTab(meta, tab);
  await guard(accountId, 'Sheets', 'Rename tab failed.', () => client.renameSheetTab(spreadsheetId, tab, newTitle));
  const after = await client.getSheetsMetadata(spreadsheetId);
  return {
    oldTitle: tab,
    newTitle,
    confirmed: after.sheets.some((s) => s.title === newTitle),
    tabs: after.sheets.map((s) => s.title),
  };
}

export interface DeleteTabResult {
  deleted: string;
  remainingTabs: string[];
}

export async function deleteTab(
  client: GmailAccountClient,
  accountId: string,
  spreadsheetId: string,
  tab: string,
): Promise<DeleteTabResult> {
  const meta = await client.getSheetsMetadata(spreadsheetId);
  requireTab(meta, tab);
  await guard(accountId, 'Sheets', 'Delete tab failed.', () => client.deleteSheetTab(spreadsheetId, tab));
  const after = await client.getSheetsMetadata(spreadsheetId);
  return { deleted: tab, remainingTabs: after.sheets.map((s) => s.title) };
}

export interface DimensionChangeResult {
  dimension: 'rows' | 'columns';
  startIndex: number;
  count: number;
  label: string;
  tab: string;
  newRowCount?: number;
  newColumnCount?: number;
}

export async function insertDimensionOnTab(
  client: GmailAccountClient,
  accountId: string,
  spreadsheetId: string,
  tab: string,
  dimension: 'rows' | 'columns',
  before: string,
  count: number,
): Promise<DimensionChangeResult> {
  if (!Number.isInteger(count) || count < 1) throw new Error(`count must be a positive whole number, got ${count}.`);
  const startIndex = dimensionStartIndex(dimension, before);
  await guard(accountId, 'Sheets', 'Insert failed.', () =>
    client.insertDimension(spreadsheetId, tab, dimension === 'rows' ? 'ROWS' : 'COLUMNS', startIndex, count));
  const meta = await client.getSheetsMetadata(spreadsheetId);
  const sheet = meta.sheets.find((s) => s.title === tab);
  return {
    dimension,
    startIndex,
    count,
    tab,
    label: dimensionLabel(dimension, startIndex, count),
    newRowCount: sheet?.rowCount,
    newColumnCount: sheet?.columnCount,
  };
}

export async function deleteDimensionOnTab(
  client: GmailAccountClient,
  accountId: string,
  spreadsheetId: string,
  tab: string,
  dimension: 'rows' | 'columns',
  start: string,
  count: number,
): Promise<DimensionChangeResult> {
  if (!Number.isInteger(count) || count < 1) throw new Error(`count must be a positive whole number, got ${count}.`);
  const startIndex = dimensionStartIndex(dimension, start);
  await guard(accountId, 'Sheets', 'Delete failed.', () =>
    client.deleteDimension(spreadsheetId, tab, dimension === 'rows' ? 'ROWS' : 'COLUMNS', startIndex, count));
  const meta = await client.getSheetsMetadata(spreadsheetId);
  const sheet = meta.sheets.find((s) => s.title === tab);
  return {
    dimension,
    startIndex,
    count,
    tab,
    label: dimensionLabel(dimension, startIndex, count),
    newRowCount: sheet?.rowCount,
    newColumnCount: sheet?.columnCount,
  };
}

export async function formatRange(
  client: GmailAccountClient,
  accountId: string,
  spreadsheetId: string,
  tab: string,
  range: string,
  fmt: FormatFields,
): Promise<{ tab: string; range: string; applied: string[] }> {
  if (!hasAnyFormatField(fmt)) {
    throw new Error(
      'At least one formatting field is required: bold, italic, font_size, background_color, text_color, horizontal_alignment, number_format, or wrap.',
    );
  }
  if (fmt.backgroundColor !== undefined && !isHexColor(fmt.backgroundColor)) {
    throw new Error(`background_color must be a hex color like "#RRGGBB", got "${fmt.backgroundColor}".`);
  }
  if (fmt.textColor !== undefined && !isHexColor(fmt.textColor)) {
    throw new Error(`text_color must be a hex color like "#RRGGBB", got "${fmt.textColor}".`);
  }
  const applied = appliedFormatFields(fmt);
  await guard(accountId, 'Sheets', 'Formatting failed.', () =>
    client.formatCells(spreadsheetId, tab, range, {
      bold: fmt.bold,
      italic: fmt.italic,
      fontSize: fmt.fontSize,
      backgroundColor: fmt.backgroundColor,
      textColor: fmt.textColor,
      horizontalAlignment: fmt.horizontalAlignment,
      numberFormat: fmt.numberFormat,
      wrapStrategy: fmt.wrap,
    }));
  return { tab, range, applied };
}

export interface ChartResult {
  chartId: number;
  tab: string;
  anchorCell: string;
}

export async function addSheetChart(
  client: GmailAccountClient,
  accountId: string,
  spreadsheetId: string,
  tab: string,
  opts: {
    chartType: 'BAR' | 'COLUMN' | 'LINE' | 'PIE' | 'AREA' | 'SCATTER';
    dataRange: string;
    title?: string;
    anchorCell?: string;
    widthPixels?: number;
    heightPixels?: number;
  },
): Promise<ChartResult> {
  const anchorCell = opts.anchorCell?.trim() || 'A1';
  const anchor = parseA1Range(anchorCell);
  const anchorRow = (anchor.startRow ?? 1) - 1;
  const anchorCol = (anchor.startColumn ?? 1) - 1;
  const result = await guard(accountId, 'Sheets', 'Add chart failed.', () =>
    client.addChart(spreadsheetId, tab, {
      chartType: opts.chartType,
      dataRange: opts.dataRange,
      title: opts.title,
      anchorRow,
      anchorCol,
      widthPixels: opts.widthPixels,
      heightPixels: opts.heightPixels,
    }));
  return { chartId: result.chartId, tab, anchorCell };
}

export interface CreateSpreadsheetResult {
  id: string;
  url: string;
  parents?: string[];
}

export async function createSpreadsheetInFolder(
  client: GmailAccountClient,
  accountId: string,
  title: string,
  folderId: string | undefined,
): Promise<CreateSpreadsheetResult> {
  const created = await guard(accountId, 'Sheets', 'Spreadsheet creation failed.', () => client.createSpreadsheet(title));
  if (!folderId) return { id: created.id, url: created.url };

  const drive = client.rawApis().drive;
  const currentParents = await guard(accountId, 'Drive', "Reading the new spreadsheet's folders failed.", async () => {
    const got = await drive.files.get({ fileId: created.id, fields: 'parents' });
    return got.data.parents ?? [];
  });
  const parents = await guard(accountId, 'Drive', 'Moving the spreadsheet into the folder failed.', async () => {
    const updated = await drive.files.update({
      fileId: created.id,
      addParents: folderId,
      removeParents: currentParents.join(','),
      fields: 'parents',
    });
    return updated.data.parents ?? undefined;
  });

  return { id: created.id, url: created.url, parents };
}
