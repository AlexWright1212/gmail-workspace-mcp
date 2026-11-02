// Plan 002 Phase 3: the Workspace READ tool handlers, driven with a fake
// GmailAccountClient so the assertions are about what the handler asks
// Google for and how it reports the answer -- never about Google itself
// (the live harness, tools/live/workspace-check.mjs, covers that).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlers as drive } from '../dist/tools/drive.js';
import { handlers as sheets } from '../dist/tools/sheets.js';
import { handlers as docs } from '../dist/tools/docs.js';
import { handlers as calendar } from '../dist/tools/calendar.js';
import { buildDriveSearchQuery, describeGoogleApiError, GmailAccountClient } from '../dist/gmail-client.js';
import { MAX_READ_BYTES } from '../dist/tools/drive.js';
import { formatEventTime } from '../dist/tools/shared.js';

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

// ─── Drive ─────────────────────────────────────────────────────────────────

test('buildDriveSearchQuery adds a mimeType clause for a type and none for any', () => {
  assert.equal(
    buildDriveSearchQuery('internship', 'spreadsheet'),
    "trashed = false and (name contains 'internship' or fullText contains 'internship') and mimeType = 'application/vnd.google-apps.spreadsheet'",
  );
  assert.equal(buildDriveSearchQuery('x', 'any'), buildDriveSearchQuery('x'));
  assert.equal(buildDriveSearchQuery('x', 'folder'), "trashed = false and (name contains 'x' or fullText contains 'x') and mimeType = 'application/vnd.google-apps.folder'");
  assert.throws(() => buildDriveSearchQuery('x', 'video'), /Unknown type "video"/);
});

test('search_drive_files queries both accounts by default, passes the type through, names each account, and reports one failing account without hiding the other', async () => {
  const calls = [];
  const ctx = makeCtx((account) => ({
    searchDriveFiles: async (query, max, type) => {
      calls.push([account.id, query, max, type]);
      if (account.id === 'tamu') throw new Error('Google authorization for account "tamu" has lapsed (invalid_grant).');
      return [{ id: 'f1', name: 'Internship Copy', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-09-01T00:00:00Z', owners: ['me'], accountId: account.id, accountEmail: account.email }];
    },
  }));
  const out = text(await drive.search_drive_files({ query: 'internship', type: 'spreadsheet' }, ctx));
  assert.deepEqual(calls.map((c) => c[0]).sort(), ['personal', 'tamu']);
  assert.equal(calls[0][3], 'spreadsheet');
  assert.match(out, /Internship Copy/);
  assert.match(out, /\*\*Account\*\*: personal \(p@example\.com\)/);
  // The failure leads, as an INCOMPLETE banner, before any result -- same
  // shape as the mail endpoint (ADR 011). The Phase 5 B2 run found the old
  // trailing "## Account Errors" section easy to miss.
  assert.match(out, /^# Google Drive Search Results\n\n> ⚠️ \*\*Some accounts failed — these results are INCOMPLETE\.\*\*\n> - tamu: Google authorization for account "tamu" has lapsed/);
  assert.doesNotMatch(out, /## Account Errors/);
  assert.match(out, /type: spreadsheet/);
});

test('search_drive_files refuses an unknown type before calling Google', async () => {
  const ctx = makeCtx(() => ({ searchDriveFiles: async () => { throw new Error('should not be called'); } }));
  await assert.rejects(drive.search_drive_files({ query: 'x', type: 'video' }, ctx), /Unknown type "video"/);
});

test('list_drive_folder requires an account and a folder id and lists only that folder', async () => {
  const calls = [];
  const ctx = makeCtx((account) => ({
    listDriveFiles: async (opts) => { calls.push([account.id, opts]); return { files: [], nextPageToken: 'tok' }; },
  }));
  await assert.rejects(drive.list_drive_folder({ folder_id: 'F' }, ctx), /requires an explicit "account"/);
  await assert.rejects(drive.list_drive_folder({ account: 'personal' }, ctx), /folder_id is required/);
  const out = text(await drive.list_drive_folder({ account: 'personal', folder_id: 'F' }, ctx));
  assert.deepEqual(calls, [['personal', { folderId: 'F', maxResults: 50, pageToken: undefined }]]);
  assert.match(out, /Next page token: tok/);
});

function fakeDoc() {
  const p = (t, extra = {}) => ({ paragraph: { elements: [{ textRun: { content: t + '\n' } }], ...extra } });
  return {
    documentId: 'D1', title: 'Musings',
    tabs: [
      { tabProperties: { tabId: 't.0', title: 'One' }, documentTab: { body: { content: [p('First tab.')] } } },
      { tabProperties: { tabId: 't.1', title: 'Two' }, documentTab: { body: { content: [p('Second', { paragraphStyle: { namedStyleType: 'HEADING_2' } }), p('item', { bullet: { listId: 'l' } })] } } },
    ],
  };
}

test('read_drive_file routes a Google Doc through the tab-aware reader (every tab, with ids)', async () => {
  const ctx = makeCtx(() => ({
    getDriveFile: async (id) => ({ id, name: 'Musings', mimeType: 'application/vnd.google-apps.document', owners: [], accountId: 'personal', accountEmail: 'p@example.com', webViewLink: 'https://docs.google.com/x' }),
    getDocumentWithTabs: async () => fakeDoc(),
    getDriveFileContent: async () => { throw new Error('must not download a Google Doc'); },
  }));
  const out = text(await drive.read_drive_file({ account: 'personal', file_id: 'D1' }, ctx));
  assert.match(out, /\*\*Tabs\*\* \(2\)/);
  assert.match(out, /\*\*Tab: One\*\* \(tab_id: t\.0\)/);
  assert.match(out, /\*\*Tab: Two\*\* \(tab_id: t\.1\)/);
  assert.match(out, /## Second/);
  assert.match(out, /^- item$/m);
  assert.match(out, /First tab\./);
});

test('read_drive_file on a Google Sheet returns the tab list and points at the Sheets tools', async () => {
  const ctx = makeCtx(() => ({
    getDriveFile: async (id) => ({ id, name: 'Tracker', mimeType: 'application/vnd.google-apps.spreadsheet', owners: [], accountId: 'personal', accountEmail: 'p@example.com' }),
    getSheetsMetadata: async () => ({ id: 'S1', title: 'Tracker', url: 'u', sheets: [{ sheetId: 0, title: 'Apps', index: 0, rowCount: 10, columnCount: 4 }] }),
    getDriveFileContent: async () => { throw new Error('must not export a Sheet'); },
  }));
  const out = text(await drive.read_drive_file({ account: 'personal', file_id: 'S1' }, ctx));
  assert.match(out, /This is a Google Sheet/);
  assert.match(out, /read_sheet_records/);
  assert.match(out, /"Apps" — 10 rows × 4 cols/);
});

test('read_drive_file on a folder or shortcut describes it instead of downloading', async () => {
  const ctx = makeCtx(() => ({
    getDriveFile: async (id) => ({ id, name: 'X', mimeType: id === 'F' ? 'application/vnd.google-apps.folder' : 'application/vnd.google-apps.shortcut', owners: [], accountId: 'personal', accountEmail: 'p@example.com' }),
    getDriveFileContent: async () => { throw new Error('must not download'); },
  }));
  assert.match(text(await drive.read_drive_file({ account: 'personal', file_id: 'F' }, ctx)), /This is a folder. Use list_drive_folder/);
  assert.match(text(await drive.read_drive_file({ account: 'personal', file_id: 'SC' }, ctx)), /Drive shortcut/);
});

test('read_drive_file downloads other files and extracts text; a file with no text form says so', async () => {
  process.env.MCP_ATTACHMENTS_DIR = (await import('node:os')).tmpdir() + '/ws-read-tools-' + process.pid;
  const ctx = makeCtx(() => ({
    getDriveFile: async (id) => ({ id, name: id === 'T' ? 'notes.txt' : 'blob.bin', mimeType: id === 'T' ? 'text/plain' : 'application/octet-stream', owners: [], accountId: 'personal', accountEmail: 'p@example.com' }),
    getDriveFileContent: async (id) => id === 'T'
      ? { bytes: Buffer.from('hello from drive'), contentType: 'text/plain', filename: 'notes.txt' }
      : { bytes: Buffer.from([0, 1, 2]), contentType: 'application/octet-stream', filename: 'blob.bin' },
  }));
  const txt = text(await drive.read_drive_file({ account: 'personal', file_id: 'T' }, ctx));
  assert.match(txt, /\*\*Content\*\*:\n\nhello from drive/);
  const bin = text(await drive.read_drive_file({ account: 'personal', file_id: 'B' }, ctx));
  assert.match(bin, /no text form for application\/octet-stream/);
});

// ─── Sheets ────────────────────────────────────────────────────────────────

const GRID = [['Company', 'Status'], ['Acme', 'Applied'], ['Globex', 'Interview']];

function sheetsClient(calls) {
  return {
    getSheetsMetadata: async (id) => ({ id, title: 'Tracker', url: 'u', sheets: [{ sheetId: 0, title: 'Career Fair', index: 0, rowCount: 100, columnCount: 5 }] }),
    readSheetValues: async (id, range, render) => {
      calls.push([id, range, render]);
      if (range === 'Lists!A1:A3') return { range: 'Lists!A1:A3', values: [['Applied'], ['Interview'], ['Offer']] };
      // Google trims trailing empty cells: A1:C3 asked, rows come back 2 wide.
      if (range === "'Career Fair'!A1:C3") return { range: "'Career Fair'!A1:C3", values: GRID };
      return { range: "'Career Fair'!A1:B3", values: GRID };
    },
    getSheetValidationGrid: async (id, range) => {
      calls.push(['validation', id, range]);
      return { data: [{ startRow: 1, startColumn: 1, rowData: [{ values: [{ dataValidation: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: '=Lists!$A$1:$A$3' }] }, strict: true, showCustomUi: true } }] }] }] };
    },
  };
}

test('read_sheet_range quotes the tab, refuses a tab inside range, and prints row numbers and column letters', async () => {
  const calls = [];
  const ctx = makeCtx(() => sheetsClient(calls));
  const out = text(await sheets.read_sheet_range({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', range: 'A1:B3' }, ctx));
  assert.deepEqual(calls[0], ['S', "'Career Fair'!A1:B3", 'FORMATTED_VALUE']);
  assert.match(out, /```\nrow\tA\tB\n1\tCompany\tStatus\n2\tAcme\tApplied\n3\tGlobex\tInterview\n```/);
  // A wider request than the data: the header still shows every requested column and rows are padded.
  const wide = text(await sheets.read_sheet_range({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', range: 'A1:C3' }, ctx));
  assert.match(wide, /```\nrow\tA\tB\tC\n1\tCompany\tStatus\t\n2\tAcme\tApplied\t\n3\tGlobex\tInterview\t\n```/);
  await assert.rejects(sheets.read_sheet_range({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', range: 'Other!A1' }, ctx), /must not include a tab name/);
  const whole = text(await sheets.read_sheet_range({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair' }, ctx));
  assert.equal(calls[2][1], "'Career Fair'");
  assert.match(whole, /\*\*Range Read\*\*: 'Career Fair'!A1:B3/);
});

test('read_sheet_records returns header-keyed rows with sheet row numbers', async () => {
  const calls = [];
  const ctx = makeCtx(() => sheetsClient(calls));
  const out = text(await sheets.read_sheet_records({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair' }, ctx));
  assert.equal(calls[0][1], "'Career Fair'");
  assert.match(out, /\*\*Header Row\*\*: 1 \(auto-detected; pass header_row to override\)/);
  assert.match(out, /\*\*Columns\*\*: "Company", "Status"/);
  const explicit = text(await sheets.read_sheet_records({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', header_row: 1 }, ctx));
  assert.match(explicit, /\*\*Header Row\*\*: 1\n/);
  const json = JSON.parse(out.split('```json\n')[1].split('\n```')[0]);
  assert.deepEqual(json, [{ row: 2, values: { Company: 'Acme', Status: 'Applied' } }, { row: 3, values: { Company: 'Globex', Status: 'Interview' } }]);
});

test('find_sheet_rows returns matching rows with numbers, and says so plainly when nothing matches', async () => {
  const ctx = makeCtx(() => sheetsClient([]));
  const hit = text(await sheets.find_sheet_rows({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', column: 'company', value: 'GLOBEX' }, ctx));
  assert.match(hit, /\*\*Matches\*\*: 1/);
  assert.match(hit, /"row": 3/);
  const miss = text(await sheets.find_sheet_rows({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', column: 'Company', value: 'Initech' }, ctx));
  assert.match(miss, /\*\*Matches\*\*: 0/);
  assert.match(miss, /No rows where "Company" equals "Initech"\. Columns are: "Company", "Status"/);
  await assert.rejects(sheets.find_sheet_rows({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', column: 'Salary', value: 'x' }, ctx), /No column named "Salary"/);
  await assert.rejects(sheets.find_sheet_rows({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', column: 'Company', value: 'x', match: 'regex' }, ctx), /match must be/);
});

test('get_sheet_dropdown resolves a ONE_OF_RANGE rule to its values by reading the source range', async () => {
  const calls = [];
  const ctx = makeCtx(() => sheetsClient(calls));
  const out = text(await sheets.get_sheet_dropdown({ account: 'personal', spreadsheet_id: 'S', tab: 'Career Fair', range: 'B2' }, ctx));
  assert.deepEqual(calls[0], ['validation', 'S', "'Career Fair'!B2"]);
  assert.deepEqual(calls[1], ['S', 'Lists!A1:A3', 'FORMATTED_VALUE']);
  assert.match(out, /\*\*Cells\*\*: B2/);
  assert.match(out, /\*\*Kind\*\*: ONE_OF_RANGE from =Lists!\$A\$1:\$A\$3/);
  assert.match(out, /\*\*Allowed Values\*\* \(3\): "Applied", "Interview", "Offer"/);
  assert.match(out, /\*\*Other Values\*\*: rejected/);
});

test('get_sheet_dropdown says when there is no rule', async () => {
  const ctx = makeCtx(() => ({ getSheetValidationGrid: async () => ({ data: [{ rowData: [{ values: [{}] }] }] }) }));
  const out = text(await sheets.get_sheet_dropdown({ account: 'personal', spreadsheet_id: 'S', tab: 'T', range: 'A1' }, ctx));
  assert.match(out, /No dropdown or validation rule on 'T'!A1/);
});

// ─── Docs ──────────────────────────────────────────────────────────────────

test('read_doc renders every tab with ids, reads one tab on request, and refuses an unknown tab_id with the list', async () => {
  const ctx = makeCtx(() => ({ getDocumentWithTabs: async () => fakeDoc() }));
  const all = text(await docs.read_doc({ account: 'personal', document_id: 'D1' }, ctx));
  assert.match(all, /# Google Doc: Musings/);
  assert.match(all, /\*\*Tabs\*\* \(2\):\n- One \(tab_id: t\.0/);
  assert.match(all, /\*\*Tab: Two\*\* \(tab_id: t\.1\)\n\n## Second\n\n- item/);
  const one = text(await docs.read_doc({ account: 'personal', document_id: 'D1', tab_id: 't.1' }, ctx));
  assert.doesNotMatch(one, /First tab\./);
  assert.match(one, /\*\*Tab: Two\*\*/);
  await assert.rejects(docs.read_doc({ account: 'personal', document_id: 'D1', tab_id: 't.7' }, ctx), /No tab with tab_id "t.7"[\s\S]*- One \(tab_id: t\.0/);
});

test('read_doc never truncates: a long document returns the tab index and tells the caller to use tab_id', async () => {
  const big = fakeDoc();
  big.tabs[0].documentTab.body.content = [{ paragraph: { elements: [{ textRun: { content: 'x'.repeat(70_000) + '\n' } }] } }];
  const ctx = makeCtx(() => ({ getDocumentWithTabs: async () => big }));
  const out = text(await docs.read_doc({ account: 'personal', document_id: 'D1' }, ctx));
  assert.match(out, /above the 60,000-character single-read limit/);
  assert.match(out, /Call read_doc again with tab_id/);
  assert.doesNotMatch(out, /xxxxxxxxxx/);
  assert.ok(out.length < 2000, 'index output should be small');
  const one = text(await docs.read_doc({ account: 'personal', document_id: 'D1', tab_id: 't.0' }, ctx));
  assert.ok(one.includes('x'.repeat(70_000)), 'tab read must return the whole tab, untruncated');
});

// ─── Calendar ──────────────────────────────────────────────────────────────

test('list_events defaults the window to start now (never the oldest events first) and prints zones', async () => {
  const calls = [];
  const before = Date.now();
  const ctx = makeCtx((account) => ({
    listCalendars: async () => [{ id: 'primary', summary: 'Main', primary: true, selected: true, accountId: account.id, accountEmail: account.email }],
    listCalendarEvents: async (calendarId, opts) => {
      calls.push([account.id, calendarId, opts]);
      return [{ id: `e-${account.id}`, calendarId, summary: 'Standup', start: { dateTime: '2026-09-21T10:00:00-05:00', timeZone: 'America/Chicago' }, end: { dateTime: '2026-09-21T10:30:00-05:00', timeZone: 'America/Chicago' }, attendees: [], accountId: account.id, accountEmail: account.email }];
    },
  }));
  const out = text(await calendar.list_events({}, ctx));
  assert.equal(calls.length, 2);
  assert.match(out, /\*\*Calendar\*\*: Main \(primary\)/);
  const tmin = Date.parse(calls[0][2].timeMin);
  assert.ok(tmin >= before - 1000 && tmin <= Date.now() + 1000, 'timeMin should default to now');
  assert.match(out, /\*\*From\*\*: .* \(now -- no time_min given\)/);
  assert.match(out, /\*\*Start\*\*: 2026-09-21T10:00:00-05:00 \(America\/Chicago\)/);
  calls.length = 0;
  // time_max alone still means "from now": until plan 002 Phase 5 this passed
  // timeMin through as undefined and "this coming week" returned a year-old
  // grab-bag (agent transcript, task C2).
  const farFuture = new Date(Date.now() + 30 * 86400000).toISOString();
  const out2 = text(await calendar.list_events({ time_max: farFuture }, ctx));
  const tmin2 = Date.parse(calls[0][2].timeMin);
  assert.ok(tmin2 >= before - 1000 && tmin2 <= Date.now() + 1000, 'timeMin should default to now when only time_max is given');
  assert.equal(calls[0][2].timeMax, farFuture);
  assert.match(out2, /\*\*From\*\*: .* \(now -- no time_min given\)/);
  calls.length = 0;
  await calendar.list_events({ time_min: '2025-01-01T00:00:00Z', time_max: '2025-02-01T00:00:00Z' }, ctx);
  assert.equal(calls[0][2].timeMin, '2025-01-01T00:00:00Z', 'an explicit window is passed through untouched');
  calls.length = 0;
  await assert.rejects(calendar.list_events({ time_max: '2025-02-01T00:00:00Z' }, ctx), /time_max .* is in the past and time_min was not given/);
  assert.equal(calls.length, 0, 'a past time_max without time_min never reaches Google');
});

test('list_events without calendar_id sweeps every sidebar-shown calendar, names each event\'s calendar, dedupes the same event seen twice, and reports one calendar failing without hiding the rest', async () => {
  const calls = [];
  const ev = (id, calendarId, account, start) => ({ id, calendarId, summary: `ev ${id}`, start: { dateTime: start, timeZone: 'America/Chicago' }, end: { dateTime: start, timeZone: 'America/Chicago' }, attendees: [], accountId: account.id, accountEmail: account.email });
  const ctx = makeCtx((account) => ({
    listCalendars: async () => account.id === 'personal'
      ? [
          { id: 'primary', summary: 'Main', primary: true, selected: true },
          { id: 'school@group', summary: 'School', selected: true },
          { id: 'shared@group', summary: 'Wright Family', selected: true },
          { id: 'hidden@group', summary: 'Google Testing', selected: false },
          { id: 'broken@group', summary: 'Broken', selected: true },
        ]
      : [
          { id: 'primary', summary: 'Main', primary: true, selected: true },
          { id: 'shared@group', summary: 'Wright Family', selected: true },
        ],
    listCalendarEvents: async (calendarId) => {
      calls.push([account.id, calendarId]);
      if (calendarId === 'broken@group') throw new Error('Calendar usage limits exceeded.');
      if (calendarId === 'school@group') return [ev('s1', calendarId, account, '2026-09-22T09:00:00-05:00')];
      if (calendarId === 'shared@group') return [ev('fam1', calendarId, account, '2026-09-23T09:00:00-05:00')];
      return [ev(`p-${account.id}`, calendarId, account, '2026-09-21T09:00:00-05:00')];
    },
  }));
  const out = text(await calendar.list_events({}, ctx));
  const swept = calls.map((c) => c.join('/')).sort();
  assert.deepEqual(swept, ['personal/broken@group', 'personal/primary', 'personal/school@group', 'personal/shared@group', 'tamu/primary', 'tamu/shared@group'], 'every selected calendar in both accounts, never the hidden one');
  assert.match(out, /\*\*Calendar\*\*: every calendar shown in the sidebar \(6 swept\)/, '4 shown in personal (hidden excluded) + 2 in tamu');
  assert.match(out, /\*\*Total Found\*\*: 4/, 'p-personal, s1, fam1 (once), p-tamu');
  assert.equal((out.match(/## \d+\. ev fam1/g) ?? []).length, 1, 'the shared calendar\'s event is listed once, not once per account');
  assert.match(out, /\*\*Calendar\*\*: School \(school@group\)/);
  assert.match(out, /INCOMPLETE[\s\S]*personal, calendar "Broken": Calendar usage limits exceeded/);
  // calendar_id narrows to exactly one calendar per account and skips the sweep.
  calls.length = 0;
  const one = text(await calendar.list_events({ calendar_id: 'school@group', account: 'personal' }, ctx));
  assert.deepEqual(calls, [['personal', 'school@group']]);
  assert.match(one, /\*\*Calendar\*\*: school@group/);
});

test('formatEventTime labels a zone name that disagrees with the timestamp offset instead of printing a contradiction', () => {
  // Owner-made event: offset and zone agree -> plain label.
  assert.equal(formatEventTime({ dateTime: '2026-09-21T10:00:00-05:00', timeZone: 'America/Chicago' }), '2026-09-21T10:00:00-05:00 (America/Chicago)');
  // A Teams invite stored in Etc/UTC but rendered in the calendar's -05:00 (Phase 5 transcript, task C3).
  assert.equal(
    formatEventTime({ dateTime: '2026-09-21T15:00:00-05:00', timeZone: 'Etc/UTC' }),
    '2026-09-21T15:00:00-05:00 (offset -05:00 is authoritative; the event\'s stored zone name is Etc/UTC)',
  );
  assert.equal(formatEventTime({ dateTime: '2026-09-21T20:00:00Z', timeZone: 'UTC' }), '2026-09-21T20:00:00Z (UTC)');
  assert.equal(formatEventTime({ dateTime: '2026-09-21T20:00:00Z' }), '2026-09-21T20:00:00Z');
  assert.equal(formatEventTime({ date: '2026-09-21' }), '2026-09-21 (all day)');
  // An unknown zone name cannot be checked -> printed as given, no throw.
  assert.equal(formatEventTime({ dateTime: '2026-09-21T10:00:00-05:00', timeZone: 'Mars/Olympus' }), '2026-09-21T10:00:00-05:00 (Mars/Olympus)');
});

// ─── Errors ────────────────────────────────────────────────────────────────

test('describeGoogleApiError produces the spec sentences: lapsed auth, missing scope, not found in this account, disabled API', () => {
  assert.match(describeGoogleApiError({ message: 'invalid_grant' }, { service: 'Sheets', accountId: 'tamu', fallback: 'x' }), /account "tamu" has lapsed \(invalid_grant\)\. The owner must re-consent on the server: node tools\/reauth\.mjs tamu/);
  assert.match(describeGoogleApiError({ code: 403, message: 'Request had insufficient authentication scopes.' }, { service: 'Docs', accountId: 'personal', fallback: 'x' }), /has not consented to Google Docs access[\s\S]*reauth\.mjs personal/);
  assert.match(describeGoogleApiError({ code: 404, message: 'Requested entity was not found.' }, { service: 'Sheets', accountId: 'tamu', fallback: 'x' }), /Not found in account "tamu" \(Sheets: Requested entity was not found\.\)\. .*try the other account/);
  assert.match(describeGoogleApiError({ code: 403, response: { data: { error: { message: 'disabled', details: [{ reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://console/x', containerInfo: '123' } }] } } } }, { service: 'Calendar', fallback: 'x' }), /Enable the Google Calendar API[\s\S]*Project: 123[\s\S]*https:\/\/console\/x/);
  assert.equal(describeGoogleApiError({ message: 'something else' }, { service: 'Drive', fallback: 'x' }), 'something else');
  assert.equal(describeGoogleApiError({}, { service: 'Drive', fallback: 'Drive failed.' }), 'Drive failed.');
});

test('read_drive_file refuses a file above the size cap before downloading anything', async () => {
  let downloaded = false;
  const ctx = makeCtx(() => ({
    getDriveFile: async (id) => ({ id, name: 'huge.mp4', mimeType: 'video/mp4', size: MAX_READ_BYTES + 1, owners: [], accountId: 'personal', accountEmail: 'p@example.com' }),
    getDriveFileContent: async () => { downloaded = true; return { bytes: Buffer.alloc(1), contentType: 'video/mp4', filename: 'huge.mp4' }; },
  }));
  const out = text(await drive.read_drive_file({ account: 'personal', file_id: 'H' }, ctx));
  assert.equal(downloaded, false, 'must not download');
  assert.match(out, /above the 25 MB limit/);
  assert.match(out, /nothing was downloaded/);
});

test('getDocumentWithTabs asks Google for every tab (includeTabsContent: true) -- the first-tab-blindness guard', async () => {
  const calls = [];
  const docs = { documents: { get: async (params) => { calls.push(params); return { data: { documentId: 'D', title: 'T', tabs: [] } }; } } };
  const client = Reflect.construct(GmailAccountClient, [
    { id: 'personal', email: 'p@example.com', enabled: true },
    { accountDir: '/nonexistent', credentialsPath: '/nonexistent/c.json', tokenPath: '/nonexistent/t.json' },
    {}, {}, {}, docs, {}, '/nonexistent',
  ]);
  await client.getDocumentWithTabs(' D ');
  assert.deepEqual(calls, [{ documentId: 'D', includeTabsContent: true }]);
});
