#!/usr/bin/env node
// Phase 0 probe for plan 002: does each account actually reach Google
// Workspace from the VPS?
//
// Runs on the VPS (bash scripts/vps.sh 'node tools/workspace-probe.mjs') and,
// per account, answers four questions with real API calls, never by looking
// at files:
//   1. Does the stored token carry the Drive/Sheets/Docs/Calendar scopes?
//   2. Are the four APIs enabled in the GCP project?  (Google says so in the
//      error text, with the enable link -- printed verbatim.)
//   3. Can the account see the "Google Testing" fixture folder and both
//      templates?  (tamu sees them through sharing; a university policy that
//      blocks third-party Drive access would surface here, by name.)
//   4. Does the "Google Testing" calendar exist?
//
// Exit code is non-zero if any check fails for any account. There is no
// "ready" summary that a fully broken system could also produce: every line
// is the result of a call that had to succeed.
//
// Flags:
//   --create-calendar   on the personal account only: create the secondary
//                       "Google Testing" calendar if absent, hide it from the
//                       sidebar (calendarList.selected = false), print its id.
//                       Idempotent -- an existing one is reused, never duplicated.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const CONFIG_ROOT = process.env.GMAILMCPCONFIG_DIR || '/root/.gmail-multi-mcp';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(await fs.readFile(path.join(HERE, 'live', 'fixtures.json'), 'utf8'));

const WORKSPACE_SCOPES = {
  drive: 'https://www.googleapis.com/auth/drive',
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  docs: 'https://www.googleapis.com/auth/documents',
  calendar: 'https://www.googleapis.com/auth/calendar',
};

const createCalendar = process.argv.includes('--create-calendar');
let failures = 0;

function ok(acct, what, detail = '') {
  console.log(`  PASS  [${acct}] ${what}${detail ? ' -- ' + detail : ''}`);
}
function fail(acct, what, err) {
  failures += 1;
  const msg = err instanceof Error ? err.message : String(err);
  let hint = '';
  if (/accessNotConfigured|has not been used in project|is disabled/i.test(msg)) {
    hint = '\n        => API NOT ENABLED in the GCP project. Enable it at the link in the message above.';
  } else if (/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(msg)) {
    hint = `\n        => token lacks the scope. Re-consent: node tools/reauth.mjs ${acct}`;
  } else if (/invalid_grant/i.test(msg)) {
    hint = `\n        => refresh token is dead. Re-consent: node tools/reauth.mjs ${acct}`;
  } else if (/File not found|notFound|404/i.test(msg)) {
    hint = '\n        => the account cannot see this object. For tamu: is the folder shared with owner_school@tamu.edu?';
  }
  console.log(`  FAIL  [${acct}] ${what} -- ${msg}${hint}`);
}

async function loadAccount(accountId) {
  const cfg = JSON.parse(await fs.readFile(path.join(CONFIG_ROOT, 'accounts.json'), 'utf8'));
  const acct = cfg.accounts.find((a) => a.id === accountId);
  if (!acct) throw new Error(`account "${accountId}" not in accounts.json`);
  const creds = JSON.parse(await fs.readFile(acct.credentialPath, 'utf8'));
  const c = creds.installed || creds.web;
  const client = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris?.[0] || 'http://localhost');
  const tokens = JSON.parse(await fs.readFile(acct.tokenPath, 'utf8'));
  client.setCredentials(tokens);
  return { acct, client, tokens };
}

function countTabs(tabs) {
  let n = 0;
  for (const t of tabs || []) n += 1 + countTabs(t.childTabs);
  return n;
}

async function probeAccount(accountId) {
  console.log(`\n== ${accountId} ==`);
  let acct, client, tokens;
  try {
    ({ acct, client, tokens } = await loadAccount(accountId));
  } catch (err) {
    fail(accountId, 'load account', err);
    return;
  }

  // 1. Scopes actually granted, as recorded at consent time.
  const granted = new Set((tokens.scope || '').split(' ').filter(Boolean));
  const missing = Object.entries(WORKSPACE_SCOPES).filter(([, s]) => !granted.has(s)).map(([k]) => k);
  if (missing.length) {
    fail(accountId, 'token scopes', new Error(`missing ${missing.join(', ')} (has: ${[...granted].join(' ')})`));
    console.log(`        => re-consent: bash scripts/vps.sh 'node tools/reauth.mjs ${accountId}'`);
    console.log('        (skipping API calls for this account -- they cannot succeed without the scopes)');
    return;
  }
  ok(accountId, 'token scopes', 'drive, sheets, docs, calendar all granted');

  const drive = google.drive({ version: 'v3', auth: client });
  const sheets = google.sheets({ version: 'v4', auth: client });
  const docs = google.docs({ version: 'v1', auth: client });
  const calendar = google.calendar({ version: 'v3', auth: client });

  // 2/3. Drive: list the fixture folder and confirm both templates are visible.
  try {
    const res = await drive.files.list({
      q: `'${FIXTURES.folder.id}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType)',
      pageSize: 100,
    });
    const files = res.data.files || [];
    const ids = new Set(files.map((f) => f.id));
    const names = files.map((f) => f.name).join(', ');
    const absent = Object.values(FIXTURES.templates).filter((t) => !ids.has(t.id)).map((t) => t.name);
    if (absent.length) fail(accountId, 'drive: fixture folder', new Error(`folder lists [${names}] but not: ${absent.join(', ')}`));
    else ok(accountId, 'drive: fixture folder', `${files.length} file(s): ${names}`);
  } catch (err) {
    fail(accountId, 'drive: fixture folder', err);
  }

  // Sheets: the internship template's tab list.
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId: FIXTURES.templates.internship.id,
      fields: 'properties.title,sheets.properties.title',
    });
    const tabs = (res.data.sheets || []).map((s) => s.properties?.title).join(', ');
    ok(accountId, 'sheets: internship template', `"${res.data.properties?.title}" tabs: ${tabs}`);
  } catch (err) {
    fail(accountId, 'sheets: internship template', err);
  }

  // Docs: the musings template, all tabs.
  try {
    const res = await docs.documents.get({
      documentId: FIXTURES.templates.musings.id,
      includeTabsContent: true,
    });
    ok(accountId, 'docs: musings template', `"${res.data.title}" ${countTabs(res.data.tabs)} tab(s)`);
  } catch (err) {
    fail(accountId, 'docs: musings template', err);
  }

  // 4. Calendar: list, and find/create the testing calendar.
  try {
    const res = await calendar.calendarList.list({ maxResults: 250 });
    const items = res.data.items || [];
    const summaries = items.map((c) => `${c.summary}${c.primary ? ' (primary)' : ''}`).join(', ');
    ok(accountId, 'calendar: list', `${items.length} calendar(s): ${summaries}`);

    const wanted = FIXTURES.testingCalendar.name;
    let testing = items.find((c) => c.summary === wanted && c.accessRole === 'owner');
    if (!testing && createCalendar && accountId === FIXTURES.testingCalendar.owner) {
      const created = await calendar.calendars.insert({ requestBody: { summary: wanted } });
      await calendar.calendarList.patch({ calendarId: created.data.id, requestBody: { selected: false } });
      // Read it back: the list is the source of truth, not the insert response.
      const again = await calendar.calendarList.list({ maxResults: 250 });
      testing = (again.data.items || []).find((c) => c.id === created.data.id);
      if (!testing) throw new Error(`created ${created.data.id} but it is not in calendarList`);
      ok(accountId, `calendar: created "${wanted}"`, `id ${testing.id}, hidden from sidebar (selected=${testing.selected === true})`);
    }
    if (accountId === FIXTURES.testingCalendar.owner) {
      if (!testing) {
        fail(accountId, `calendar: "${wanted}"`, new Error('not found. Run with --create-calendar'));
      } else if (FIXTURES.testingCalendar.id && FIXTURES.testingCalendar.id !== testing.id) {
        fail(accountId, `calendar: "${wanted}"`, new Error(`id ${testing.id} != fixtures.json ${FIXTURES.testingCalendar.id}`));
      } else {
        ok(accountId, `calendar: "${wanted}"`, `id ${testing.id}${FIXTURES.testingCalendar.id ? '' : '  <-- record this in tools/live/fixtures.json'}`);
      }
    }
  } catch (err) {
    fail(accountId, 'calendar', err);
  }
}

for (const id of FIXTURES.accounts) await probeAccount(id);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
