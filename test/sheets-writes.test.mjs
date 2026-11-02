// Plan 002 Phase 4 (unit A): pure helpers behind the Sheets write tools --
// the before/start -> 0-based index mapping, hex colour validation, grid
// validation, and the appended-row-number parser. No Google, no fake client;
// test/workspace-write-sheets.test.mjs drives the handlers end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dimensionStartIndex,
  dimensionLabel,
  isHexColor,
  isCellValue,
  validateGrid,
  hasAnyFormatField,
  appliedFormatFields,
  firstRowOf,
} from '../dist/sheets/writes.js';

test('dimensionStartIndex maps a 1-based row number to a 0-based startIndex, refusing < 1', () => {
  assert.equal(dimensionStartIndex('rows', '9'), 8);
  assert.equal(dimensionStartIndex('rows', '1'), 0);
  assert.throws(() => dimensionStartIndex('rows', '0'), /Row must be 1 or greater, got 0/);
  assert.throws(() => dimensionStartIndex('rows', '-3'), /positive whole number/);
  assert.throws(() => dimensionStartIndex('rows', 'C'), /positive whole number/);
  assert.throws(() => dimensionStartIndex('rows', ''), /row number is required/);
});

test('dimensionStartIndex maps a column letter or number to a 0-based startIndex, refusing < 1', () => {
  assert.equal(dimensionStartIndex('columns', 'C'), 2);
  assert.equal(dimensionStartIndex('columns', 'A'), 0);
  assert.equal(dimensionStartIndex('columns', '3'), 2);
  assert.throws(() => dimensionStartIndex('columns', '0'), /Column must be 1 or greater, got 0/);
  assert.throws(() => dimensionStartIndex('columns', '#$'), /letter .* or a positive number/);
  assert.throws(() => dimensionStartIndex('columns', ''), /column letter or number is required/);
});

test('dimensionLabel names an inserted/deleted range in sheet terms', () => {
  assert.equal(dimensionLabel('rows', 8, 2), 'rows 9–10');
  assert.equal(dimensionLabel('rows', 8, 1), 'row 9');
  assert.equal(dimensionLabel('columns', 2, 2), 'columns C–D');
  assert.equal(dimensionLabel('columns', 0, 1), 'column A');
});

test('isHexColor accepts only #RRGGBB', () => {
  assert.equal(isHexColor('#FF0000'), true);
  assert.equal(isHexColor('#ff00aa'), true);
  assert.equal(isHexColor(' #ABCDEF '), true);
  assert.equal(isHexColor('FF0000'), false);
  assert.equal(isHexColor('#FFF'), false);
  assert.equal(isHexColor('#GGGGGG'), false);
  assert.equal(isHexColor('red'), false);
});

test('isCellValue accepts string/number/boolean/null and rejects objects/arrays/undefined', () => {
  assert.equal(isCellValue('x'), true);
  assert.equal(isCellValue(1), true);
  assert.equal(isCellValue(true), true);
  assert.equal(isCellValue(null), true);
  assert.equal(isCellValue(undefined), false);
  assert.equal(isCellValue({}), false);
  assert.equal(isCellValue([]), false);
});

test('validateGrid accepts a well-formed 2D array and refuses anything else with the bad cell named', () => {
  assert.deepEqual(validateGrid([['a', 1, true, null]]), [['a', 1, true, null]]);
  assert.throws(() => validateGrid('not an array'), /values must be a 2D array/);
  assert.throws(() => validateGrid([1, 2]), /values\[0\] must be an array -- row 1/);
  assert.throws(() => validateGrid([['ok'], [{ nope: true }]]), /values\[1\]\[0\] must be a string, number, boolean, or null \(row 2, column 1\)/);
});

test('hasAnyFormatField / appliedFormatFields see through to which fields were actually given', () => {
  assert.equal(hasAnyFormatField({}), false);
  assert.equal(hasAnyFormatField({ bold: false }), true, 'false is a given value, not absence');
  assert.deepEqual(appliedFormatFields({}), []);
  assert.deepEqual(appliedFormatFields({ bold: true, backgroundColor: '#FFFFFF', numberFormat: '0.00' }), [
    'bold: true',
    'background: #FFFFFF',
    'number format: 0.00',
  ]);
});

test('firstRowOf parses the first sheet row number out of a Google updatedRange', () => {
  assert.equal(firstRowOf("'Career Fair'!A5:D6"), 5);
  assert.equal(firstRowOf('Sheet1!A2:B2'), 2);
  // A whole-tab reference with no cell part carries no row number to parse.
  // A whole-tab range names no row; the append already succeeded, so this must not throw.
  assert.equal(firstRowOf("'Career Fair'"), undefined);
  assert.equal(firstRowOf('not a range at all !!'), undefined);
});
