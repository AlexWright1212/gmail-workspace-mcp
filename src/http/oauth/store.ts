/**
 * Persistent JSON storage for the OAuth authorization server, under a new
 * `oauth/` subdirectory of the same configRoot src/config.ts already uses for
 * accounts.json -- same idiom (plain JSON, no database), new directory.
 *
 * Registered clients and issued tokens must survive a `pm2 restart`; that is
 * the entire reason this exists instead of an in-memory Map, which is what
 * every OAuthServerProvider example in the SDK docs uses.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function getOAuthDir(configRoot: string): string {
  return path.join(configRoot, 'oauth');
}

async function ensureOAuthDir(configRoot: string): Promise<void> {
  await fs.mkdir(getOAuthDir(configRoot), { recursive: true });
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new Error(`Failed to read ${file}: ${(err as Error).message}`);
  }
}

async function writeJsonFile(file: string, data: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Per-file write serialization. This is a personal-scale, single-process
 * server -- an in-process promise chain is enough to stop two concurrent
 * mutations of the same JSON file (e.g. two token exchanges landing in the
 * same tick) from interleaving their read-modify-write and losing one of
 * them. It is not a cross-process lock and does not need to be; there is only
 * ever one `node dist/index.js` process holding this file.
 */
const writeQueues = new Map<string, Promise<unknown>>();

async function serialized<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prior = writeQueues.get(file) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // Swallow so one failed mutation doesn't wedge every later one queued
  // behind it; the actual rejection still propagates to this call's caller
  // via `run` itself.
  writeQueues.set(
    file,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * One JSON file holding a `Record<id, T>`. Every OAuth record type (clients,
 * pending authorizations, authorization codes, access tokens, refresh
 * tokens) gets its own file/store -- simpler than one shared file with mixed
 * record shapes, and it means a corrupt/lost file only ever costs one kind of
 * state.
 */
export class JsonRecordStore<T> {
  constructor(
    private readonly configRoot: string,
    private readonly filename: string,
  ) {}

  private get filePath(): string {
    return path.join(getOAuthDir(this.configRoot), this.filename);
  }

  async get(id: string): Promise<T | undefined> {
    const all = await readJsonFile<Record<string, T>>(this.filePath, {});
    return all[id];
  }

  async set(id: string, value: T): Promise<void> {
    await ensureOAuthDir(this.configRoot);
    await serialized(this.filePath, async () => {
      const all = await readJsonFile<Record<string, T>>(this.filePath, {});
      all[id] = value;
      await writeJsonFile(this.filePath, all);
    });
  }

  async delete(id: string): Promise<void> {
    await ensureOAuthDir(this.configRoot);
    await serialized(this.filePath, async () => {
      const all = await readJsonFile<Record<string, T>>(this.filePath, {});
      if (id in all) {
        delete all[id];
        await writeJsonFile(this.filePath, all);
      }
    });
  }

  /**
   * Atomically reads and deletes one record as a SINGLE step in the same
   * `serialized()` critical section used by every other mutation of this
   * file -- not two separate `get()` + `delete()` calls.
   *
   * This exists for exactly one reason: a single-use record (an
   * authorization code, a pending-authorization consent decision) must be
   * claimable by at most one caller, even when two callers race. A
   * `get()`-then-`delete()` pair does NOT provide that -- both concurrent
   * callers can `get()` the still-present record before either `delete()`
   * runs, and both then believe they legitimately claimed it. `claim()`
   * folds the read and the delete into one turn of the same write queue
   * every other mutation already goes through, so the second concurrent
   * caller's `claim()` runs only after the first's delete has already
   * landed, and sees nothing.
   */
  async claim(id: string): Promise<T | undefined> {
    await ensureOAuthDir(this.configRoot);
    return serialized(this.filePath, async () => {
      const all = await readJsonFile<Record<string, T>>(this.filePath, {});
      const value = all[id];
      if (value !== undefined) {
        delete all[id];
        await writeJsonFile(this.filePath, all);
      }
      return value;
    });
  }

  async values(): Promise<T[]> {
    const all = await readJsonFile<Record<string, T>>(this.filePath, {});
    return Object.values(all);
  }

  /**
   * Drops every record for which `isExpired` returns true and rewrites the
   * file, through the same `serialized()` write queue every other mutation
   * uses -- so a sweep can never race a concurrent `claim()`/`set()` and
   * delete a record out from under a caller that is using it this instant.
   *
   * Returns the number of records removed, purely for logging; callers don't
   * need to do anything with a zero.
   */
  async sweepExpired(isExpired: (value: T) => boolean): Promise<number> {
    await ensureOAuthDir(this.configRoot);
    return serialized(this.filePath, async () => {
      const all = await readJsonFile<Record<string, T>>(this.filePath, {});
      let removed = 0;
      for (const [id, value] of Object.entries(all)) {
        if (isExpired(value)) {
          delete all[id];
          removed++;
        }
      }
      if (removed > 0) {
        await writeJsonFile(this.filePath, all);
      }
      return removed;
    });
  }
}
