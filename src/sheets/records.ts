/**
 * Header-keyed reads and row lookup for the Sheets tools (plan 002 Phase 3).
 * Pure functions over the `values` grid that `spreadsheets.values.get`
 * returns, so they are unit-testable without Google. The design copies the
 * shape of mab-go/sheets-mcp's `sheets_lookup` and niberdi01gold's
 * `find_rows` (see the plan's "What we learned"): a column is addressed by
 * its header text, and every result carries the 1-based sheet row number so
 * a follow-up write can target exactly that row.
 */
import { columnIndexToLetter } from './a1.js';

export interface SheetRecord {
  /** 1-based row number in the sheet, as Google numbers it. */
  row: number;
  values: Record<string, string>;
}

export interface RecordsResult {
  headers: string[];
  headerRow: number;
  records: SheetRecord[];
  /** Data rows present but not returned because of `maxRows`. */
  omitted: number;
}

/**
 * Which row holds the headers when the caller did not say. Real trackers
 * put a title block above the table (the owner's has a title on row 2, a
 * totals block on rows 4-5, headers on row 7), so "row 1" is usually wrong.
 * Rule: within the first `scan` rows, the row with the most non-empty
 * cells; ties go to the earliest. A header names every column, so it is at
 * least as wide as any data row beneath it, and a title/totals block is
 * narrower. Returns 1-based; 0 when the grid is empty.
 */
export function detectHeaderRow(values: unknown[][], scan = 20): number {
  let best = 0;
  let bestCount = 0;
  const limit = Math.min(values.length, scan);
  for (let i = 0; i < limit; i += 1) {
    const count = (values[i] ?? []).filter((c) => cellText(c).trim() !== '').length;
    if (count > bestCount) { bestCount = count; best = i + 1; }
  }
  return best;
}

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  return String(cell);
}

/**
 * Headers are the header row's cells, trimmed. An empty header cell is named
 * by its column letter (`(column D)`); a duplicate gets ` (2)`, ` (3)`, so
 * every column is addressable and nothing is silently merged.
 */
export function buildHeaders(headerCells: unknown[]): string[] {
  const seen = new Map<string, number>();
  return headerCells.map((cell, i) => {
    let name = cellText(cell).trim() || `(column ${columnIndexToLetter(i + 1)})`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    return name;
  });
}

/**
 * `values` is the grid as returned for the WHOLE tab (row 1 first).
 * `headerRow` is 1-based. Rows before it are ignored; rows after it become
 * records. Entirely empty rows are skipped (Google omits trailing empty
 * rows but not interior ones). Cells beyond the header width are kept under
 * a column-letter name so data is never dropped without a name.
 */
export function buildRecords(
  values: unknown[][],
  headerRow = 1,
  maxRows = Number.POSITIVE_INFINITY,
): RecordsResult {
  if (!Number.isInteger(headerRow) || headerRow < 1) {
    throw new Error(`header_row must be a positive integer, got ${headerRow}.`);
  }
  const headerCells = values[headerRow - 1] ?? [];
  if (headerCells.every((c) => cellText(c).trim() === '')) {
    throw new Error(`Row ${headerRow} is empty -- it cannot be the header row.`);
  }
  const headers = buildHeaders(headerCells);

  const records: SheetRecord[] = [];
  let omitted = 0;
  for (let i = headerRow; i < values.length; i += 1) {
    const row = values[i] ?? [];
    if (row.every((c) => cellText(c).trim() === '')) continue;
    if (records.length >= maxRows) { omitted += 1; continue; }
    const rec: Record<string, string> = {};
    const width = Math.max(headers.length, row.length);
    for (let c = 0; c < width; c += 1) {
      const key = headers[c] ?? `(column ${columnIndexToLetter(c + 1)})`;
      rec[key] = cellText(row[c]);
    }
    records.push({ row: i + 1, values: rec });
  }
  return { headers, headerRow, records, omitted };
}

/**
 * Case-insensitive, whitespace-trimmed header match. Unknown -> throws with
 * the real headers listed, so the model can correct itself in one step.
 */
export function resolveColumn(headers: string[], column: string): string {
  const wanted = column.trim().toLowerCase();
  if (!wanted) throw new Error('column is required.');
  const hit = headers.find((h) => h.trim().toLowerCase() === wanted);
  if (!hit) {
    throw new Error(`No column named "${column}". Columns are: ${headers.map((h) => `"${h}"`).join(', ')}.`);
  }
  return hit;
}

export type MatchMode = 'exact' | 'contains';

export function findRows(
  records: SheetRecord[],
  column: string,
  value: string,
  match: MatchMode = 'exact',
): SheetRecord[] {
  const needle = value.trim().toLowerCase();
  return records.filter((rec) => {
    const cell = (rec.values[column] ?? '').trim().toLowerCase();
    return match === 'contains' ? (needle === '' ? cell === '' : cell.includes(needle)) : cell === needle;
  });
}
