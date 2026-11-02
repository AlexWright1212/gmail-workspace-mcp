// Plan 002 Phase 3: header-keyed records, row lookup, and dropdown-rule
// extraction -- the pure parts of read_sheet_records / find_sheet_rows /
// get_sheet_dropdown, run against grids shaped like the Sheets API's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHeaders, buildRecords, detectHeaderRow, resolveColumn, findRows } from '../dist/sheets/records.js';
import { extractDropdownRules, sourceRangeToA1 } from '../dist/sheets/validation.js';

const GRID = [
  ['Company', 'Role', 'Status', 'Link'],
  ['Acme', 'Analyst', 'Applied', 'https://acme.example/jobs/1'],
  ['', '', '', ''],
  ['Globex', 'Intern', 'Interview', ''],
  ['acme ', 'Trader'],
];

test('buildHeaders names empty and duplicate headers so every column is addressable', () => {
  assert.deepEqual(buildHeaders(['Company', '', 'Status', 'Status', 'Notes']), [
    'Company', '(column B)', 'Status', 'Status (2)', 'Notes',
  ]);
});

test('buildRecords keys rows by header, keeps sheet row numbers, skips empty rows, pads short rows', () => {
  const r = buildRecords(GRID, 1);
  assert.deepEqual(r.headers, ['Company', 'Role', 'Status', 'Link']);
  assert.equal(r.headerRow, 1);
  assert.equal(r.omitted, 0);
  assert.deepEqual(r.records.map((x) => x.row), [2, 4, 5]);
  assert.deepEqual(r.records[0].values, { Company: 'Acme', Role: 'Analyst', Status: 'Applied', Link: 'https://acme.example/jobs/1' });
  assert.deepEqual(r.records[2].values, { Company: 'acme ', Role: 'Trader', Status: '', Link: '' });
});

test('buildRecords honours header_row and reports omitted rows instead of dropping them silently', () => {
  const grid = [['title row'], ...GRID];
  const r = buildRecords(grid, 2, 1);
  assert.deepEqual(r.headers, ['Company', 'Role', 'Status', 'Link']);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].row, 3);
  assert.equal(r.omitted, 2);
});

test('buildRecords keeps cells wider than the header row under a column-letter name', () => {
  const r = buildRecords([['A', 'B'], ['1', '2', '3']], 1);
  assert.deepEqual(r.records[0].values, { A: '1', B: '2', '(column C)': '3' });
});

test('buildRecords refuses an empty header row and a bad header_row', () => {
  assert.throws(() => buildRecords([[], ['x']], 1), /cannot be the header row/);
  assert.throws(() => buildRecords(GRID, 0), /positive integer/);
});

test('resolveColumn matches case-insensitively and lists real headers on a miss', () => {
  const headers = ['Company', 'Role'];
  assert.equal(resolveColumn(headers, 'company'), 'Company');
  assert.equal(resolveColumn(headers, ' ROLE '), 'Role');
  assert.throws(() => resolveColumn(headers, 'Status'), /No column named "Status"\. Columns are: "Company", "Role"/);
});

test('findRows exact ignores case and padding; contains matches substrings; no match is an empty list', () => {
  const { records } = buildRecords(GRID, 1);
  assert.deepEqual(findRows(records, 'Company', 'ACME').map((r) => r.row), [2, 5]);
  assert.deepEqual(findRows(records, 'Company', 'glob', 'contains').map((r) => r.row), [4]);
  assert.deepEqual(findRows(records, 'Company', 'glob', 'exact'), []);
  assert.deepEqual(findRows(records, 'Status', 'Applied').map((r) => r.row), [2]);
});

test('extractDropdownRules groups identical rules, names cells from the grid offset, lists ONE_OF_LIST values', () => {
  const sheet = {
    properties: { title: 'Tracker' },
    data: [{
      startRow: 1, startColumn: 2, // grid starts at C2
      rowData: [
        { values: [{ dataValidation: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Applied' }, { userEnteredValue: 'Interview' }] }, strict: true, showCustomUi: true } }] },
        { values: [{ dataValidation: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Applied' }, { userEnteredValue: 'Interview' }] }, strict: true, showCustomUi: true } }] },
        { values: [{}] },
        { values: [{ dataValidation: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: '=Lists!$A$1:$A$5' }] }, strict: false } }] },
      ],
    }],
  };
  const rules = extractDropdownRules(sheet);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].cells, ['C2', 'C3']);
  assert.equal(rules[0].conditionType, 'ONE_OF_LIST');
  assert.deepEqual(rules[0].values, ['Applied', 'Interview']);
  assert.equal(rules[0].strict, true);
  assert.equal(rules[0].showDropdown, true);
  assert.deepEqual(rules[1].cells, ['C5']);
  assert.equal(rules[1].conditionType, 'ONE_OF_RANGE');
  assert.equal(rules[1].sourceRange, '=Lists!$A$1:$A$5');
  assert.equal(rules[1].strict, false);
  assert.equal(sourceRangeToA1(rules[1].sourceRange), 'Lists!A1:A5');
});

test('extractDropdownRules returns nothing for a range with no rules', () => {
  assert.deepEqual(extractDropdownRules({ data: [{ rowData: [{ values: [{}, {}] }] }] }), []);
  assert.deepEqual(extractDropdownRules({}), []);
});

test('detectHeaderRow picks the widest row near the top, so a title block above the table is skipped', () => {
  const tracker = [
    [],
    ['', 'Internship Application Tracker'],
    [],
    ['', 'Total Applications', '', 'Interviewing', '', '', 'Accepted'],
    ['', '14', '', '0', '', '', '0'],
    [],
    ['', 'Company', 'Position Title', 'Date Applied', 'Status', 'Priority', 'Networking', 'General Notes', 'Pay', 'Link'],
    ['', 'Microsoft', 'Supply Chain PM', '', 'Not Applied', 'Medium', 'Varun referral', 'bad role', '', 'https://x'],
    ['', 'Acme', 'Analyst', '2026-09-01', 'Applied', 'High', '', '', '', ''],
  ];
  assert.equal(detectHeaderRow(tracker), 7);
  assert.equal(detectHeaderRow(GRID), 1);
  assert.equal(detectHeaderRow([['a', 'b'], ['1', '2', '3', '4']]), 2, 'a data row wider than the header wins -- the caller can override');
  assert.equal(detectHeaderRow([]), 0);
  assert.equal(detectHeaderRow([[], ['']]), 0);
});
