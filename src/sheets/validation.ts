/**
 * Reads a cell's data-validation ("dropdown") rule out of the grid data that
 * `spreadsheets.get` returns with a `fields` mask containing
 * `dataValidation` (plan 002 Phase 3, `get_sheet_dropdown`). Pure over the
 * API shape so it is unit-testable.
 *
 * Only reading. Editing a rule is out of scope (spec 002).
 */
import type { sheets_v4 } from 'googleapis';
import { columnIndexToLetter } from './a1.js';

export interface DropdownRule {
  /** A1 cells this exact rule applies to, in grid order. */
  cells: string[];
  /** `ONE_OF_LIST`, `ONE_OF_RANGE`, or whatever else Google reports. */
  conditionType: string;
  /** For ONE_OF_LIST: the allowed values, in order. For ONE_OF_RANGE: unresolved here. */
  values: string[];
  /** For ONE_OF_RANGE: the A1 range (as written, e.g. `=Lists!A1:A5`) the values come from. */
  sourceRange?: string;
  strict: boolean;
  showDropdown: boolean;
  inputMessage?: string;
}

export function extractDropdownRules(sheet: sheets_v4.Schema$Sheet): DropdownRule[] {
  const byKey = new Map<string, DropdownRule>();
  for (const grid of sheet.data ?? []) {
    const rowOffset = grid.startRow ?? 0;
    const colOffset = grid.startColumn ?? 0;
    (grid.rowData ?? []).forEach((row, r) => {
      (row.values ?? []).forEach((cell, c) => {
        const dv = cell.dataValidation;
        if (!dv?.condition) return;
        const key = JSON.stringify(dv);
        const a1 = `${columnIndexToLetter(colOffset + c + 1)}${rowOffset + r + 1}`;
        const existing = byKey.get(key);
        if (existing) { existing.cells.push(a1); return; }
        byKey.set(key, describeRule(dv, a1));
      });
    });
  }
  return [...byKey.values()];
}

function describeRule(dv: sheets_v4.Schema$DataValidationRule, firstCell: string): DropdownRule {
  const cond = dv.condition ?? {};
  const type = cond.type ?? 'UNKNOWN';
  const condValues = (cond.values ?? []).map((v) => v.userEnteredValue ?? '').filter((v) => v !== '');
  const rule: DropdownRule = {
    cells: [firstCell],
    conditionType: type,
    values: type === 'ONE_OF_LIST' ? condValues : [],
    strict: dv.strict ?? false,
    showDropdown: dv.showCustomUi ?? false,
    inputMessage: dv.inputMessage ?? undefined,
  };
  if (type === 'ONE_OF_RANGE') rule.sourceRange = condValues[0];
  return rule;
}

/**
 * `=Lists!A1:A5` / `='Career Fair'!B2:B` / `=$A$1:$A$5` -> the A1 string
 * `values.get` accepts. Only the leading `=` and `$` anchors are stripped.
 */
export function sourceRangeToA1(source: string): string {
  return source.trim().replace(/^=/, '').replace(/\$/g, '');
}
