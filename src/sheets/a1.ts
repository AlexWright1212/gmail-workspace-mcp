/**
 * A1-notation helpers for the Sheets tools (plan 002 Phase 3).
 *
 * The one rule that matters: a tab name goes into A1 notation single-quoted,
 * with any embedded single quote doubled -- `'Career Fair'!A1`,
 * `'Bob''s list'!A1`. The Sheets API accepts an unquoted name only when it
 * has no spaces or punctuation, and an agent forgets to quote roughly as
 * often as a tab has a space in it. So the TOOL quotes, always, and the model
 * never sees the rule. test/sheets-a1.test.mjs pins this.
 */

export function quoteTabName(tab: string): string {
  const name = tab.trim();
  if (!name) throw new Error('tab name is required.');
  return `'${name.replace(/'/g, "''")}'`;
}

/**
 * `tabRange('Career Fair')` -> `'Career Fair'` (the whole tab);
 * `tabRange('Career Fair', 'A2:D')` -> `'Career Fair'!A2:D`.
 * A `range` that already carries a `!` is refused: the tab is the tool's
 * to add, and "Sheet1!A1" inside a `range` argument meant for another tab is
 * exactly the ambiguity this helper exists to remove.
 */
export function tabRange(tab: string, range?: string): string {
  const quoted = quoteTabName(tab);
  const r = range?.trim();
  if (!r) return quoted;
  if (r.includes('!')) {
    throw new Error(`range "${r}" must not include a tab name -- pass the tab separately.`);
  }
  return `${quoted}!${r}`;
}

export function columnLetterToIndex(letters: string): number {
  const s = letters.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(s)) throw new Error(`"${letters}" is not a column letter.`);
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n; // 1-based
}

export function columnIndexToLetter(index: number): string {
  if (!Number.isInteger(index) || index < 1) throw new Error(`column index must be >= 1, got ${index}.`);
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export interface ParsedA1Range {
  tab?: string;
  /** 1-based; undefined when the range is column-only (`A:D`) or absent. */
  startRow?: number;
  endRow?: number;
  /** 1-based; undefined when the range is row-only (`2:10`). */
  startColumn?: number;
  endColumn?: number;
}

/**
 * Parses what the Sheets API hands back in `ValueRange.range`
 * (`'Career Fair'!A2:D10`, `Sheet1!A1:Z1000`, `Sheet1`), enough to know the
 * row number of the first returned row -- which is what read_sheet_range
 * prints beside each row so a follow-up write can target it.
 */
export function parseA1Range(a1: string): ParsedA1Range {
  const text = a1.trim();
  let tab: string | undefined;
  let cells = text;
  const bang = findTabSeparator(text);
  if (bang >= 0) {
    const rawTab = text.slice(0, bang);
    tab = rawTab.startsWith("'") && rawTab.endsWith("'") ? rawTab.slice(1, -1).replace(/''/g, "'") : rawTab;
    cells = text.slice(bang + 1);
  } else if (!/^[A-Z]*\d*(:[A-Z]*\d*)?$/i.test(text) || text === '') {
    // No "!" and not a bare cell range: the whole thing is a tab name.
    return { tab: text.replace(/^'(.*)'$/, '$1').replace(/''/g, "'") };
  }

  const [first, second] = cells.split(':');
  const a = parseCell(first);
  const b = second !== undefined ? parseCell(second) : a;
  return {
    tab,
    startRow: a.row,
    endRow: b.row,
    startColumn: a.column,
    endColumn: b.column,
  };
}

function findTabSeparator(text: string): number {
  if (text.startsWith("'")) {
    // Skip to the closing quote (doubled quotes are escapes), then expect "!".
    let i = 1;
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") { i += 2; continue; }
        return text[i + 1] === '!' ? i + 1 : -1;
      }
      i += 1;
    }
    return -1;
  }
  return text.indexOf('!');
}

function parseCell(cell: string): { row?: number; column?: number } {
  const m = /^([A-Z]*)(\d*)$/i.exec(cell.trim());
  if (!m) throw new Error(`"${cell}" is not an A1 cell reference.`);
  const [, letters, digits] = m;
  return {
    column: letters ? columnLetterToIndex(letters) : undefined,
    row: digits ? Number(digits) : undefined,
  };
}
