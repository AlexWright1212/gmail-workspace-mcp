// Plan 002 Phase 4, unit C: src/outbox.ts is resolveOutboxDir() and
// cleanupIfInOutbox() moved verbatim out of src/compose.ts (so
// upload_drive_file can reuse them), plus the new assertInsideOutbox() guard
// upload_drive_file calls before any Google call. cleanupIfInOutbox's own
// behavior (delete-on-success inside the outbox, symlink-safety, best-effort
// on a missing dir) is already covered by test/compose.test.mjs's "outbox"
// block and is not re-proven here -- this file covers the move itself
// (MCP_OUTBOX_DIR is honoured from this module) and the new guard.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveOutboxDir, assertInsideOutbox, listOutbox, describeOutboxListing } from '../dist/outbox.js';

async function withOutbox(run) {
  const outboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'outbox-test-'));
  const previous = process.env.MCP_OUTBOX_DIR;
  process.env.MCP_OUTBOX_DIR = outboxDir;
  try {
    await run(outboxDir);
  } finally {
    if (previous === undefined) delete process.env.MCP_OUTBOX_DIR;
    else process.env.MCP_OUTBOX_DIR = previous;
    await fs.rm(outboxDir, { recursive: true, force: true });
  }
}

test('resolveOutboxDir honours MCP_OUTBOX_DIR and falls back to the fixed VPS default', async () => {
  await withOutbox(async (outboxDir) => {
    assert.equal(resolveOutboxDir(), outboxDir);
  });

  const previous = process.env.MCP_OUTBOX_DIR;
  delete process.env.MCP_OUTBOX_DIR;
  try {
    assert.equal(resolveOutboxDir(), '/root/.gmail-multi-mcp/outbox');
  } finally {
    if (previous !== undefined) process.env.MCP_OUTBOX_DIR = previous;
  }
});

test('assertInsideOutbox passes for a file inside the outbox and returns its real path', async () => {
  await withOutbox(async (outboxDir) => {
    const filePath = path.join(outboxDir, 'report.pdf');
    await fs.writeFile(filePath, 'bytes');
    const real = await assertInsideOutbox(filePath);
    assert.equal(real, await fs.realpath(filePath));
  });
});

test('assertInsideOutbox refuses a file outside the outbox, with a scp hint', async () => {
  await withOutbox(async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'not-outbox-'));
    const filePath = path.join(outsideDir, 'report.pdf');
    await fs.writeFile(filePath, 'bytes');
    try {
      await assert.rejects(assertInsideOutbox(filePath), (error) => {
        assert.match(error.message, /outside the server's outbox directory/);
        assert.match(error.message, /scp/);
        return true;
      });
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test('assertInsideOutbox refuses a symlink inside the outbox that points outside it', async () => {
  await withOutbox(async (outboxDir) => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'not-outbox-'));
    const target = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(target, 'bytes');
    const link = path.join(outboxDir, 'looks-local.txt');
    await fs.symlink(target, link);
    try {
      await assert.rejects(assertInsideOutbox(link), /outside the server's outbox directory/);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test('assertInsideOutbox refuses a missing file with a clear message', async () => {
  await withOutbox(async (outboxDir) => {
    const filePath = path.join(outboxDir, 'does-not-exist.pdf');
    await assert.rejects(assertInsideOutbox(filePath), (error) => {
      assert.match(error.message, /could not be read/);
      assert.match(error.message, /scp/);
      return true;
    });
  });
});

test('assertInsideOutbox reports plainly when the outbox directory itself is missing', async () => {
  const missingDir = path.join(os.tmpdir(), `no-such-outbox-${Date.now()}`);
  const previous = process.env.MCP_OUTBOX_DIR;
  process.env.MCP_OUTBOX_DIR = missingDir;
  try {
    await assert.rejects(assertInsideOutbox(path.join(missingDir, 'x.pdf')), (error) => {
      assert.match(error.message, /outbox directory.*does not exist/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.MCP_OUTBOX_DIR;
    else process.env.MCP_OUTBOX_DIR = previous;
  }
});

// ─── Plan 002 Phase 5: bare filenames and listing ────────────────────────────

test('assertInsideOutbox resolves a bare filename inside the outbox (no directory part)', async () => {
  await withOutbox(async (outboxDir) => {
    const filePath = path.join(outboxDir, 'report.pdf');
    await fs.writeFile(filePath, 'bytes');
    assert.equal(await assertInsideOutbox('report.pdf'), await fs.realpath(filePath));
  });
});

test('assertInsideOutbox still refuses a bare-name symlink that points outside, and a dotted escape', async () => {
  await withOutbox(async (outboxDir) => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'not-outbox-'));
    const target = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(target, 'bytes');
    await fs.symlink(target, path.join(outboxDir, 'link.txt'));
    try {
      await assert.rejects(assertInsideOutbox('link.txt'), /outside the server's outbox directory/);
      await assert.rejects(assertInsideOutbox('../secret.txt'), /could not be read|outside the server's outbox directory/);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test('a missing file names what the outbox does hold, so the caller can pick a real name', async () => {
  await withOutbox(async (outboxDir) => {
    await fs.writeFile(path.join(outboxDir, 'a.txt'), 'aaaa');
    await fs.writeFile(path.join(outboxDir, 'b.pdf'), 'bb');
    await assert.rejects(assertInsideOutbox('nope.pdf'), (error) => {
      assert.match(error.message, /could not be read/);
      assert.match(error.message, /currently holds: a\.txt \(4 bytes\), b\.pdf \(2 bytes\)/);
      return true;
    });
  });
});

test('listOutbox lists regular files only, sorted, with sizes; a missing outbox is an empty list', async () => {
  await withOutbox(async (outboxDir) => {
    await fs.writeFile(path.join(outboxDir, 'z.txt'), 'zzz');
    await fs.writeFile(path.join(outboxDir, 'a.txt'), 'a');
    await fs.mkdir(path.join(outboxDir, 'subdir'));
    await fs.symlink(path.join(outboxDir, 'a.txt'), path.join(outboxDir, 'link.txt'));
    assert.deepEqual(await listOutbox(), [{ name: 'a.txt', bytes: 1 }, { name: 'z.txt', bytes: 3 }]);
    assert.match(describeOutboxListing(await listOutbox()), /holds: a\.txt \(1 bytes\), z\.txt \(3 bytes\)\./);
    assert.match(describeOutboxListing([]), /is currently empty/);
  });
  const previous = process.env.MCP_OUTBOX_DIR;
  process.env.MCP_OUTBOX_DIR = path.join(os.tmpdir(), `no-such-outbox-${Date.now()}`);
  try {
    assert.deepEqual(await listOutbox(), []);
  } finally {
    if (previous === undefined) delete process.env.MCP_OUTBOX_DIR;
    else process.env.MCP_OUTBOX_DIR = previous;
  }
});
