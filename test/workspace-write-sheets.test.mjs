// Plan 002 Phase 4 (unit A): the Sheets WRITE tool handlers, driven with a
// fake GmailAccountClient -- same style as test/workspace-read-tools.test.mjs.
// Assertions are about (a) exactly what was sent to Google (quoted ranges,
// valueInputOption, insertDataOption, includeValuesInResponse, batchUpdate
// request bodies), (b) what the tool printed FROM THE FAKE RESPONSE (never
// echoed from the args), and (c) that a refusal happens before any fake
// Google call runs. The live harness (tools/live/workspace-check.mjs) is the
// only thing that can prove Google's own behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlers as sheets } from '../dist/tools/sheets.js';

const ACCOUNTS = [
  { id: 'personal', email: 'p@example.com', enabled: true },
  { id: 'tamu', email: 't@example.com', enabled: true },
];

function makeCtx(clientFor) {
  return {
    configRoot: '/nonexistent',
    loadConfig: async () => ({ accounts: ACCOUNTS }),
    getClientForAccount: async (account) => clientFor(account),
    isToolEnabled: () => true,
  };
}

const text = (result) => result.content[0].text;

// ─── write_sheet_range ───────────────────────────────────────────────────

test('write_sheet_range quotes the tab, writes the given range, and reports Google\'s response -- not the request', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    rawApis: () => ({
      sheets: {
        spreadsheets: {
          values: {
            update: async (params) => {
              calls.push(params);
              // Google reports fewer cells than requested (trailing empties trimmed) -- proves we print the response.
              return { data: { updatedRange: "'Career Fair'!B7:D8", updatedRows: 2, updatedColumns: 3, updatedCells: 5 } };
            },
          },
        },
      },
    }),
  }));
  const out = text(await sheets.write_sheet_range({
    account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', range: 'B7:D9',
    values: [['a', 'b', 'c'], ['d', 'e', 'f'], [null, 1, true]],
  }, ctx));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spreadsheetId, 'S');
  assert.equal(calls[0].range, "'Career Fair'!B7:D9");
  assert.equal(calls[0].valueInputOption, 'USER_ENTERED');
  assert.deepEqual(calls[0].requestBody.values, [['a', 'b', 'c'], ['d', 'e', 'f'], [null, 1, true]]);
  assert.match(out, /Wrote 5 cell\(s\) to 'Career Fair'!B7:D8/);
  assert.match(out, /\*\*Updated Range\*\*: 'Career Fair'!B7:D8/);
  assert.match(out, /\*\*Rows Updated\*\*: 2/);
  assert.match(out, /\*\*Columns Updated\*\*: 3/);
  assert.doesNotMatch(out, /B7:D9/, 'must never print the requested range as if it were confirmed');
});

test('write_sheet_range honours value_input_option and refuses a range carrying a tab name, before any call', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({ rawApis: () => ({ sheets: { spreadsheets: { values: { update: async (p) => { calls.push(p); return { data: {} }; } } } } }) }));
  await sheets.write_sheet_range({ account: 'personal', spreadsheet_id: 'S', tab: 'T', range: 'A1', values: [['x']], value_input_option: 'RAW' }, ctx);
  assert.equal(calls[0].valueInputOption, 'RAW');
  await assert.rejects(
    sheets.write_sheet_range({ account: 'personal', spreadsheet_id: 'S', tab: 'T', range: 'Other!A1', values: [['x']] }, ctx),
    /must not include a tab name/,
  );
  assert.equal(calls.length, 1, 'the refusal must not have called Google');
});

test('write_sheet_range refuses a non-2D or non-cell value before any call', async () => {
  const ctx = makeCtx(() => ({ rawApis: () => ({ sheets: { spreadsheets: { values: { update: async () => { throw new Error('must not be called'); } } } } }) }));
  await assert.rejects(sheets.write_sheet_range({ account: 'personal', spreadsheet_id: 'S', tab: 'T', range: 'A1', values: 'nope' }, ctx), /values must be a 2D array/);
  await assert.rejects(sheets.write_sheet_range({ account: 'personal', spreadsheet_id: 'S', tab: 'T', range: 'A1', values: [[{ x: 1 }]] }, ctx), /string, number, boolean, or null/);
});

// ─── append_sheet_rows ────────────────────────────────────────────────────

test('append_sheet_rows sends the whole quoted tab as the range with INSERT_ROWS, and reports the first appended row from Google\'s updatedRange', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    rawApis: () => ({
      sheets: {
        spreadsheets: {
          values: {
            append: async (params) => {
              calls.push(params);
              return { data: { updates: { updatedRange: "'Career Fair'!A16:D16", updatedRows: 1, updatedColumns: 4, updatedCells: 4 } } };
            },
          },
        },
      },
    }),
  }));
  const out = text(await sheets.append_sheet_rows({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', values: [['Acme', 'Analyst', 'Applied', 'https://x']] }, ctx));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].range, "'Career Fair'");
  assert.equal(calls[0].insertDataOption, 'INSERT_ROWS');
  assert.equal(calls[0].valueInputOption, 'USER_ENTERED');
  assert.match(out, /Appended 1 row\(s\), starting at row 16/);
  assert.match(out, /\*\*First Appended Row\*\*: 16/);
});

test('append_sheet_rows refuses an empty values array before any call', async () => {
  const ctx = makeCtx(() => ({ rawApis: () => ({ sheets: { spreadsheets: { values: { append: async () => { throw new Error('must not be called'); } } } } }) }));
  await assert.rejects(sheets.append_sheet_rows({ account: 'personal', spreadsheet_id: 'S', tab: 'T', values: [] }, ctx), /at least one row/);
});

// ─── update_sheet_row ─────────────────────────────────────────────────────

const TRACKER_GRID = [
  ['Company', 'Role', 'Status', 'Link'],
  ['Acme', 'Analyst', 'Applied', 'https://acme.example/1'],
  ['Globex', 'Intern', 'Applied', ''],
];

function trackerClient(calls) {
  return {
    readSheetValues: async (id, range, render) => {
      calls.push(['read', id, range, render]);
      return { range: "'Career Fair'!A1:D3", values: TRACKER_GRID };
    },
    rawApis: () => ({
      sheets: {
        spreadsheets: {
          values: {
            batchUpdate: async (params) => {
              calls.push(['batchUpdate', params]);
              // Google reformats the Status value on the way back -- proves we print the response, not the args.
              return {
                data: {
                  totalUpdatedCells: params.requestBody.data.length,
                  responses: params.requestBody.data.map((d) => ({
                    updatedRange: d.range,
                    updatedData: { range: d.range, values: [[`${d.values[0][0]} (confirmed)`]] },
                  })),
                },
              };
            },
          },
        },
      },
    }),
  };
}

test('update_sheet_row writes only the named cells in ONE batchUpdate with includeValuesInResponse, and prints what Google now holds', async () => {
  const calls = [];
  const ctx = makeCtx(() => trackerClient(calls));
  const out = text(await sheets.update_sheet_row({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', row: 3, values: { Status: 'Interview' } }, ctx));
  const batchCalls = calls.filter((c) => c[0] === 'batchUpdate');
  assert.equal(batchCalls.length, 1, 'exactly one values.batchUpdate');
  const body = batchCalls[0][1].requestBody;
  assert.equal(body.includeValuesInResponse, true);
  assert.equal(body.valueInputOption, 'USER_ENTERED');
  assert.deepEqual(body.data, [{ range: "'Career Fair'!C3", values: [['Interview']] }]);
  assert.match(out, /Updated 1 cell\(s\) in row 3/);
  assert.match(out, /\*\*Header Row\*\*: 1 \(auto-detected\)/);
  assert.match(out, /\*\*Status\*\* \('Career Fair'!C3\): Interview \(confirmed\)/);
});

test('update_sheet_row refuses an unrecognized header, listing the real headers, before any batchUpdate call', async () => {
  const calls = [];
  const ctx = makeCtx(() => trackerClient(calls));
  await assert.rejects(
    sheets.update_sheet_row({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', row: 3, values: { Salary: '100k' } }, ctx),
    /No column named "Salary"\. Columns are: "Company", "Role", "Status", "Link"/,
  );
  assert.equal(calls.filter((c) => c[0] === 'batchUpdate').length, 0, 'no fake batchUpdate must run on a refusal');
});

test('update_sheet_row refuses a row at or above the header row, before any batchUpdate call', async () => {
  const calls = [];
  const ctx = makeCtx(() => trackerClient(calls));
  await assert.rejects(
    sheets.update_sheet_row({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', row: 1, values: { Status: 'Interview' } }, ctx),
    /Row 1 is at or above the header row \(1\); nothing was written/,
  );
  assert.equal(calls.filter((c) => c[0] === 'batchUpdate').length, 0);
  await assert.rejects(
    sheets.update_sheet_row({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', row: 2, values: { Status: 'x' }, header_row: 2 }, ctx),
    /Row 2 is at or above the header row \(2\)/,
  );
});

test('update_sheet_row refuses a non-object values, and a non-cell value, before any batchUpdate call', async () => {
  const calls = [];
  const ctx = makeCtx(() => trackerClient(calls));
  await assert.rejects(sheets.update_sheet_row({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', row: 3, values: ['nope'] }, ctx), /values must be an object/);
  await assert.rejects(sheets.update_sheet_row({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', row: 3, values: { Status: { nope: 1 } } }, ctx), /string, number, boolean, or null/);
  assert.equal(calls.filter((c) => c[0] === 'batchUpdate').length, 0);
});

test('update_sheet_row respects an explicit header_row', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    readSheetValues: async () => ({ range: "'T'!A1:D4", values: [['title'], [], TRACKER_GRID[0], TRACKER_GRID[1]] }),
    rawApis: () => ({
      sheets: { spreadsheets: { values: { batchUpdate: async (p) => { calls.push(p); return { data: { totalUpdatedCells: 1, responses: [{ updatedRange: p.requestBody.data[0].range, updatedData: { values: [['Interview']] } }] } }; } } } },
    }),
  }));
  const out = text(await sheets.update_sheet_row({ account: 'personal', spreadsheet_id: 'S', tab: 'T', row: 4, values: { Status: 'Interview' }, header_row: 3 }, ctx));
  assert.match(out, /\*\*Header Row\*\*: 3\n/);
  assert.doesNotMatch(out, /auto-detected/);
});

// ─── add_sheet_tab ─────────────────────────────────────────────────────────

test('add_sheet_tab reuses addSheetTab, reads the new index back, and writes headers into row 1 when given', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    addSheetTab: async (id, title, index) => { calls.push(['add', id, title, index]); return { sheetId: 42, title }; },
    getSheetsMetadata: async () => ({ id: 'S', title: 'T', url: 'u', sheets: [{ sheetId: 42, title: 'Career Fair', index: 3, rowCount: 1, columnCount: 3 }] }),
    rawApis: () => ({
      sheets: { spreadsheets: { values: { update: async (p) => { calls.push(['header', p]); return { data: { updatedRange: "'Career Fair'!A1:C1" } }; } } } },
    }),
  }));
  const out = text(await sheets.add_sheet_tab({ account: 'personal', spreadsheet_id: 'S', title: 'Career Fair', headers: ['Company', 'Role', 'Status'] }, ctx));
  assert.deepEqual(calls[0], ['add', 'S', 'Career Fair', undefined]);
  assert.equal(calls[1][1].range, "'Career Fair'!A1");
  assert.deepEqual(calls[1][1].requestBody.values, [['Company', 'Role', 'Status']]);
  assert.match(out, /Tab "Career Fair" added/);
  assert.match(out, /\*\*Sheet ID\*\*: 42/);
  assert.match(out, /\*\*Index\*\*: 3/);
  assert.match(out, /\*\*Header Row Written\*\*: 'Career Fair'!A1:C1/);
});

test('add_sheet_tab without headers never calls values.update', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    addSheetTab: async (id, title) => ({ sheetId: 1, title }),
    getSheetsMetadata: async () => ({ id: 'S', title: 'T', url: 'u', sheets: [{ sheetId: 1, title: 'X', index: 0, rowCount: 1, columnCount: 1 }] }),
    rawApis: () => ({ sheets: { spreadsheets: { values: { update: async (p) => { calls.push(p); throw new Error('must not be called'); } } } } }),
  }));
  await sheets.add_sheet_tab({ account: 'personal', spreadsheet_id: 'S', title: 'X' }, ctx);
  assert.equal(calls.length, 0);
});

// ─── rename_sheet_tab / delete_sheet_tab ───────────────────────────────────

test('rename_sheet_tab refuses an unknown tab, listing the real tabs, before calling renameSheetTab', async () => {
  const renameCalls = [];
  const ctx = makeCtx(() => ({
    getSheetsMetadata: async () => ({ id: 'S', title: 'T', url: 'u', sheets: [{ sheetId: 0, title: 'Career Fair', index: 0, rowCount: 1, columnCount: 1 }, { sheetId: 1, title: 'Contacts', index: 1, rowCount: 1, columnCount: 1 }] }),
    renameSheetTab: async (...args) => { renameCalls.push(args); },
  }));
  await assert.rejects(
    sheets.rename_sheet_tab({ account: 'personal', spreadsheet_id: 'S', tab: 'Nope', new_title: 'X' }, ctx),
    /No tab named "Nope"\. Tabs are: "Career Fair", "Contacts"/,
  );
  assert.equal(renameCalls.length, 0, 'must not call renameSheetTab on a refusal');
});

test('rename_sheet_tab renames and confirms the new title by reading the spreadsheet back', async () => {
  let stage = 0;
  const renameCalls = [];
  const ctx = makeCtx(() => ({
    getSheetsMetadata: async () => {
      stage += 1;
      const title = stage === 1 ? 'Career Fair' : 'Fall Career Fair';
      return { id: 'S', title: 'T', url: 'u', sheets: [{ sheetId: 0, title, index: 0, rowCount: 1, columnCount: 1 }] };
    },
    renameSheetTab: async (...args) => { renameCalls.push(args); },
  }));
  const out = text(await sheets.rename_sheet_tab({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', new_title: 'Fall Career Fair' }, ctx));
  assert.deepEqual(renameCalls[0], ['S', 'Career Fair', 'Fall Career Fair']);
  assert.match(out, /renamed from "Career Fair" to "Fall Career Fair", confirmed/);
  assert.match(out, /\*\*Tabs Now\*\*: "Fall Career Fair"/);
});

test('delete_sheet_tab refuses an unknown tab, listing the real tabs, before calling deleteSheetTab', async () => {
  const deleteCalls = [];
  const ctx = makeCtx(() => ({
    getSheetsMetadata: async () => ({ id: 'S', title: 'T', url: 'u', sheets: [{ sheetId: 0, title: 'Career Fair', index: 0, rowCount: 1, columnCount: 1 }, { sheetId: 1, title: 'Contacts', index: 1, rowCount: 1, columnCount: 1 }] }),
    deleteSheetTab: async (...args) => { deleteCalls.push(args); },
  }));
  await assert.rejects(sheets.delete_sheet_tab({ account: 'personal', spreadsheet_id: 'S', tab: 'Nope' }, ctx), /No tab named "Nope"\. Tabs are: "Career Fair", "Contacts"/);
  assert.equal(deleteCalls.length, 0, 'must not call deleteSheetTab on a refusal');
});

test('delete_sheet_tab deletes the named tab and reports the remaining tabs, read back afterward', async () => {
  const deleteCalls = [];
  let stage = 0;
  const ctx = makeCtx(() => ({
    getSheetsMetadata: async () => {
      stage += 1;
      const sheetsList = stage === 1
        ? [{ sheetId: 0, title: 'Career Fair', index: 0, rowCount: 1, columnCount: 1 }, { sheetId: 1, title: 'Contacts', index: 1, rowCount: 1, columnCount: 1 }]
        : [{ sheetId: 1, title: 'Contacts', index: 0, rowCount: 1, columnCount: 1 }];
      return { id: 'S', title: 'T', url: 'u', sheets: sheetsList };
    },
    deleteSheetTab: async (...args) => { deleteCalls.push(args); },
  }));
  const out = text(await sheets.delete_sheet_tab({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair' }, ctx));
  assert.deepEqual(deleteCalls[0], ['S', 'Career Fair']);
  assert.match(out, /Tab "Career Fair" deleted/);
  assert.match(out, /\*\*Tabs Remaining\*\*: "Contacts"/);
});

// ─── insert_sheet_dimension / delete_sheet_dimension ───────────────────────

test('insert_sheet_dimension maps "before" to a 0-based startIndex (row 9 -> 8; column C -> 2) and reports the new count', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    insertDimension: async (id, tab, dim, startIndex, count) => { calls.push(['insert', id, tab, dim, startIndex, count]); },
    getSheetsMetadata: async () => ({ id: 'S', title: 'T', url: 'u', sheets: [{ sheetId: 0, title: 'Career Fair', index: 0, rowCount: 12, columnCount: 5 }] }),
  }));
  const rowOut = text(await sheets.insert_sheet_dimension({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', dimension: 'rows', before: '9' }, ctx));
  assert.deepEqual(calls[0], ['insert', 'S', 'Career Fair', 'ROWS', 8, 1]);
  assert.match(rowOut, /Inserted row 9 on "Career Fair"; existing content shifted down/);
  assert.match(rowOut, /\*\*Tab Row Count Now\*\*: 12/);

  calls.length = 0;
  await sheets.insert_sheet_dimension({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', dimension: 'columns', before: 'C', count: 2 }, ctx);
  assert.deepEqual(calls[0], ['insert', 'S', 'Career Fair', 'COLUMNS', 2, 2]);
});

test('insert_sheet_dimension refuses before < 1 and count < 1 before any call', async () => {
  const ctx = makeCtx(() => ({ insertDimension: async () => { throw new Error('must not be called'); } }));
  await assert.rejects(sheets.insert_sheet_dimension({ account: 'personal', spreadsheet_id: 'S', tab: 'T', dimension: 'rows', before: '0' }, ctx), /Row must be 1 or greater/);
  await assert.rejects(sheets.insert_sheet_dimension({ account: 'personal', spreadsheet_id: 'S', tab: 'T', dimension: 'rows', before: '5', count: 0 }, ctx), /count must be a positive whole number/);
});

test('delete_sheet_dimension maps "start" the same way and is destructive', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    deleteDimension: async (id, tab, dim, startIndex, count) => { calls.push(['delete', id, tab, dim, startIndex, count]); },
    getSheetsMetadata: async () => ({ id: 'S', title: 'T', url: 'u', sheets: [{ sheetId: 0, title: 'Career Fair', index: 0, rowCount: 10, columnCount: 5 }] }),
  }));
  const out = text(await sheets.delete_sheet_dimension({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', dimension: 'rows', start: '9', count: 2 }, ctx));
  assert.deepEqual(calls[0], ['delete', 'S', 'Career Fair', 'ROWS', 8, 2]);
  assert.match(out, /Deleted rows 9–10 on "Career Fair"; remaining content shifted up/);
  assert.match(out, /\*\*Tab Row Count Now\*\*: 10/);
});

// ─── format_sheet_range ─────────────────────────────────────────────────────

test('format_sheet_range refuses with no formatting field, and an invalid hex color, before calling formatCells', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({ formatCells: async (...args) => { calls.push(args); } }));
  await assert.rejects(sheets.format_sheet_range({ account: 'personal', spreadsheet_id: 'S', tab: 'T', range: 'A1:D1' }, ctx), /At least one formatting field is required/);
  await assert.rejects(sheets.format_sheet_range({ account: 'personal', spreadsheet_id: 'S', tab: 'T', range: 'A1:D1', background_color: 'red' }, ctx), /background_color must be a hex color/);
  assert.equal(calls.length, 0);
});

test('format_sheet_range applies the given fields (wrap -> wrapStrategy) and reports which were applied', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({ formatCells: async (...args) => { calls.push(args); } }));
  const out = text(await sheets.format_sheet_range({
    account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', range: 'A1:D1', bold: true, background_color: '#FFDD00', wrap: 'WRAP',
  }, ctx));
  const [id, tab, range, fmt] = calls[0];
  assert.equal(id, 'S'); assert.equal(tab, 'Career Fair'); assert.equal(range, 'A1:D1');
  assert.equal(fmt.bold, true);
  assert.equal(fmt.backgroundColor, '#FFDD00');
  assert.equal(fmt.wrapStrategy, 'WRAP');
  assert.match(out, /Formatting applied to A1:D1 on "Career Fair"/);
  assert.match(out, /\*\*Applied\*\*: bold: true, background: #FFDD00, wrap: WRAP/);
});

// ─── add_sheet_chart ─────────────────────────────────────────────────────────

test('add_sheet_chart defaults the anchor to A1 (row 0, col 0) and converts a given anchor cell', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({ addChart: async (id, tab, opts) => { calls.push([id, tab, opts]); return { chartId: 7 }; } }));
  const out = text(await sheets.add_sheet_chart({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', chart_type: 'COLUMN', data_range: 'A1:B10' }, ctx));
  assert.equal(calls[0][2].anchorRow, 0);
  assert.equal(calls[0][2].anchorCol, 0);
  assert.match(out, /Chart created on "Career Fair", anchored at A1/);
  assert.match(out, /\*\*Chart ID\*\*: 7/);

  await sheets.add_sheet_chart({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', chart_type: 'PIE', data_range: 'A1:B10', anchor_cell: 'C5' }, ctx);
  assert.equal(calls[1][2].anchorRow, 4);
  assert.equal(calls[1][2].anchorCol, 2);
});

// ─── create_spreadsheet ───────────────────────────────────────────────────

test('create_spreadsheet without a folder never touches Drive', async () => {
  const ctx = makeCtx(() => ({
    createSpreadsheet: async (title) => ({ id: 'NEW1', url: `https://docs.google.com/spreadsheets/d/NEW1` }),
    rawApis: () => ({ drive: { files: { get: async () => { throw new Error('must not be called'); }, update: async () => { throw new Error('must not be called'); } } } }),
  }));
  const out = text(await sheets.create_spreadsheet({ account: 'personal', title: 'Contacts' }, ctx));
  assert.match(out, /\*\*Spreadsheet ID\*\*: NEW1/);
  assert.doesNotMatch(out, /Parents/);
});

test('create_spreadsheet with a folder_id moves the new file via Drive files.update, reading current parents first', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    createSpreadsheet: async () => ({ id: 'NEW1', url: 'https://docs.google.com/spreadsheets/d/NEW1' }),
    rawApis: () => ({
      drive: {
        files: {
          get: async (params) => { calls.push(['get', params]); return { data: { parents: ['ROOT'] } }; },
          update: async (params) => { calls.push(['update', params]); return { data: { parents: ['FOLDER1'] } }; },
        },
      },
    }),
  }));
  const out = text(await sheets.create_spreadsheet({ account: 'personal', title: 'Contacts', folder_id: 'FOLDER1' }, ctx));
  assert.deepEqual(calls[0], ['get', { fileId: 'NEW1', fields: 'parents' }]);
  assert.deepEqual(calls[1], ['update', { fileId: 'NEW1', addParents: 'FOLDER1', removeParents: 'ROOT', fields: 'parents' }]);
  assert.match(out, /\*\*Parents\*\*: FOLDER1/);
});

test('update_sheet_row never echoes the requested value when Google\'s response carries no updatedData for a cell (adversarial review, 2026-09-19)', async () => {
  const calls = [];
  const thin = trackerClient(calls);
  thin.rawApis = () => ({
    sheets: { spreadsheets: { values: { batchUpdate: async (params) => {
      calls.push(['batchUpdate', params]);
      return { data: { totalUpdatedCells: 1, responses: params.requestBody.data.map((d) => ({ updatedRange: d.range, updatedData: {} })) } };
    } } } },
  });
  const out = text(await sheets.update_sheet_row({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', row: 3, values: { Status: 'Rejected' } }, makeCtx(() => thin)));
  assert.match(out, /\*\*Status\*\* \('Career Fair'!C3\): \(written; Google returned no value for this cell -- read it back to confirm\)/);
  assert.ok(!/Rejected/.test(out), 'the caller\'s value must not be printed as if Google confirmed it');
});

test('append_sheet_rows still reports success when Google\'s updatedRange names no row', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    rawApis: () => ({ sheets: { spreadsheets: { values: { append: async (p) => { calls.push(p); return { data: { updates: { updatedRange: "'Career Fair'", updatedRows: 1, updatedColumns: 2, updatedCells: 2 } } }; } } } } }),
  }));
  const out = text(await sheets.append_sheet_rows({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', values: [['a', 'b']] }, ctx));
  assert.equal(calls.length, 1);
  assert.match(out, /✅ Appended 1 row\(s\)\./);
  assert.match(out, /\*\*First Appended Row\*\*: \(Google reported no row number; see Updated Range\)/);
});

test('insert/delete_sheet_dimension accept a numeric before/start as well as the string form (live harness, 2026-09-19)', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    insertDimension: async (...a) => { calls.push(['insert', ...a]); },
    deleteDimension: async (...a) => { calls.push(['delete', ...a]); },
    getSheetsMetadata: async () => ({ id: 'S', title: 'T', url: '', sheets: [{ sheetId: 1, title: 'Career Fair', index: 0, rowCount: 100, columnCount: 10 }] }),
  }));
  await sheets.insert_sheet_dimension({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', dimension: 'rows', before: 9 }, ctx);
  await sheets.delete_sheet_dimension({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', dimension: 'columns', start: 3 }, ctx);
  assert.deepEqual(calls.map((c) => [c[0], c[3], c[4], c[5]]), [['insert', 'ROWS', 8, 1], ['delete', 'COLUMNS', 2, 1]]);
});
