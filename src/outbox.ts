/**
 * The server's drop box for files that live on a client machine, not the VPS
 * (ADR 009). `resolveOutboxDir()` and `cleanupIfInOutbox()` moved here
 * verbatim from src/compose.ts (plan 002, Phase 4, unit C) so
 * upload_drive_file can reuse the exact same directory and delete-on-success
 * behavior mail attachments already use, instead of a second copy of the
 * logic. compose.ts now imports both from here; nothing about their
 * behavior changed in the move.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Where files copied over from a client machine (which the server process
 * cannot otherwise read) are expected to land. Files read from here are
 * deleted once their bytes are captured; this is a drop box, not storage.
 * Overridable so tests don't need root's real path.
 */
export function resolveOutboxDir(): string {
  return process.env.MCP_OUTBOX_DIR?.trim() || '/root/.gmail-multi-mcp/outbox';
}

export interface OutboxEntry {
  name: string;
  bytes: number;
}

/**
 * What is waiting in the outbox: regular files only, by name, with sizes.
 * Directories, symlinks and anything unreadable are left out rather than
 * listed -- upload_drive_file would refuse them anyway (the realpath check in
 * assertInsideOutbox), so listing them would only invite a doomed call.
 * A missing outbox directory is an empty listing, not an error: the caller
 * decides what to say about it.
 */
export async function listOutbox(): Promise<OutboxEntry[]> {
  const dir = resolveOutboxDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const entries: OutboxEntry[] = [];
  for (const name of names.sort()) {
    try {
      const stat = await fs.lstat(path.join(dir, name));
      if (stat.isFile()) entries.push({ name, bytes: stat.size });
    } catch {
      // Skip: vanished between readdir and lstat, or unreadable.
    }
  }
  return entries;
}

/** One sentence for tool output: the outbox's current contents, or that it is empty. */
export function describeOutboxListing(entries: OutboxEntry[]): string {
  const dir = resolveOutboxDir();
  if (entries.length === 0) return `The outbox (${dir}) is currently empty.`;
  return `The outbox (${dir}) currently holds: ${entries.map((e) => `${e.name} (${e.bytes} bytes)`).join(', ')}.`;
}

/**
 * Delete `filePath` iff it resolves (via realpath, so a symlink can't point
 * the check one place and the read another) inside the outbox dir. Anything
 * outside it -- the general case, e.g. a path already on the VPS -- is left
 * alone. Best-effort: a missing outbox dir or a failed unlink must never
 * fail the caller, since by the time this runs the bytes have already been
 * captured.
 */
export async function cleanupIfInOutbox(filePath: string): Promise<void> {
  let realOutbox: string;
  let realFile: string;
  try {
    realOutbox = await fs.realpath(resolveOutboxDir());
    realFile = await fs.realpath(filePath);
  } catch {
    return;
  }
  const relative = path.relative(realOutbox, realFile);
  const isInsideOutbox = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (!isInsideOutbox) return;
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort. The caller has already captured what it needed -- a
    // stale file left behind here is a cleanup miss, not a call failure.
  }
}

/**
 * Refuse, before any Google call, a path that isn't inside the outbox
 * directory -- upload_drive_file's guard. Unlike cleanupIfInOutbox (which
 * silently no-ops outside the outbox, because a mail attachment is allowed
 * to live anywhere on the VPS), Drive upload has exactly one legitimate
 * source: the drop box. Realpaths both sides so a symlink placed inside the
 * outbox that points somewhere else is refused too, not treated as "inside".
 * Returns the file's real path on success.
 */
export async function assertInsideOutbox(filePath: string): Promise<string> {
  const outboxDir = resolveOutboxDir();
  const hint =
    `Copy it into the server's outbox first, e.g. ` +
    `\`scp <local path> root@100.64.0.10:${outboxDir}/<filename>\` ` +
    `(the same SSH access used for deploys), then pass the resulting path here.`;
  // A bare filename (no directory part) means "the file of that name in the
  // outbox" -- the agent-level runs in plan 002 Phase 5 showed an agent has
  // no way to know the outbox's absolute path except by reading a tool
  // description, and no reason to. The joined path still goes through the
  // realpath containment check below, so `..` or a symlink cannot escape.
  if (!filePath.includes('/') && !filePath.includes(path.sep)) {
    filePath = path.join(outboxDir, filePath);
  }

  let realOutbox: string;
  try {
    realOutbox = await fs.realpath(outboxDir);
  } catch (error) {
    throw new Error(
      `The server's outbox directory (${outboxDir}) does not exist or is not readable: ` +
        `${(error as Error).message}. ${hint}`
    );
  }

  let realFile: string;
  try {
    realFile = await fs.realpath(filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // Say what IS there: the usual cause is a guessed or mistyped name, and
    // the listing turns a dead end into the next call.
    const listing = describeOutboxListing(await listOutbox());
    throw new Error(
      `"${filePath}" could not be read (${err.code ?? 'error'}: ${err.message}). ${listing} ${hint}`
    );
  }

  const relative = path.relative(realOutbox, realFile);
  const isInsideOutbox = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (!isInsideOutbox) {
    throw new Error(
      `"${filePath}" is outside the server's outbox directory (${outboxDir}) -- a path here must ` +
        `already be on the VPS, inside the outbox, not on the machine the calling client runs on. ${hint}`
    );
  }

  return realFile;
}
