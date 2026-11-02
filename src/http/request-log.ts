/**
 * Append-only, per-request log for `/mcp`: which authenticated client made a
 * request, how it authenticated, what scopes it held, and what the server
 * answered.
 *
 * This is what makes revocation targeted rather than global (Phase 3, Task A
 * of docs/plans/001-remote-access-migration.md): today the server has no
 * record of WHICH authorized OAuth client did what, so "turn off the
 * compromised/unwanted client" means either guessing or nuking everyone.
 * `scripts/clients.sh list` reads this file (best-effort, see its own
 * comments) to show a client's last-seen time.
 *
 * Same idiom as src/allowlist.ts's appendAudit: one JSON line per event,
 * appended to a file that lives under configRoot as a sibling of
 * send-audit.log, with the exact same failure behaviour -- a write failure
 * is logged to stderr and otherwise swallowed, never thrown into the request
 * path. Logging is forensics, not a gate; an unwritable disk must not turn
 * into an outage on every /mcp call. No rotation and no reaping: matches
 * send-audit.log's own choice, and is a deliberate, named simplification --
 * see the Phase 3 build report for the growth trade-off this leaves on the
 * table.
 *
 * DURABILITY -- why this is a queue, not a fire-and-forget `void append()`
 * (which is what this file originally did, and which lost lines under real
 * concurrent load): logging happens on `res.on('finish')`, deliberately
 * AFTER the response has already been sent, so a slow disk can never delay
 * an actual reply. But nothing was ever waiting for that write to land
 * either -- not the request, not shutdown, nothing. Two real, distinct
 * consequences followed from that, found by re-running the full suite
 * repeatedly rather than trusting one green run:
 *
 *  1. Under full-suite concurrency (many test files competing for the same
 *     default libuv threadpool), a write's completion could lag behind the
 *     test's own continuation after the HTTP response was received --
 *     `test/request-log.test.mjs`'s GET/DELETE test flaked at roughly a 1-in-4
 *     rate this way, always losing the LAST line written before the process
 *     moved on to read the file back.
 *  2. The identical shape of bug is live in production: `pm2 restart`
 *     (which happens on every deploy) sends SIGTERM; `runSseServer`'s
 *     handler awaits `running.close()` and then calls `process.exit(0)`.
 *     A write still in flight -- queued on the threadpool, not yet flushed
 *     -- when that exit happens is not delayed, it is gone. This is a real
 *     loss window, not a test artefact, and it is the one that actually
 *     matters: an accountability log that can silently drop the very last
 *     thing a client did is a materially weaker tool for "which client did
 *     this?" than one that can't.
 *
 * Fixed the same way src/http/oauth/store.ts's JsonRecordStore already
 * solves an equivalent problem (its `serialized()` per-file promise chain):
 * every write chains onto a single per-instance `tail` promise, so writes to
 * the SAME file are strictly ordered and never issued concurrently against
 * each other, and `flush()` lets a caller await "every write requested so
 * far has settled" without polling or sleeping. `startHttpServer`'s
 * shutdown path calls it after the HTTP server has stopped accepting new
 * connections and drained any in-flight ones, which is what makes both the
 * test and a real `pm2 restart` deterministic: nothing can exit while a
 * write this module accepted is still unresolved.
 *
 * This does NOT add fsync-level durability against a hard crash (`kill -9`,
 * OOM, a power loss) between the OS accepting the write and it actually
 * hitting the platter -- that is the same residual risk send-audit.log
 * already accepts today, and adding it here would be a heavier guarantee
 * than the rest of this codebase makes for a personal-scale, single-process
 * server. What this DOES close is the much more common case: an orderly
 * shutdown, which is what every deploy actually triggers.
 *
 * Concurrent writers were also directly measured, not assumed: 100
 * unserialized concurrent `fs.appendFile` calls to one file, small
 * newline-terminated JSON lines, produced zero corrupted/interleaved lines
 * (POSIX `O_APPEND` is atomic per single `write()` syscall at this size).
 * The bug this file fixes was never corruption -- it was loss from nothing
 * ever waiting for the write. The serialized queue is adopted anyway,
 * matching this codebase's own established pattern rather than leaning on
 * that OS-level atomicity guarantee as the only thing standing between this
 * log and a garbled line.
 *
 * SECRETS -- what this file must NEVER contain: a token value, an
 * authorization code, a `code_verifier`/`code_challenge`, a client secret, or
 * an SSE session id (docs/plans/001 explains why a session id specifically is
 * dangerous -- it travels in a query string and would reach any intermediary
 * that logs full URLs, e.g. Cloudflare). Client *ids* are not secret --
 * they're the whole point of DCR being open (ADR 013) and of this log's
 * existence -- so they ARE recorded. Every field written below is drawn
 * either from `AuthInfo` (already-validated token metadata, never the raw
 * token) or from plain HTTP request/response metadata (method, path, status).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Request, RequestHandler, Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export const REQUEST_LOG_FILENAME = 'request-log.log';

/**
 * `'bearer'` is retained ONLY so entries written before Phase 4 (which deleted
 * the shared bearer token) still parse -- nothing writes it any more.
 * `'unknown'` means the /mcp gate let a request through without setting
 * `req.auth`, which since Phase 4 should be impossible: it is a bug signal, not
 * a normal state, and is recorded rather than papered over as 'oauth'.
 */
export type AuthMethod = 'oauth' | 'bearer' | 'unknown';

export interface RequestLogEntry {
  /** ISO 8601, UTC (Date#toISOString is always UTC). */
  at: string;
  /**
   * Since Phase 4 every authenticated /mcp request is OAuth-authenticated, so
   * this is a real, revokable client id in practice. `null` remains possible
   * for pre-Phase-4 entries (the shared bearer token had no client identity)
   * and for an `authMethod: 'unknown'` line. Never a synthetic placeholder
   * string; `null` so a consumer can't mistake it for a real client id.
   */
  clientId: string | null;
  authMethod: AuthMethod;
  scopes: string[];
  method: string;
  path: string;
  status: number;
  /**
   * JSON-RPC method(s) this HTTP request carried, e.g. `"initialize"`,
   * `"tools/list"`, or `"tools/call:send_message"` for a tool call
   * specifically (method + tool name, joined, so a revocation decision can
   * see not just "this client called something" but "this client tried to
   * send mail"). Sourced ONLY from JSONRPCMessage objects the SDK's
   * Streamable HTTP transport has already parsed and handed to
   * `transport.onmessage` (see the hook in transports.ts) -- this module
   * never reads or re-parses the request body itself. Empty when no
   * JSON-RPC message was ever parsed for this request (e.g. the GET/DELETE
   * /mcp 405 responses, which the transport never touches).
   */
  rpc: string[];
}

/**
 * One promise-chain write queue per log file, same shape as
 * oauth/store.ts's `serialized()`. A module-level map rather than one chain
 * per `createRequestLog()` call so that two independently-constructed
 * middlewares pointed at the same path (shouldn't normally happen, but
 * costs nothing to guard) still can't race each other.
 */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Enqueues one line onto the write queue for `logPath` and returns the
 * promise representing "every write enqueued for this file so far,
 * including this one, has settled" -- this is what `flush()` hands back to
 * a caller, and what makes waiting for it equivalent to waiting for the
 * whole queue, not just this one entry.
 */
// `mode` applies only when appendFile CREATES the file, which is the one
// moment it matters: this log records which client drove which tool call,
// so it sits alongside send-audit.log (0600) rather than accounts.json
// (0644). An existing file's mode is left alone -- chmod is deployment's
// job, not the request path's.
function enqueueRequestLogWrite(logPath: string, entry: RequestLogEntry): Promise<void> {
  const line = JSON.stringify(entry);
  const prior = writeQueues.get(logPath) ?? Promise.resolve();
  const run = prior.then(
    () => fs.appendFile(logPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 }),
    () => fs.appendFile(logPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 }),
  );
  // A write failure must never wedge every later write queued behind it --
  // swallow so the chain keeps moving, exactly like store.ts's serialized().
  // The actual failure is still handled (logged) below, off `run` itself.
  const settled = run.catch((err: unknown) => {
    console.error(`[request-log] WRITE FAILED (${(err as Error).message}) for: ${line}`);
  });
  writeQueues.set(logPath, settled);
  return settled;
}

/**
 * The key `res.locals` is stashed under. Deliberately not exported as a
 * bare string constant used elsewhere -- `recordRpcEvent`/`readRpcEvents`
 * are the only sanctioned way to touch it, so the storage detail can change
 * without hunting down every call site.
 */
const RPC_EVENTS_LOCALS_KEY = 'gmailMcpRpcEvents';

/**
 * Called from transports.ts's onmessage hook, once per JSON-RPC message a
 * single `/mcp` POST carries (a batch can contain more than one). Safe to
 * call even when no request-log middleware is mounted -- it just writes into
 * `res.locals`, which is per-request and already garbage-collected with the
 * response either way.
 */
export function recordRpcEvent(res: Response, event: string): void {
  const events = (res.locals[RPC_EVENTS_LOCALS_KEY] as string[] | undefined) ?? [];
  events.push(event);
  res.locals[RPC_EVENTS_LOCALS_KEY] = events;
}

function readRpcEvents(res: Response): string[] {
  return (res.locals[RPC_EVENTS_LOCALS_KEY] as string[] | undefined) ?? [];
}

export interface RequestLogOptions {
  configRoot: string;
  /** Overridable only for tests; production always uses the real log file. */
  logPath?: string;
  /** Overridable only for tests, to pin the timestamp. */
  now?: () => Date;
}

export interface RequestLog {
  /**
   * Mount on `/mcp` AFTER the auth gate (`createMcpAuthGate`), never before
   * -- the gate is what populates `req.auth` for an OAuth-authenticated
   * request. Since Phase 4 OAuth is the only accepted credential, so a
   * request arriving here without `req.auth` is a gate bug and is logged as
   * `authMethod: 'unknown'`.
   * Because the gate calls `next()` only once a request is actually
   * authenticated, mounting this middleware after it for free gives "log
   * per AUTHENTICATED request" -- an unauthenticated attempt 401s at the
   * gate and never reaches here, so it never appears in this log.
   *
   * Logs on `res.on('finish')` rather than synchronously, so the recorded
   * `status` is the response Express actually sent, not a guess made
   * before the handler ran. The actual write is enqueued, not awaited, by
   * design -- see `flush()`.
   */
  middleware: RequestHandler;
  /**
   * Resolves once every write enqueued so far for this log's file has
   * settled -- successfully, or as an already-logged, already-swallowed
   * failure (this never rejects; a write failure must not be able to break
   * whatever is waiting on shutdown). `startHttpServer`'s `close()` calls
   * this AFTER the underlying HTTP server has stopped accepting connections
   * and drained whatever was in flight, which is what makes both a test's
   * `running.close()` and a real `pm2 restart`'s SIGTERM handler
   * deterministic: nothing that calls this can move on, and no process can
   * exit, while a write this module accepted is still unresolved. See this
   * file's module doc comment for the concrete loss this closes.
   */
  flush(): Promise<void>;
}

export function createRequestLog(options: RequestLogOptions): RequestLog {
  const logPath = options.logPath ?? path.join(options.configRoot, REQUEST_LOG_FILENAME);
  const now = options.now ?? ((): Date => new Date());

  const middleware: RequestHandler = (req: Request, res: Response, next: () => void): void => {
    res.on('finish', () => {
      // A logging failure here (a bad entry shape, a throw from a hostile
      // getter on req.auth, whatever) must never be allowed to surface after
      // the response has already been sent -- there is nothing left to
      // protect at that point except the process itself.
      try {
        const authInfo = req.auth as AuthInfo | undefined;
        const entry: RequestLogEntry = {
          at: now().toISOString(),
          clientId: authInfo?.clientId ?? null,
          authMethod: authInfo ? 'oauth' : 'unknown',
          scopes: authInfo?.scopes ?? [],
          method: req.method,
          path: req.path,
          status: res.statusCode,
          rpc: readRpcEvents(res),
        };
        enqueueRequestLogWrite(logPath, entry);
      } catch (err) {
        console.error(`[request-log] failed to build log entry: ${(err as Error).message}`);
      }
    });
    next();
  };

  return {
    middleware,
    // Reads the CURRENT tail of this path's write queue at call time, not a
    // value captured once -- so it always reflects every write enqueued up
    // to the moment flush() is actually invoked, including ones enqueued by
    // requests that finished between construction and shutdown.
    flush: (): Promise<void> => writeQueues.get(logPath) ?? Promise.resolve(),
  };
}
