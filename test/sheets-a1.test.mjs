// Plan 002 Phase 3: tab-name quoting and A1 parsing live in one helper so
// no tool (and no model) re-derives the rule. `'Career Fair'!A1` is the case
// the plan names.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteTabName,
  tabRange,
  parseA1Range,
  columnIndexToLetter,
  columnLetterToIndex,
} from '../dist/sheets/a1.js';

test('tab names are always single-quoted, with embedded quotes doubled', () => {
  assert.equal(quoteTabName('Career Fair'), "'Career Fair'");
  assert.equal(quoteTabName('Sheet1'), "'Sheet1'");
  assert.equal(quoteTabName("Bob's list"), "'Bob''s list'");
  assert.equal(quoteTabName('  padded  '), "'padded'");
  assert.throws(() => quoteTabName('   '), /tab name is required/);
});

test('tabRange joins a quoted tab and a cell range, and refuses a range that already names a tab', () => {
  assert.equal(tabRange('Career Fair'), "'Career Fair'");
  assert.equal(tabRange('Career Fair', 'A2:D'), "'Career Fair'!A2:D");
  assert.equal(tabRange('Sheet1', ' B2 '), "'Sheet1'!B2");
  assert.throws(() => tabRange('Sheet1', 'Other!A1'), /must not include a tab name/);
});

test('column letters round-trip', () => {
  assert.equal(columnIndexToLetter(1), 'A');
  assert.equal(columnIndexToLetter(26), 'Z');
  assert.equal(columnIndexToLetter(27), 'AA');
  assert.equal(columnIndexToLetter(702), 'ZZ');
  assert.equal(columnIndexToLetter(703), 'AAA');
  assert.equal(columnLetterToIndex('A'), 1);
  assert.equal(columnLetterToIndex('aa'), 27);
  assert.equal(columnLetterToIndex('AAA'), 703);
  assert.throws(() => columnLetterToIndex('A1'), /not a column letter/);
  assert.throws(() => columnIndexToLetter(0), /must be >= 1/);
});

test('parseA1Range reads what values.get returns, including quoted tabs and open-ended ranges', () => {
  assert.deepEqual(parseA1Range("'Career Fair'!A2:D10"), { tab: 'Career Fair', startRow: 2, endRow: 10, startColumn: 1, endColumn: 4 });
  assert.deepEqual(parseA1Range('Sheet1!A1:Z1000'), { tab: 'Sheet1', startRow: 1, endRow: 1000, startColumn: 1, endColumn: 26 });
  assert.deepEqual(parseA1Range("'Bob''s list'!B3"), { tab: "Bob's list", startRow: 3, endRow: 3, startColumn: 2, endColumn: 2 });
  assert.deepEqual(parseA1Range('Sheet1!B:B'), { tab: 'Sheet1', startRow: undefined, endRow: undefined, startColumn: 2, endColumn: 2 });
  assert.deepEqual(parseA1Range('Sheet1!2:5'), { tab: 'Sheet1', startRow: 2, endRow: 5, startColumn: undefined, endColumn: undefined });
  assert.deepEqual(parseA1Range("'Career Fair'"), { tab: 'Career Fair' });
  assert.deepEqual(parseA1Range('A1:C3'), { tab: undefined, startRow: 1, endRow: 3, startColumn: 1, endColumn: 3 });
});
