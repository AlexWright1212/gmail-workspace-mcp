// Plan 002 Phase 4, unit C: the Drive and Calendar WRITE tool handlers,
// driven with a fake GmailAccountClient (same makeCtx pattern as
// test/workspace-read-tools.test.mjs) so assertions are about what the
// handler asks Google for, and that it reports what the fake RESPONSE says
// -- never the request echoed back. The live harness (tools/live/
// workspace-check.mjs, unit E) is what proves these against real Google.
//
// The allowlist wiring inside GmailAccountClient.createCalendarEvent /
// updateCalendarEvent (ADR 004) is untouched and already covered by
// test/workspace-allowlist.test.mjs at the CLIENT level; this file adds one
// test that goes through the NEW handler instead, reusing that file's real-
// client construction pattern, so the wiring is proven end to end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handlers as drive } from '../dist/tools/drive.js';
import { handlers as calendar } from '../dist/tools/calendar.js';
import { GmailAccountClient } from '../dist/gmail-client.js';

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

function fakeDriveDetail(overrides = {}) {
  return {
    id: 'file-1',
    name: 'Untitled',
    mimeType: 'application/pdf',
    modifiedTime: '2026-09-01T00:00:00Z',
    createdTime: '2026-09-01T00:00:00Z',
    size: 100,
    owners: ['me'],
    accountId: 'personal',
    accountEmail: 'p@example.com',
    shared: false,
    trashed: false,
    starred: false,
    ...overrides,
  };
}

// ─── create_drive_folder ────────────────────────────────────────────────────

test('create_drive_folder refuses an empty name before any Google call', async () => {
  const ctx = makeCtx(() => ({ rawApis: () => { throw new Error('should not be called'); } }));
  await assert.rejects(drive.create_drive_folder({ account: 'personal', name: '  ' }, ctx), /name is required/);
});

test('create_drive_folder sends the right requestBody via rawApis().drive.files.create and reports the RESPONSE, not the args', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    rawApis: () => ({
      drive: {
        files: {
          create: async (args) => {
            calls.push(args);
            // Deliberately different from what was asked, so the assertion
            // below can only pass by reading the response.
            return { data: { id: 'folder-999', name: 'Career Fair (renamed by Google)', parents: ['parent-xyz'], webViewLink: 'https://drive.google.com/folder-999' } };
          },
        },
      },
    }),
  }));
  const out = text(await drive.create_drive_folder({ account: 'personal', name: 'Career Fair', parent_id: 'parent-abc' }, ctx));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].requestBody, { name: 'Career Fair', mimeType: 'application/vnd.google-apps.folder', parents: ['parent-abc'] });
  assert.equal(calls[0].fields, 'id,name,parents,webViewLink');
  assert.match(out, /folder-999/);
  assert.match(out, /Career Fair \(renamed by Google\)/);
  assert.match(out, /parent-xyz/);
});

// ─── update_drive_file ──────────────────────────────────────────────────────

test('update_drive_file refuses when neither name nor move_to_folder_id is given, before any client call', async () => {
  const ctx = makeCtx(() => ({
    getDriveFile: async () => { throw new Error('should not be called'); },
    updateDriveFile: async () => { throw new Error('should not be called'); },
  }));
  await assert.rejects(
    drive.update_drive_file({ account: 'personal', file_id: 'F' }, ctx),
    /Provide name and\/or move_to_folder_id/,
  );
});

test('update_drive_file renames without touching parents when only name is given', async () => {
  const getCalls = [];
  const updateCalls = [];
  const ctx = makeCtx(() => ({
    getDriveFile: async (id) => { getCalls.push(id); return fakeDriveDetail({ id, name: 'Renamed.pdf', parents: ['p1'] }); },
    updateDriveFile: async (id, updates) => { updateCalls.push([id, updates]); return fakeDriveDetail({ id }); },
  }));
  const out = text(await drive.update_drive_file({ account: 'personal', file_id: 'F', name: 'Renamed.pdf' }, ctx));
  assert.deepEqual(updateCalls, [['F', { name: 'Renamed.pdf', addParents: undefined, removeParents: undefined }]]);
  assert.deepEqual(getCalls, ['F']); // only the final read-back -- no parent lookup when not moving
  assert.match(out, /Renamed\.pdf/);
  assert.match(out, /p1/);
});

test('update_drive_file moving reads current parents first, then sends addParents/removeParents, then reports the read-back', async () => {
  const getCalls = [];
  const updateCalls = [];
  let getCallCount = 0;
  const ctx = makeCtx(() => ({
    getDriveFile: async (id) => {
      getCallCount += 1;
      getCalls.push(id);
      if (getCallCount === 1) return fakeDriveDetail({ id, name: 'Report.pdf', parents: ['old-parent-1', 'old-parent-2'] });
      return fakeDriveDetail({ id, name: 'Report.pdf', parents: ['new-parent'] });
    },
    updateDriveFile: async (id, updates) => { updateCalls.push([id, updates]); return fakeDriveDetail({ id }); },
  }));
  const out = text(await drive.update_drive_file({ account: 'personal', file_id: 'F', move_to_folder_id: 'new-parent' }, ctx));
  assert.deepEqual(getCalls, ['F', 'F']);
  assert.deepEqual(updateCalls, [['F', { name: undefined, addParents: 'new-parent', removeParents: 'old-parent-1,old-parent-2' }]]);
  assert.match(out, /new-parent/);
  assert.doesNotMatch(out, /old-parent-1/);
});

// ─── trash_drive_file ───────────────────────────────────────────────────────

test('trash_drive_file trashes then reads back, reporting trashed: yes from the read-back', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    trashDriveFile: async (id) => { calls.push(['trash', id]); },
    getDriveFile: async (id) => { calls.push(['get', id]); return fakeDriveDetail({ id, name: 'Old Draft.docx', trashed: true }); },
  }));
  const out = text(await drive.trash_drive_file({ account: 'personal', file_id: 'F' }, ctx));
  assert.deepEqual(calls, [['trash', 'F'], ['get', 'F']]);
  assert.match(out, /Old Draft\.docx/);
  assert.match(out, /Trashed\*\*: yes/);
  assert.match(out, /recoverable from Drive's trash/);
});

// ─── upload_drive_file ──────────────────────────────────────────────────────

async function withOutboxFile(name, run) {
  const outboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-test-outbox-'));
  const previous = process.env.MCP_OUTBOX_DIR;
  process.env.MCP_OUTBOX_DIR = outboxDir;
  const filePath = path.join(outboxDir, name);
  await fs.writeFile(filePath, 'bytes');
  try {
    await run(filePath, outboxDir);
  } finally {
    if (previous === undefined) delete process.env.MCP_OUTBOX_DIR;
    else process.env.MCP_OUTBOX_DIR = previous;
    await fs.rm(outboxDir, { recursive: true, force: true });
  }
}

test('upload_drive_file refuses a path outside the outbox before any client call', async () => {
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'not-outbox-'));
  const filePath = path.join(outsideDir, 'file.pdf');
  await fs.writeFile(filePath, 'bytes');
  const outboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'real-outbox-'));
  const previous = process.env.MCP_OUTBOX_DIR;
  process.env.MCP_OUTBOX_DIR = outboxDir;
  try {
    const ctx = makeCtx(() => ({ uploadDriveFile: async () => { throw new Error('should not be called'); } }));
    await assert.rejects(
      drive.upload_drive_file({ account: 'personal', path: filePath }, ctx),
      /outside the server's outbox directory/,
    );
  } finally {
    if (previous === undefined) delete process.env.MCP_OUTBOX_DIR;
    else process.env.MCP_OUTBOX_DIR = previous;
    await fs.rm(outsideDir, { recursive: true, force: true });
    await fs.rm(outboxDir, { recursive: true, force: true });
  }
});

test('upload_drive_file uploads and deletes the outbox file on success, reporting the RESPONSE', async () => {
  await withOutboxFile('report.pdf', async (filePath) => {
    const realPath = await fs.realpath(filePath);
    const uploadCalls = [];
    const ctx = makeCtx(() => ({
      uploadDriveFile: async (input) => {
        uploadCalls.push(input);
        return fakeDriveDetail({ id: 'uploaded-1', name: 'report.pdf', size: 12345, parents: ['dest-folder'] });
      },
    }));
    const out = text(await drive.upload_drive_file({ account: 'personal', path: filePath, folder_id: 'dest-folder' }, ctx));
    assert.equal(uploadCalls.length, 1);
    assert.equal(uploadCalls[0].localPath, realPath, 'the upload reads the realpath the outbox guard resolved');
    assert.equal(uploadCalls[0].folderId, 'dest-folder');
    assert.match(out, /uploaded-1/);
    assert.match(out, /outbox copy was deleted/);
    await assert.rejects(fs.access(filePath)); // deleted after success
  });
});

test('upload_drive_file leaves the outbox file in place when the upload throws', async () => {
  await withOutboxFile('report.pdf', async (filePath) => {
    const ctx = makeCtx(() => ({
      uploadDriveFile: async () => { throw new Error('Drive upload failed (simulated).'); },
    }));
    await assert.rejects(drive.upload_drive_file({ account: 'personal', path: filePath }, ctx), /simulated/);
    await fs.access(filePath); // still there -- did not throw
  });
});

// Plan 002 Phase 5: an agent asked "upload the file in my outbox" had no way
// to learn the file's name (transcript, task DW2). Now: no path lists the
// outbox; a bare filename is resolved inside it.

test('upload_drive_file with no path lists the outbox and uploads nothing', async () => {
  await withOutboxFile('waiting.txt', async () => {
    let uploaded = false;
    const ctx = makeCtx(() => ({ uploadDriveFile: async () => { uploaded = true; return fakeDriveDetail(); } }));
    const out = text(await drive.upload_drive_file({ account: 'personal' }, ctx));
    assert.equal(uploaded, false);
    assert.match(out, /Nothing was uploaded/);
    assert.match(out, /currently holds: waiting\.txt \(5 bytes\)/);
    assert.match(out, /call upload_drive_file again with path set to one of those filenames/i);
  });
});

test('upload_drive_file with no path and an empty outbox says so and tells the caller how to stage a file', async () => {
  const outboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-outbox-'));
  const previous = process.env.MCP_OUTBOX_DIR;
  process.env.MCP_OUTBOX_DIR = outboxDir;
  try {
    const ctx = makeCtx(() => ({ uploadDriveFile: async () => { throw new Error('should not be called'); } }));
    const out = text(await drive.upload_drive_file({ account: 'personal' }, ctx));
    assert.match(out, /is currently empty/);
    assert.match(out, /Copy a file into the outbox first/);
  } finally {
    if (previous === undefined) delete process.env.MCP_OUTBOX_DIR;
    else process.env.MCP_OUTBOX_DIR = previous;
    await fs.rm(outboxDir, { recursive: true, force: true });
  }
});

test('upload_drive_file given the outbox directory itself (with or without a trailing slash) lists it instead of refusing', async () => {
  await withOutboxFile('waiting.txt', async (_filePath, outboxDir) => {
    let uploaded = false;
    const ctx = makeCtx(() => ({ uploadDriveFile: async () => { uploaded = true; return fakeDriveDetail(); } }));
    for (const p of [outboxDir, `${outboxDir}/`]) {
      const out = text(await drive.upload_drive_file({ account: 'personal', path: p }, ctx));
      assert.match(out, /Nothing was uploaded/);
      assert.match(out, /currently holds: waiting\.txt/);
    }
    assert.equal(uploaded, false);
  });
});

test('upload_drive_file accepts a bare filename, resolving it inside the outbox, and deletes it after success', async () => {
  await withOutboxFile('report.pdf', async (filePath) => {
    const realPath = await fs.realpath(filePath); // before the upload deletes it
    const uploadCalls = [];
    const ctx = makeCtx(() => ({
      uploadDriveFile: async (input) => { uploadCalls.push(input); return fakeDriveDetail({ id: 'uploaded-2', name: 'report.pdf' }); },
    }));
    const out = text(await drive.upload_drive_file({ account: 'personal', path: 'report.pdf' }, ctx));
    assert.equal(uploadCalls.length, 1);
    assert.equal(uploadCalls[0].localPath, realPath);
    assert.match(out, /uploaded-2/);
    await assert.rejects(fs.access(filePath));
  });
});

test('upload_drive_file with a name that is not in the outbox refuses and lists what is', async () => {
  await withOutboxFile('actual.txt', async () => {
    const ctx = makeCtx(() => ({ uploadDriveFile: async () => { throw new Error('should not be called'); } }));
    await assert.rejects(drive.upload_drive_file({ account: 'personal', path: 'guessed.txt' }, ctx), (error) => {
      assert.match(error.message, /could not be read/);
      assert.match(error.message, /currently holds: actual\.txt/);
      return true;
    });
  });
});

// ─── create_event / update_event ────────────────────────────────────────────

test('create_event requires start and end before calling Google', async () => {
  const ctx = makeCtx(() => ({ createCalendarEvent: async () => { throw new Error('should not be called'); } }));
  await assert.rejects(
    calendar.create_event({ account: 'personal', summary: 'x', end_date: '2026-10-01' }, ctx),
    /Provide start_date_time or start_date/,
  );
  await assert.rejects(
    calendar.create_event({ account: 'personal', summary: 'x', start_date: '2026-10-01' }, ctx),
    /Provide end_date_time or end_date/,
  );
});

test('create_event does not expose send_notifications and reports the fake response', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    createCalendarEvent: async (calendarId, input) => {
      calls.push([calendarId, input]);
      return {
        id: 'evt-1', calendarId, summary: input.summary, status: 'confirmed',
        start: { date: '2026-10-01' }, end: { date: '2026-10-02' },
        attendees: [], accountId: 'personal', accountEmail: 'p@example.com',
      };
    },
  }));
  const out = text(await calendar.create_event({ account: 'personal', summary: 'Fair', start_date: '2026-10-01', end_date: '2026-10-02' }, ctx));
  assert.equal(calls.length, 1);
  assert.ok(!('sendNotifications' in calls[0][1]) || calls[0][1].sendNotifications === undefined);
  assert.match(out, /evt-1/);
});

test('create_event wraps a googleapis error through describeGoogleApiError (service Calendar, account named)', async () => {
  const ctx = makeCtx((account) => ({
    createCalendarEvent: async () => {
      const err = new Error('not found');
      err.code = 404;
      throw err;
    },
  }));
  await assert.rejects(
    calendar.create_event({ account: 'personal', summary: 'x', start_date: '2026-10-01', end_date: '2026-10-02' }, ctx),
    /Not found in account "personal"/,
  );
});

test('update_event wraps a googleapis error through describeGoogleApiError', async () => {
  const ctx = makeCtx(() => ({
    updateCalendarEvent: async () => {
      const err = new Error('scope');
      err.code = 403;
      err.message = 'insufficient permission (ACCESS_TOKEN_SCOPE_INSUFFICIENT)';
      throw err;
    },
  }));
  await assert.rejects(
    calendar.update_event({ account: 'personal', calendar_id: 'primary', event_id: 'evt-1', summary: 'x' }, ctx),
    /has not consented to Google Calendar access/,
  );
});

// ─── delete_event ────────────────────────────────────────────────────────────

test('delete_event reads the title first, deletes, then reports the status Google now returns', async () => {
  const calls = [];
  const ctx = makeCtx(() => ({
    getCalendarEvent: async (calendarId, eventId) => { calls.push(['get', calendarId, eventId]); return { summary: 'Career Fair' }; },
    deleteCalendarEvent: async (calendarId, eventId) => { calls.push(['delete', calendarId, eventId]); },
    rawApis: () => ({
      calendar: {
        events: {
          get: async (args) => { calls.push(['rawGet', args.calendarId, args.eventId]); return { data: { status: 'cancelled' } }; },
        },
      },
    }),
  }));
  const out = text(await calendar.delete_event({ account: 'personal', calendar_id: 'testing-cal', event_id: 'evt-1' }, ctx));
  assert.deepEqual(calls, [['get', 'testing-cal', 'evt-1'], ['delete', 'testing-cal', 'evt-1'], ['rawGet', 'testing-cal', 'evt-1']]);
  assert.match(out, /Career Fair/);
  assert.match(out, /"cancelled"/);
});

test('delete_event reports "gone" when the read-back 404s or 410s', async () => {
  const ctx = makeCtx(() => ({
    getCalendarEvent: async () => ({ summary: 'One-off' }),
    deleteCalendarEvent: async () => {},
    rawApis: () => ({
      calendar: {
        events: {
          get: async () => { const err = new Error('gone'); err.code = 410; throw err; },
        },
      },
    }),
  }));
  const out = text(await calendar.delete_event({ account: 'personal', calendar_id: 'testing-cal', event_id: 'evt-2' }, ctx));
  assert.match(out, /"gone"/);
});

// ─── handler-level allowlist wiring (ADR 004, proven through the NEW handler) ──

const OWNER = 'ownerpersonal@gmail.com';
const OUTSIDER = 'stranger@attacker.example';
const PERSONAL = { id: 'personal', email: OWNER, enabled: true };
const PATHS = { accountDir: '', credentialsPath: '', tokenPath: '', metaPath: '' };

async function makeAllowlistConfigRoot(allowed = [OWNER]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-write-allowlist-test-'));
  await fs.writeFile(path.join(dir, 'send-allowlist.json'), JSON.stringify({ allowed }, null, 2), 'utf8');
  return dir;
}

function fakeCalendarApi() {
  const calls = { insert: [] };
  return { calls, events: { insert: async (args) => { calls.insert.push(args); return { data: { id: 'evt-1', summary: args.requestBody.summary } }; } } };
}

/** The constructor is TS-private only; runtime construction is fine (same pattern as test/workspace-allowlist.test.mjs). */
function makeRealClient(calendarApi, configRoot) {
  return Reflect.construct(GmailAccountClient, [PERSONAL, PATHS, {}, {}, {}, {}, calendarApi, configRoot]);
}

test('create_event handler refuses a non-allowlisted attendee before any Calendar call (through the real client, not a fake)', async () => {
  const configRoot = await makeAllowlistConfigRoot();
  const calendarApi = fakeCalendarApi();
  const realClient = makeRealClient(calendarApi, configRoot);
  const ctx = {
    configRoot,
    loadConfig: async () => ({ accounts: [PERSONAL] }),
    getClientForAccount: async () => realClient,
    isToolEnabled: () => true,
  };

  await assert.rejects(
    calendar.create_event({
      account: 'personal',
      summary: 'test',
      start_date: '2026-10-01',
      end_date: '2026-10-02',
      attendees: [OUTSIDER],
    }, ctx),
    (error) => {
      assert.match(error.message, /Send blocked/);
      // Calendar vocabulary, not mail's (plan 002 Phase 5 transcript read
      // "no message was sent" on an event refusal and found it confusing).
      assert.match(error.message, /No event was created and no request reached Google Calendar/);
      assert.doesNotMatch(error.message, /No message was sent/);
      return true;
    },
  );
  assert.deepEqual(calendarApi.calls.insert, []);
});

test('create_event handler allows an allowlisted attendee through the real client', async () => {
  const configRoot = await makeAllowlistConfigRoot();
  const calendarApi = fakeCalendarApi();
  const realClient = makeRealClient(calendarApi, configRoot);
  const ctx = {
    configRoot,
    loadConfig: async () => ({ accounts: [PERSONAL] }),
    getClientForAccount: async () => realClient,
    isToolEnabled: () => true,
  };

  const out = text(await calendar.create_event({
    account: 'personal',
    summary: 'test',
    start_date: '2026-10-01',
    end_date: '2026-10-02',
    attendees: [OWNER],
  }, ctx));
  assert.equal(calendarApi.calls.insert.length, 1);
  assert.match(out, /evt-1/);
});
