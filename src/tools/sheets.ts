/**
 * Google Sheets tools. Moved out of src/index.ts during the plan 002 Phase 1
 * registry restructure. The READ tools (get_spreadsheet, read_sheet_range,
 * read_sheet_records, find_sheet_rows, get_sheet_dropdown) were reshaped or
 * added in Phase 3: a tab is always passed by name and quoted by the tool
 * (src/sheets/a1.ts), reads carry row numbers, and a column is addressed by
 * its header text (src/sheets/records.ts).
 *
 * The WRITE tools below them (write_sheet_range, append_sheet_rows,
 * update_sheet_row, add_sheet_tab, rename_sheet_tab, delete_sheet_tab,
 * insert_sheet_dimension, delete_sheet_dimension, format_sheet_range,
 * add_sheet_chart, create_spreadsheet) are plan 002 Phase 4, unit A --
 * replacing the ten inherited sheets_* tools (sheets_write, sheets_append,
 * sheets_create, sheets_add_tab, sheets_rename_tab, sheets_delete_tab,
 * sheets_format, sheets_add_chart, sheets_insert_dimension,
 * sheets_delete_dimension), not aliasing them. Every write reports what
 * Google's RESPONSE says changed, never the request echoed; the actual
 * Google calls and the pure argument-parsing helpers live in
 * src/sheets/writes.ts.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AccountConfig } from '../config.js';
import type { GmailAccountClient } from '../gmail-client.js';
import { resolveWriteAccount } from '../accounts.js';
import { columnIndexToLetter, parseA1Range, quoteTabName, tabRange } from '../sheets/a1.js';
import { buildRecords, detectHeaderRow, findRows, resolveColumn, type MatchMode } from '../sheets/records.js';
import { extractDropdownRules, sourceRangeToA1 } from '../sheets/validation.js';
import {
  addSheetChart,
  addTab,
  appendRows,
  createSpreadsheetInFolder,
  deleteDimensionOnTab,
  deleteTab,
  formatRange,
  insertDimensionOnTab,
  renameTab,
  updateRow,
  validateGrid,
  writeRange,
} from '../sheets/writes.js';
import {
  textResult,
  clamp,
  valueToString,
  valueToNumber,
  valueToBoolean,
  valueToStringArray,
  formatSpreadsheetMetadata,
} from './shared.js';
import type { ToolContext, ToolDefinition, ToolHandler, ToolModule } from './types.js';

const ACCOUNT_REQUIRED = 'Account the spreadsheet id belongs to: "personal" or "tamu". Required.';
const TAB_PARAM = 'Tab name exactly as shown by get_spreadsheet, e.g. "Career Fair". Pass it plain; the tool quotes it.';
const HEADER_ROW_PARAM = 'Row number holding the column headers. Omit to auto-detect (the widest row near the top -- trackers often have a title block above the headers); the result says which row was used.';
const MAX_RECORDS = 1000;

async function resolveSheetsClient(
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ acc: AccountConfig; client: GmailAccountClient }> {
  const account = valueToString(rawArgs.account);
  const config = await ctx.loadConfig();
  const acc = resolveWriteAccount(config, account);
  const client = await ctx.getClientForAccount(acc);
  return { acc, client };
}

export const getSpreadsheetTool: ToolDefinition = {
  name: 'get_spreadsheet',
  description:
    'A spreadsheet\'s title and its tabs (names, sizes). Start here to learn the tab names before reading; find the spreadsheet id with search_drive_files.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id (from search_drive_files or the URL).' },
    },
    required: ['account', 'spreadsheet_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
export const readSheetRangeTool: ToolDefinition = {
  name: 'read_sheet_range',
  description:
    'Read a tab as a raw grid with sheet row numbers and column letters, so a later write can target exact cells. Omit range for the whole tab. For rows keyed by header name use read_sheet_records instead.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      range: { type: 'string', description: 'Optional cell range within the tab in A1 form, e.g. "A1:D10" or "B:B". No tab name here. Default: the whole tab.' },
      value_render_option: {
        type: 'string',
        enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'],
        description: 'FORMATTED_VALUE (default) is what the sheet displays; FORMULA shows formulas instead of results.',
      },
    },
    required: ['account', 'spreadsheet_id', 'tab'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
export const readSheetRecordsTool: ToolDefinition = {
  name: 'read_sheet_records',
  description:
    'Read a tab as records keyed by its header row -- one object per data row, each with its sheet row number -- so you work with column names instead of counting columns. The usual way to read a tracker.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      header_row: { type: 'number', description: HEADER_ROW_PARAM },
      max_rows: { type: 'number', description: `Maximum data rows to return (1-${MAX_RECORDS}, default 200). Rows beyond it are counted, never silently dropped.`, default: 200 },
    },
    required: ['account', 'spreadsheet_id', 'tab'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
export const findSheetRowsTool: ToolDefinition = {
  name: 'find_sheet_rows',
  description:
    'Find the rows in a tab where one column (named by its header) holds a value, and return each match with its sheet row number and all its cells. Use it to locate "the row for Company X" before updating it. Matching ignores case and surrounding spaces.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      column: { type: 'string', description: 'Header text of the column to match, e.g. "Company".' },
      value: { type: 'string', description: 'Value to look for.' },
      match: { type: 'string', enum: ['exact', 'contains'], description: 'exact (default): the whole cell equals value. contains: the cell includes value.' },
      header_row: { type: 'number', description: HEADER_ROW_PARAM },
    },
    required: ['account', 'spreadsheet_id', 'tab', 'column', 'value'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
export const getSheetDropdownTool: ToolDefinition = {
  name: 'get_sheet_dropdown',
  description:
    'Read the dropdown (data-validation) rule on a cell or range: the values it allows and whether other values are rejected. Check this before writing to a column like Status so the value is one the sheet accepts. Reading only; rules cannot be changed here.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      range: { type: 'string', description: 'A cell or range in A1 form within the tab, e.g. "D2" or "D2:D50". No tab name here.' },
    },
    required: ['account', 'spreadsheet_id', 'tab', 'range'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const DIMENSION_PARAM = 'Whether "before"/"start" addresses a row or a column.';
const COUNT_PARAM = 'How many rows or columns, starting from before/start (default 1).';

export const writeSheetRangeTool: ToolDefinition = {
  name: 'write_sheet_range',
  description:
    'Overwrite one range of cells in a tab with new values -- exactly that range and nothing else. Use for filling in a known block of cells; to change one row found by find_sheet_rows or read_sheet_records, use update_sheet_row instead so unrelated cells in the row are never touched.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      range: { type: 'string', description: 'Cell range within the tab in A1 form, e.g. "B7:D9". No tab name here.' },
      values: { type: 'array', items: { type: 'array' }, description: '2D array of rows to write (each cell a string, number, boolean, or null).' },
      value_input_option: { type: 'string', enum: ['RAW', 'USER_ENTERED'], description: 'USER_ENTERED (default) parses values the way typing them into the sheet would (dates, formulas); RAW stores text exactly as given.' },
    },
    required: ['account', 'spreadsheet_id', 'tab', 'range', 'values'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};
export const appendSheetRowsTool: ToolDefinition = {
  name: 'append_sheet_rows',
  description:
    'Add one or more rows after the last row of existing data in a tab -- Google finds the end of the table itself, so there is no need to know or compute a row count. Values are aligned to the table\'s FIRST HEADER COLUMN (not column A): give cells in header order, as read_sheet_records lists them. Reports the range Google wrote.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      values: { type: 'array', items: { type: 'array' }, description: '2D array of rows to append (each cell a string, number, boolean, or null).' },
      value_input_option: { type: 'string', enum: ['RAW', 'USER_ENTERED'], description: 'USER_ENTERED (default) parses values the way typing them into the sheet would; RAW stores text exactly as given.' },
    },
    required: ['account', 'spreadsheet_id', 'tab', 'values'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};
export const updateSheetRowTool: ToolDefinition = {
  name: 'update_sheet_row',
  description:
    'Change specific cells of one existing sheet row, addressed by column header name rather than letter -- e.g. set only Status without touching Company or Link. Get the row number first from find_sheet_rows or read_sheet_records. Refuses an unrecognized header, or a row at or above the header row, before writing anything.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      row: { type: 'number', description: 'Sheet row number to update, from find_sheet_rows or read_sheet_records.' },
      values: { type: 'object', description: 'Map of header name to new value, e.g. {"Status": "Interview"}. Only these cells are touched.' },
      header_row: { type: 'number', description: HEADER_ROW_PARAM },
      value_input_option: { type: 'string', enum: ['RAW', 'USER_ENTERED'], description: 'USER_ENTERED (default) parses values the way typing them into the sheet would; RAW stores text exactly as given.' },
    },
    required: ['account', 'spreadsheet_id', 'tab', 'row', 'values'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};
export const addSheetTabTool: ToolDefinition = {
  name: 'add_sheet_tab',
  description:
    'Add a new tab to a spreadsheet, optionally writing a header row into it right away -- e.g. a "Career Fair" tab with Company/Role/Status columns. Reports the tab Google actually created, including its id and position.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      title: { type: 'string', description: 'Name for the new tab.' },
      headers: { type: 'array', items: { type: 'string' }, description: 'Optional column headers to write into row 1 of the new tab.' },
      index: { type: 'number', description: 'Optional zero-based position for the new tab among the existing ones.' },
    },
    required: ['account', 'spreadsheet_id', 'title'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};
export const renameSheetTabTool: ToolDefinition = {
  name: 'rename_sheet_tab',
  description:
    'Rename an existing tab of a spreadsheet. Refuses with the real tab names if the one given does not exist, and confirms the new name by reading the spreadsheet back afterward.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      new_title: { type: 'string', description: 'New name for the tab.' },
    },
    required: ['account', 'spreadsheet_id', 'tab', 'new_title'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};
export const deleteSheetTabTool: ToolDefinition = {
  name: 'delete_sheet_tab',
  description:
    'Permanently delete a tab and everything in it from a spreadsheet. Google keeps version history that can undo this, but there is no confirmation step here -- name the tab carefully. Reports the tabs that remain afterward.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
    },
    required: ['account', 'spreadsheet_id', 'tab'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};
export const insertSheetDimensionTool: ToolDefinition = {
  name: 'insert_sheet_dimension',
  description:
    'Insert new blank rows or columns into a tab before a given row number or column letter, shifting existing content down or right -- e.g. inserting a row in the middle of a tracker. Reports the sheet\'s new row or column count.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      dimension: { type: 'string', enum: ['rows', 'columns'], description: DIMENSION_PARAM },
      before: { type: ['string', 'number'], description: 'Where the new rows/columns go, immediately before this: a 1-based row number (e.g. "9") if dimension is "rows", or a column letter or number (e.g. "C" or "3") if dimension is "columns".' },
      count: { type: 'number', description: COUNT_PARAM },
    },
    required: ['account', 'spreadsheet_id', 'tab', 'dimension', 'before'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};
export const deleteSheetDimensionTool: ToolDefinition = {
  name: 'delete_sheet_dimension',
  description:
    'Permanently delete whole rows or columns from a tab, starting at a given row number or column letter, shifting remaining content up or left. Google keeps version history that can undo this. Reports the sheet\'s new row or column count.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      dimension: { type: 'string', enum: ['rows', 'columns'], description: DIMENSION_PARAM },
      start: { type: ['string', 'number'], description: 'First row/column to delete: a 1-based row number (e.g. "9") if dimension is "rows", or a column letter or number (e.g. "C" or "3") if dimension is "columns".' },
      count: { type: 'number', description: COUNT_PARAM },
    },
    required: ['account', 'spreadsheet_id', 'tab', 'dimension', 'start'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};
export const formatSheetRangeTool: ToolDefinition = {
  name: 'format_sheet_range',
  description:
    'Apply visual formatting -- bold, italic, font size, background or text color, alignment, number format, or text wrap -- to a range of cells, such as bolding a header row. Refuses if no formatting field is given (it would otherwise silently do nothing). Appearance can only be confirmed by eye in Google Sheets.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      range: { type: 'string', description: 'Cell range within the tab in A1 form, e.g. "A1:D1". No tab name here.' },
      bold: { type: 'boolean', description: 'Apply or remove bold.' },
      italic: { type: 'boolean', description: 'Apply or remove italic.' },
      font_size: { type: 'number', description: 'Font size in points.' },
      background_color: { type: 'string', description: 'Background color as hex, e.g. "#FF0000".' },
      text_color: { type: 'string', description: 'Text color as hex, e.g. "#FFFFFF".' },
      horizontal_alignment: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT'], description: 'Horizontal text alignment.' },
      number_format: { type: 'string', description: 'Number format pattern, e.g. "#,##0.00" or "MM/DD/YYYY".' },
      wrap: { type: 'string', enum: ['OVERFLOW_CELL', 'CLIP', 'WRAP'], description: 'Cell text wrap behavior.' },
    },
    required: ['account', 'spreadsheet_id', 'tab', 'range'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};
export const addSheetChartTool: ToolDefinition = {
  name: 'add_sheet_chart',
  description:
    'Create a chart in a tab from a data range, where the first column is labels, other columns are data series, and the first row is headers. Appearance and placement can only be confirmed by eye in Google Sheets; the tool only confirms the chart was created without error.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
      tab: { type: 'string', description: TAB_PARAM },
      chart_type: { type: 'string', enum: ['BAR', 'COLUMN', 'LINE', 'PIE', 'AREA', 'SCATTER'], description: 'Chart type.' },
      data_range: { type: 'string', description: 'Cell range within the tab in A1 form for the chart\'s data, e.g. "A1:B10". No tab name here.' },
      title: { type: 'string', description: 'Optional chart title.' },
      anchor_cell: { type: 'string', description: 'A1 cell within the tab the chart\'s top-left corner sits on (default "A1").' },
      width_pixels: { type: 'number', description: 'Chart width in pixels (default 600).' },
      height_pixels: { type: 'number', description: 'Chart height in pixels (default 400).' },
    },
    required: ['account', 'spreadsheet_id', 'tab', 'chart_type', 'data_range'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};
export const createSpreadsheetTool: ToolDefinition = {
  name: 'create_spreadsheet',
  description:
    'Create a brand-new Google Sheets spreadsheet, optionally moving it into a Drive folder immediately -- e.g. into a shared tracking folder. Reports the id, URL, and, when a folder was given, the parent folders Google confirms after the move.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      title: { type: 'string', description: 'Spreadsheet title.' },
      folder_id: { type: 'string', description: 'Optional Drive folder id to move the new spreadsheet into (from search_drive_files or list_drive_folder).' },
    },
    required: ['account', 'title'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};
export async function handleGetSpreadsheet(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);
    const meta = await client.getSheetsMetadata(valueToString(rawArgs.spreadsheet_id));
    return textResult(['# Google Sheets Spreadsheet', '', `**Account**: ${acc.id} (${acc.email})`, '', formatSpreadsheetMetadata(meta)].join('\n'));
  }


function cellString(cell: unknown): string {
  return String(cell ?? '');
}

export async function handleReadSheetRange(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);
    const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
    const tab = valueToString(rawArgs.tab);
    const range = valueToString(rawArgs.range, '').trim() || undefined;
    const a1 = tabRange(tab, range);
    const result = await client.readSheetValues(
      spreadsheetId,
      a1,
      valueToString(rawArgs.value_render_option, 'FORMATTED_VALUE') || 'FORMATTED_VALUE',
    );

    const parsed = parseA1Range(result.range);
    const firstRow = parsed.startRow ?? 1;
    const firstCol = parsed.startColumn ?? 1;
    // Google drops trailing empty cells from each row, so the widest row can be
    // narrower than the range asked for. Size the column header from the
    // range when it is bounded, so "A1:C3" always shows A, B and C.
    const rangeWidth = parsed.endColumn !== undefined ? parsed.endColumn - firstCol + 1 : 0;
    const width = Math.max(rangeWidth, ...result.values.map((row) => (row as unknown[]).length));

    const lines: string[] = [
      '# Sheet Range',
      '',
      `**Account**: ${acc.id} (${acc.email})`,
      `**Spreadsheet**: ${spreadsheetId}`,
      `**Tab**: ${tab}`,
      `**Range Read**: ${result.range}`,
      `**Rows**: ${result.values.length}`,
      '',
    ];

    if (result.values.length === 0) {
      lines.push('*(empty range -- no data)*');
    } else {
      lines.push('Tab-separated; first column is the sheet row number, header line is the column letters.', '', '```');
      lines.push(['row', ...Array.from({ length: width }, (_, i) => columnIndexToLetter(firstCol + i))].join('\t'));
      result.values.forEach((row, i) => {
        const cells = (row as unknown[]).map(cellString);
        while (cells.length < width) cells.push('');
        lines.push([String(firstRow + i), ...cells].join('\t'));
      });
      lines.push('```');
    }

    return textResult(lines.join('\n'));
  }


async function loadRecords(
  ctx: ToolContext,
  rawArgs: Record<string, unknown>,
  maxRows: number,
) {
    const account = valueToString(rawArgs.account);
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);
    const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
    const tab = valueToString(rawArgs.tab);
    const result = await client.readSheetValues(spreadsheetId, tabRange(tab), 'FORMATTED_VALUE');
    if (result.values.length === 0) {
      throw new Error(`Tab "${tab}" is empty.`);
    }
    const explicit = rawArgs.header_row !== undefined && rawArgs.header_row !== null;
    const headerRow = explicit ? valueToNumber(rawArgs.header_row, 1) : detectHeaderRow(result.values);
    const records = buildRecords(result.values, headerRow, maxRows);
    return { acc, spreadsheetId, tab, records, headerRowDetected: !explicit };
}

export async function handleReadSheetRecords(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const maxRows = clamp(valueToNumber(rawArgs.max_rows, 200), 1, MAX_RECORDS);
    const { acc, spreadsheetId, tab, records, headerRowDetected } = await loadRecords(ctx, rawArgs, maxRows);

    const lines: string[] = [
      '# Sheet Records',
      '',
      `**Account**: ${acc.id} (${acc.email})`,
      `**Spreadsheet**: ${spreadsheetId}`,
      `**Tab**: ${tab}`,
      `**Header Row**: ${records.headerRow}${headerRowDetected ? ' (auto-detected; pass header_row to override)' : ''}`,
      `**Columns**: ${records.headers.map((h) => `"${h}"`).join(', ')}`,
      `**Data Rows Returned**: ${records.records.length}`,
    ];
    if (records.omitted > 0) {
      lines.push(`**Data Rows Omitted**: ${records.omitted} (raise max_rows, or use read_sheet_range on a narrower range)`);
    }
    lines.push('', 'Each record\'s "row" is its sheet row number.', '', '```json', JSON.stringify(records.records, null, 1), '```');
    return textResult(lines.join('\n'));
  }


export async function handleFindSheetRows(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const column = valueToString(rawArgs.column);
    const value = valueToString(rawArgs.value);
    const match = (valueToString(rawArgs.match, 'exact').trim() || 'exact') as MatchMode;
    if (match !== 'exact' && match !== 'contains') throw new Error('match must be "exact" or "contains".');

    const { acc, spreadsheetId, tab, records, headerRowDetected } = await loadRecords(ctx, rawArgs, Number.POSITIVE_INFINITY);
    const header = resolveColumn(records.headers, column);
    const hits = findRows(records.records, header, value, match);

    const lines: string[] = [
      '# Sheet Row Search',
      '',
      `**Account**: ${acc.id} (${acc.email})`,
      `**Spreadsheet**: ${spreadsheetId}`,
      `**Tab**: ${tab}`,
      `**Header Row**: ${records.headerRow}${headerRowDetected ? ' (auto-detected; pass header_row to override)' : ''}`,
      `**Column**: "${header}" ${match === 'contains' ? 'contains' : 'equals'} "${value}"`,
      `**Data Rows Scanned**: ${records.records.length}`,
      `**Matches**: ${hits.length}`,
      '',
    ];
    if (hits.length === 0) {
      lines.push(`No rows where "${header}" ${match === 'contains' ? 'contains' : 'equals'} "${value}". Columns are: ${records.headers.map((h) => `"${h}"`).join(', ')}.`);
    } else {
      lines.push('Each match\'s "row" is its sheet row number.', '', '```json', JSON.stringify(hits, null, 1), '```');
    }
    return textResult(lines.join('\n'));
  }


export async function handleGetSheetDropdown(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);
    const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
    const tab = valueToString(rawArgs.tab);
    const range = valueToString(rawArgs.range, '').trim();
    if (!range) throw new Error('range is required (a cell or range within the tab, e.g. "D2").');
    const a1 = tabRange(tab, range);

    const sheet = await client.getSheetValidationGrid(spreadsheetId, a1);
    const rules = extractDropdownRules(sheet);

    const lines: string[] = [
      '# Sheet Dropdown Rules',
      '',
      `**Account**: ${acc.id} (${acc.email})`,
      `**Spreadsheet**: ${spreadsheetId}`,
      `**Range**: ${a1}`,
      `**Rules Found**: ${rules.length}`,
      '',
    ];
    if (rules.length === 0) {
      lines.push(`No dropdown or validation rule on ${a1}. Any value can be written there.`);
      return textResult(lines.join('\n'));
    }

    for (const [i, rule] of rules.entries()) {
      let values = rule.values;
      let source = '';
      if (rule.conditionType === 'ONE_OF_RANGE' && rule.sourceRange) {
        source = rule.sourceRange;
        try {
          const src = await client.readSheetValues(spreadsheetId, sourceRangeToA1(rule.sourceRange), 'FORMATTED_VALUE');
          values = src.values.flat().map(cellString).map((v) => v.trim()).filter(Boolean);
        } catch (error) {
          source = `${rule.sourceRange} (could not read: ${(error as Error).message})`;
        }
      }
      const cells = rule.cells.length > 6
        ? `${rule.cells.slice(0, 5).join(', ')}, ... ${rule.cells[rule.cells.length - 1]} (${rule.cells.length} cells)`
        : rule.cells.join(', ');
      lines.push(`## Rule ${i + 1}`);
      lines.push(`**Cells**: ${cells}`);
      lines.push(`**Kind**: ${rule.conditionType}${source ? ` from ${source}` : ''}`);
      lines.push(`**Allowed Values** (${values.length}): ${values.map((v) => `"${v}"`).join(', ') || '(none listed)'}`);
      lines.push(`**Other Values**: ${rule.strict ? 'rejected' : 'allowed with a warning'}`);
      lines.push(`**Shows Dropdown**: ${rule.showDropdown ? 'yes' : 'no'}`);
      if (rule.inputMessage) lines.push(`**Help Text**: ${rule.inputMessage}`);
      lines.push('');
    }
    return textResult(lines.join('\n'));
  }


function printCellValue(value: unknown): string {
  return value === null || value === undefined ? '(empty)' : String(value);
}

export async function handleWriteSheetRange(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const { acc, client } = await resolveSheetsClient(rawArgs, ctx);
  const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
  const tab = valueToString(rawArgs.tab);
  const range = valueToString(rawArgs.range).trim();
  if (!range) throw new Error('range is required (a cell range within the tab, e.g. "B7:D9").');
  const values = validateGrid(rawArgs.values);
  const a1 = tabRange(tab, range);
  const valueInputOption = valueToString(rawArgs.value_input_option, 'USER_ENTERED') || 'USER_ENTERED';

  const result = await writeRange(client, acc.id, spreadsheetId, a1, values, valueInputOption);

  return textResult([
    `✅ Wrote ${result.updatedCells} cell(s) to ${result.updatedRange}.`,
    `**Account**: ${acc.id} (${acc.email})`,
    `**Updated Range**: ${result.updatedRange}`,
    `**Rows Updated**: ${result.updatedRows}`,
    `**Columns Updated**: ${result.updatedColumns}`,
    `**Cells Updated**: ${result.updatedCells}`,
  ].join('\n'));
}

export async function handleAppendSheetRows(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const { acc, client } = await resolveSheetsClient(rawArgs, ctx);
  const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
  const tab = valueToString(rawArgs.tab);
  const values = validateGrid(rawArgs.values);
  if (values.length === 0) throw new Error('values must have at least one row.');
  const valueInputOption = valueToString(rawArgs.value_input_option, 'USER_ENTERED') || 'USER_ENTERED';

  const result = await appendRows(client, acc.id, spreadsheetId, quoteTabName(tab), values, valueInputOption);

  return textResult([
    `✅ Appended ${result.updatedRows} row(s)${result.firstAppendedRow !== undefined ? `, starting at row ${result.firstAppendedRow}` : ''}.`,
    `**Account**: ${acc.id} (${acc.email})`,
    `**Updated Range**: ${result.updatedRange}`,
    `**Rows Appended**: ${result.updatedRows}`,
    `**Columns**: ${result.updatedColumns}`,
    `**Cells Written**: ${result.updatedCells}`,
    `**First Appended Row**: ${result.firstAppendedRow ?? '(Google reported no row number; see Updated Range)'}`,
  ].join('\n'));
}

export async function handleUpdateSheetRow(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const { acc, client } = await resolveSheetsClient(rawArgs, ctx);
  const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
  const tab = valueToString(rawArgs.tab);
  const row = valueToNumber(rawArgs.row, NaN);
  if (typeof rawArgs.values !== 'object' || rawArgs.values === null || Array.isArray(rawArgs.values)) {
    throw new Error('values must be an object of {header: value}, e.g. {"Status": "Interview"}.');
  }
  const values = rawArgs.values as Record<string, unknown>;
  const explicitHeaderRow = rawArgs.header_row !== undefined && rawArgs.header_row !== null
    ? valueToNumber(rawArgs.header_row, 1)
    : undefined;
  const valueInputOption = valueToString(rawArgs.value_input_option, 'USER_ENTERED') || 'USER_ENTERED';

  const result = await updateRow(client, acc.id, spreadsheetId, tab, row, values, explicitHeaderRow, valueInputOption);

  const lines: string[] = [
    `✅ Updated ${result.totalUpdatedCells} cell(s) in row ${row}.`,
    `**Account**: ${acc.id} (${acc.email})`,
    `**Header Row**: ${result.headerRow}${result.headerRowDetected ? ' (auto-detected)' : ''}`,
    `**Cells Updated**: ${result.totalUpdatedCells}`,
    '',
  ];
  for (const cell of result.cells) {
    lines.push(`**${cell.header}** (${cell.range}): ${cell.confirmed ? printCellValue(cell.value) : '(written; Google returned no value for this cell -- read it back to confirm)'}`);
  }
  return textResult(lines.join('\n'));
}

export async function handleAddSheetTab(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const { acc, client } = await resolveSheetsClient(rawArgs, ctx);
  const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
  const title = valueToString(rawArgs.title).trim();
  if (!title) throw new Error('title is required.');
  const headers = rawArgs.headers !== undefined ? valueToStringArray(rawArgs.headers) : undefined;
  const index = rawArgs.index !== undefined ? valueToNumber(rawArgs.index, 0) : undefined;

  const result = await addTab(client, acc.id, spreadsheetId, title, headers, index);

  const lines: string[] = [
    `✅ Tab "${result.title}" added.`,
    `**Account**: ${acc.id} (${acc.email})`,
    `**Sheet ID**: ${result.sheetId}`,
    `**Title**: ${result.title}`,
  ];
  if (result.index !== undefined) lines.push(`**Index**: ${result.index}`);
  if (result.headerUpdatedRange) lines.push(`**Header Row Written**: ${result.headerUpdatedRange}`);
  return textResult(lines.join('\n'));
}

export async function handleRenameSheetTab(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const { acc, client } = await resolveSheetsClient(rawArgs, ctx);
  const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
  const tab = valueToString(rawArgs.tab);
  const newTitle = valueToString(rawArgs.new_title).trim();
  if (!newTitle) throw new Error('new_title is required.');

  const result = await renameTab(client, acc.id, spreadsheetId, tab, newTitle);

  return textResult([
    `✅ Tab renamed from "${result.oldTitle}" to "${result.newTitle}"${result.confirmed ? ', confirmed' : ' -- but the new name was not found on read-back'}.`,
    `**Account**: ${acc.id} (${acc.email})`,
    `**Tabs Now**: ${result.tabs.map((t) => `"${t}"`).join(', ')}`,
  ].join('\n'));
}

export async function handleDeleteSheetTab(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const { acc, client } = await resolveSheetsClient(rawArgs, ctx);
  const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
  const tab = valueToString(rawArgs.tab);

  const result = await deleteTab(client, acc.id, spreadsheetId, tab);

  return textResult([
    `✅ Tab "${result.deleted}" deleted.`,
    `**Account**: ${acc.id} (${acc.email})`,
    `**Tabs Remaining**: ${result.remainingTabs.length ? result.remainingTabs.map((t) => `"${t}"`).join(', ') : '(none)'}`,
  ].join('\n'));
}

function parseDimensionArg(rawArgs: Record<string, unknown>): 'rows' | 'columns' {
  const dim = valueToString(rawArgs.dimension).trim();
  if (dim !== 'rows' && dim !== 'columns') throw new Error('dimension must be "rows" or "columns".');
  return dim;
}

/**
 * `before` / `start` are declared as strings in the schema ("9", "C"), but a
 * model that just read "row 9" will often pass the number 9. Both are
 * accepted; the live harness proved a number was refused on the first run.
 */
function positionArg(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return valueToString(value);
}

export async function handleInsertSheetDimension(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const { acc, client } = await resolveSheetsClient(rawArgs, ctx);
  const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
  const tab = valueToString(rawArgs.tab);
  const dimension = parseDimensionArg(rawArgs);
  const before = positionArg(rawArgs.before);
  const count = rawArgs.count !== undefined ? valueToNumber(rawArgs.count, 1) : 1;

  const result = await insertDimensionOnTab(client, acc.id, spreadsheetId, tab, dimension, before, count);

  const lines = [
    `✅ Inserted ${result.label} on "${tab}"; existing content shifted ${dimension === 'rows' ? 'down' : 'right'}.`,
    `**Account**: ${acc.id} (${acc.email})`,
  ];
  if (result.newRowCount !== undefined) lines.push(`**Tab Row Count Now**: ${result.newRowCount}`);
  if (result.newColumnCount !== undefined) lines.push(`**Tab Column Count Now**: ${result.newColumnCount}`);
  return textResult(lines.join('\n'));
}

export async function handleDeleteSheetDimension(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const { acc, client } = await resolveSheetsClient(rawArgs, ctx);
  const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
  const tab = valueToString(rawArgs.tab);
  const dimension = parseDimensionArg(rawArgs);
  const start = positionArg(rawArgs.start);
  const count = rawArgs.count !== undefined ? valueToNumber(rawArgs.count, 1) : 1;

  const result = await deleteDimensionOnTab(client, acc.id, spreadsheetId, tab, dimension, start, count);

  const lines = [
    `✅ Deleted ${result.label} on "${tab}"; remaining content shifted ${dimension === 'rows' ? 'up' : 'left'}.`,
    `**Account**: ${acc.id} (${acc.email})`,
  ];
  if (result.newRowCount !== undefined) lines.push(`**Tab Row Count Now**: ${result.newRowCount}`);
  if (result.newColumnCount !== undefined) lines.push(`**Tab Column Count Now**: ${result.newColumnCount}`);
  return textResult(lines.join('\n'));
}

export async function handleFormatSheetRange(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const { acc, client } = await resolveSheetsClient(rawArgs, ctx);
  const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
  const tab = valueToString(rawArgs.tab);
  const range = valueToString(rawArgs.range).trim();
  if (!range) throw new Error('range is required (a cell range within the tab, e.g. "A1:D1").');

  const result = await formatRange(client, acc.id, spreadsheetId, tab, range, {
    bold: rawArgs.bold !== undefined ? valueToBoolean(rawArgs.bold) : undefined,
    italic: rawArgs.italic !== undefined ? valueToBoolean(rawArgs.italic) : undefined,
    fontSize: rawArgs.font_size !== undefined ? valueToNumber(rawArgs.font_size, 0) : undefined,
    backgroundColor: valueToString(rawArgs.background_color, '').trim() || undefined,
    textColor: valueToString(rawArgs.text_color, '').trim() || undefined,
    horizontalAlignment: (valueToString(rawArgs.horizontal_alignment, '').trim() || undefined) as 'LEFT' | 'CENTER' | 'RIGHT' | undefined,
    numberFormat: valueToString(rawArgs.number_format, '').trim() || undefined,
    wrap: (valueToString(rawArgs.wrap, '').trim() || undefined) as 'OVERFLOW_CELL' | 'CLIP' | 'WRAP' | undefined,
  });

  return textResult([
    `✅ Formatting applied to ${result.range} on "${result.tab}". Appearance can only be confirmed by eye in Google Sheets.`,
    `**Account**: ${acc.id} (${acc.email})`,
    `**Applied**: ${result.applied.join(', ')}`,
  ].join('\n'));
}

export async function handleAddSheetChart(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const { acc, client } = await resolveSheetsClient(rawArgs, ctx);
  const spreadsheetId = valueToString(rawArgs.spreadsheet_id);
  const tab = valueToString(rawArgs.tab);
  const chartType = valueToString(rawArgs.chart_type) as 'BAR' | 'COLUMN' | 'LINE' | 'PIE' | 'AREA' | 'SCATTER';
  const dataRange = valueToString(rawArgs.data_range).trim();
  if (!dataRange) throw new Error('data_range is required.');

  const result = await addSheetChart(client, acc.id, spreadsheetId, tab, {
    chartType,
    dataRange,
    title: valueToString(rawArgs.title, '').trim() || undefined,
    anchorCell: valueToString(rawArgs.anchor_cell, '').trim() || undefined,
    widthPixels: rawArgs.width_pixels !== undefined ? valueToNumber(rawArgs.width_pixels, 600) : undefined,
    heightPixels: rawArgs.height_pixels !== undefined ? valueToNumber(rawArgs.height_pixels, 400) : undefined,
  });

  return textResult([
    `✅ Chart created on "${result.tab}", anchored at ${result.anchorCell}. Appearance can only be confirmed by eye in Google Sheets.`,
    `**Account**: ${acc.id} (${acc.email})`,
    `**Chart ID**: ${result.chartId}`,
  ].join('\n'));
}

export async function handleCreateSpreadsheet(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const { acc, client } = await resolveSheetsClient(rawArgs, ctx);
  const title = valueToString(rawArgs.title).trim();
  if (!title) throw new Error('title is required.');
  const folderId = valueToString(rawArgs.folder_id, '').trim() || undefined;

  const result = await createSpreadsheetInFolder(client, acc.id, title, folderId);

  const lines = [
    '✅ Spreadsheet created.',
    `**Account**: ${acc.id} (${acc.email})`,
    `**Spreadsheet ID**: ${result.id}`,
    `**URL**: ${result.url}`,
  ];
  if (result.parents) lines.push(`**Parents**: ${result.parents.join(', ')}`);
  return textResult(lines.join('\n'));
}

export const definitions: ToolDefinition[] = [
  getSpreadsheetTool,
  readSheetRangeTool,
  readSheetRecordsTool,
  findSheetRowsTool,
  getSheetDropdownTool,
  writeSheetRangeTool,
  appendSheetRowsTool,
  updateSheetRowTool,
  addSheetTabTool,
  renameSheetTabTool,
  deleteSheetTabTool,
  insertSheetDimensionTool,
  deleteSheetDimensionTool,
  formatSheetRangeTool,
  addSheetChartTool,
  createSpreadsheetTool,
];

export const handlers: Record<string, ToolHandler> = {
  get_spreadsheet: handleGetSpreadsheet,
  read_sheet_range: handleReadSheetRange,
  read_sheet_records: handleReadSheetRecords,
  find_sheet_rows: handleFindSheetRows,
  get_sheet_dropdown: handleGetSheetDropdown,
  write_sheet_range: handleWriteSheetRange,
  append_sheet_rows: handleAppendSheetRows,
  update_sheet_row: handleUpdateSheetRow,
  add_sheet_tab: handleAddSheetTab,
  rename_sheet_tab: handleRenameSheetTab,
  delete_sheet_tab: handleDeleteSheetTab,
  insert_sheet_dimension: handleInsertSheetDimension,
  delete_sheet_dimension: handleDeleteSheetDimension,
  format_sheet_range: handleFormatSheetRange,
  add_sheet_chart: handleAddSheetChart,
  create_spreadsheet: handleCreateSpreadsheet,
};

const sheetsModule: ToolModule = { definitions, handlers };
export default sheetsModule;
