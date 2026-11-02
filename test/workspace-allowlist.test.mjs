// Tests that the send-allowlist boundary also covers the two Workspace tools
// that can reach a third party outside Gmail's send path: share_drive_file and
// create_event/update_event. Added 2026-08-17 alongside the fix — previously
// these tools had no allowlist check at all and were "safe" only because
// tools-enabled.json switched them off.
//
// Also covers tools-enabled.json's fail-closed behavior at the source level,
// since src/index.ts self-executes and cannot be imported by tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GmailAccountClient } from '../dist/gmail-client.js';
import { SendNotAllowedError } from '../dist/allowlist.js';

const OWNER = 'ownerpersonal@gmail.com';
const OUTSIDER = 'stranger@attacker.example';

const PERSONAL = { id: 'personal', email: OWNER, enabled: true };
const PATHS = { accountDir: '', credentialsPath: '', tokenPath: '', metaPath: '' };

async function makeConfigRoot(allowed = [OWNER]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-allowlist-test-'));
  await fs.writeFile(
    path.join(dir, 'send-allowlist.json'),
    JSON.stringify({ allowed }, null, 2),
    'utf8'
  );
  return dir;
}

/** The constructor is TS-private only; runtime construction is fine. */
function makeClient({ gmail = {}, drive = {}, sheets = {}, docs = {}, calendar = {} }, configRoot) {
  return Reflect.construct(GmailAccountClient, [
    PERSONAL, PATHS, gmail, drive, sheets, docs, calendar, configRoot,
  ]);
}

function fakeDrive() {
  const calls = [];
  return {
    calls,
    permissions: {
      create: async (args) => {
        calls.push(args);
        return { data: { id: 'perm-1' } };
      },
    },
  };
}

function fakeCalendar() {
  const calls = { insert: [], patch: [] };
  return {
    calls,
    events: {
      insert: async (args) => {
        calls.insert.push(args);
        return { data: { id: 'evt-1', summary: args.requestBody.summary } };
      },
      patch: async (args) => {
        calls.patch.push(args);
        return { data: { id: args.eventId } };
      },
    },
  };
}

// ── share_drive_file ────────────────────────────────────────────────────────

test('share_drive_file refuses a non-allowlisted email BEFORE any Drive call', async () => {
  const configRoot = await makeConfigRoot();
  const drive = fakeDrive();
  const client = makeClient({ drive }, configRoot);

  await assert.rejects(
    () => client.shareDriveFile('file-1', { email: OUTSIDER, role: 'reader', type: 'user' }),
    SendNotAllowedError
  );
  assert.deepEqual(drive.calls, []);
});

test('share_drive_file allows an allowlisted email through', async () => {
  const configRoot = await makeConfigRoot();
  const drive = fakeDrive();
  const client = makeClient({ drive }, configRoot);

  const result = await client.shareDriveFile('file-1', { email: OWNER, role: 'reader', type: 'user' });
  assert.equal(result.permissionId, 'perm-1');
  assert.equal(drive.calls.length, 1);
});

test('share_drive_file refuses type "anyone" outright, allowlisted or not', async () => {
  const configRoot = await makeConfigRoot();
  const drive = fakeDrive();
  const client = makeClient({ drive }, configRoot);

  await assert.rejects(
    () => client.shareDriveFile('file-1', { role: 'reader', type: 'anyone' }),
    /not permitted/
  );
  assert.deepEqual(drive.calls, []);
});

test('share_drive_file refuses type "domain" outright', async () => {
  const configRoot = await makeConfigRoot();
  const drive = fakeDrive();
  const client = makeClient({ drive }, configRoot);

  await assert.rejects(
    () => client.shareDriveFile('file-1', { role: 'reader', type: 'domain' }),
    /not permitted/
  );
  assert.deepEqual(drive.calls, []);
});

// ── create_event ─────────────────────────────────────────────────────────────

test('create_event refuses a non-allowlisted attendee BEFORE any Calendar call', async () => {
  const configRoot = await makeConfigRoot();
  const calendar = fakeCalendar();
  const client = makeClient({ calendar }, configRoot);

  await assert.rejects(
    () =>
      client.createCalendarEvent('primary', {
        summary: 'test',
        start: { date: '2026-09-01' },
        end: { date: '2026-09-02' },
        attendees: [OWNER, OUTSIDER],
      }),
    SendNotAllowedError
  );
  assert.deepEqual(calendar.calls.insert, []);
});

test('create_event allows an all-allowlisted attendee list through', async () => {
  const configRoot = await makeConfigRoot();
  const calendar = fakeCalendar();
  const client = makeClient({ calendar }, configRoot);

  const result = await client.createCalendarEvent('primary', {
    summary: 'test',
    start: { date: '2026-09-01' },
    end: { date: '2026-09-02' },
    attendees: [OWNER],
  });
  assert.equal(result.summary, 'test');
  assert.equal(calendar.calls.insert.length, 1);
});

test('create_event with no attendees needs no allowlist check', async () => {
  const configRoot = await makeConfigRoot();
  const calendar = fakeCalendar();
  const client = makeClient({ calendar }, configRoot);

  await client.createCalendarEvent('primary', {
    summary: 'test',
    start: { date: '2026-09-01' },
    end: { date: '2026-09-02' },
  });
  assert.equal(calendar.calls.insert.length, 1);
});

test('update_event refuses a non-allowlisted attendee BEFORE any Calendar call', async () => {
  const configRoot = await makeConfigRoot();
  const calendar = fakeCalendar();
  const client = makeClient({ calendar }, configRoot);

  await assert.rejects(
    () =>
      client.updateCalendarEvent('primary', 'evt-1', {
        attendees: [OUTSIDER],
      }),
    SendNotAllowedError
  );
  assert.deepEqual(calendar.calls.patch, []);
});

// ── endpoints.json fails closed ─────────────────────────────────────────────
//
// Plan 002 Phase 1 replaced tools-enabled.json / loadEnabledTools() (which
// failed closed by returning an empty tool set, so the server still booted)
// with endpoints.json / loadEndpoints() (src/endpoints.ts), which fails
// closed by THROWING and crashing the process before any port is bound --
// see that module's doc comment. Its fail-closed behavior is covered by
// test/endpoints.test.mjs, not here.
