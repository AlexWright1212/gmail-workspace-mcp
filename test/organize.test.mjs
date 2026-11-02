import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GmailAccountClient,
  MAX_MODIFY_IDS,
  describeGmailApiError,
  isRetryableGmailError,
  queryHasLabelIdCandidate,
  rewriteLabelIdsInQuery,
} from '../dist/gmail-client.js';
import {
  decodePageToken,
  encodePageToken,
  formatEmailItem,
  formatEmailListOutput,
  formatModifyResult,
  planPage,
} from '../dist/gmail-format.js';

// ── helpers ────────────────────────────────────────────────────────────────

const ACCOUNT = { id: 'personal', email: 'me@example.com', enabled: true };
const PATHS = { accountDir: '', credentialsPath: '', tokenPath: '', metaPath: '' };

/** The constructor is TS-private only; runtime construction is fine. */
function makeClient(gmail, account = ACCOUNT) {
  return Reflect.construct(GmailAccountClient, [account, PATHS, gmail, {}, {}, {}, {}]);
}

function apiError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.response = { status: code, data: { error: { code, message } } };
  return error;
}

/**
 * Fake Gmail that models the behaviour that caused the original bug:
 * batchModify accepts anything and reports nothing, unknown ids 404 on get.
 *
 * Faithfulness rules this fake must keep:
 *  - `batchModify` answers with an empty body ({data:{}}, i.e. HTTP 204) and
 *    SILENTLY IGNORES ids it cannot resolve — it never reports them.
 *  - `messages.get` 404s on an id Gmail has no message for.
 *  - `messages.list` returns ids newest-first, treats maxResults as an upper
 *    bound, and only returns a nextPageToken when more remain.
 *
 * Options that model failure modes:
 *  - `stubbornIds`: batchModify 204s for these but the change does not stick
 *    (the real "mutation accepted, label didn't land" case).
 *  - `getFailures`: id -> array of errors thrown by messages.get in order,
 *    then normal behaviour resumes. Models a transient 429 mid-read-back.
 */
function makeFakeGmail(store, options = {}) {
  const calls = {
    batchModify: 0,
    batchModifyIdCounts: [],
    get: 0,
    trash: 0,
    labelsList: 0,
    labelsGet: 0,
    labelsCreate: [],
    threadsGet: 0,
    list: [],
  };
  const stubborn = new Set(options.stubbornIds ?? []);
  const getFailures = new Map(
    Object.entries(options.getFailures ?? {}).map(([id, errors]) => [id, [...errors]])
  );

  return {
    calls,
    users: {
      messages: {
        async batchModify({ requestBody }) {
          calls.batchModify += 1;
          calls.batchModifyIdCounts.push(requestBody.ids.length);
          if (options.batchModifyError) throw options.batchModifyError;
          for (const id of requestBody.ids) {
            const message = store.get(id);
            if (!message) continue; // Gmail silently ignores unknown ids.
            if (stubborn.has(id)) continue; // 204, but nothing actually changed.
            const labels = new Set(message.labelIds);
            for (const label of requestBody.addLabelIds ?? []) labels.add(label);
            for (const label of requestBody.removeLabelIds ?? []) labels.delete(label);
            message.labelIds = [...labels];
          }
          return { data: {} };
        },
        async list({ q, maxResults, pageToken }) {
          calls.list.push({ q, maxResults, pageToken });
          if (options.listError) throw options.listError;
          const corpus = [...store.values()]
            .filter((m) => !options.queryFilter || options.queryFilter(m, q))
            .sort((a, b) => (b.internalDate ?? 0) - (a.internalDate ?? 0));
          const offset = pageToken ? Number(pageToken.replace('off:', '')) : 0;
          const slice = corpus.slice(offset, offset + maxResults);
          const nextOffset = offset + slice.length;
          return {
            data: {
              messages: slice.map((m) => ({ id: m.id, threadId: m.threadId })),
              resultSizeEstimate: corpus.length,
              ...(nextOffset < corpus.length ? { nextPageToken: `off:${nextOffset}` } : {}),
            },
          };
        },
        async get({ id, format }) {
          calls.get += 1;
          const queued = getFailures.get(id);
          if (queued && queued.length > 0) throw queued.shift();
          const message = store.get(id);
          if (!message) throw apiError(404, 'Requested entity was not found.');
          if (format === 'full') {
            return {
              data: {
                id,
                threadId: message.threadId,
                labelIds: [...message.labelIds],
                internalDate: String(message.internalDate ?? 0),
                snippet: message.snippet ?? '',
                payload: {
                  headers: [{ name: 'Subject', value: message.subject ?? id }],
                  mimeType: 'text/plain',
                },
              },
            };
          }
          return { data: { id, threadId: message.threadId, labelIds: [...message.labelIds] } };
        },
        async trash({ id }) {
          calls.trash += 1;
          const message = store.get(id);
          if (!message) throw apiError(404, 'Requested entity was not found.');
          message.labelIds = [...new Set([...message.labelIds, 'TRASH'])];
          return { data: { id, labelIds: [...message.labelIds] } };
        },
      },
      threads: {
        async get({ id }) {
          calls.threadsGet += 1;
          if (options.threadGetError) throw options.threadGetError;
          const messages = [...store.values()].filter((m) => m.threadId === id);
          if (messages.length === 0) throw apiError(404, 'Requested entity was not found.');
          return { data: { id, messages: messages.map((m) => ({ id: m.id })) } };
        },
        async modify({ id, requestBody }) {
          if (options.threadModifyError) throw options.threadModifyError;
          const messages = [...store.values()].filter((m) => m.threadId === id);
          for (const message of messages) {
            const labels = new Set(message.labelIds);
            for (const label of requestBody.addLabelIds ?? []) labels.add(label);
            for (const label of requestBody.removeLabelIds ?? []) labels.delete(label);
            message.labelIds = [...labels];
          }
          return {
            data: { id, messages: messages.map((m) => ({ id: m.id, labelIds: [...m.labelIds] })) },
          };
        },
      },
      labels: {
        async list() {
          calls.labelsList += 1;
          return { data: { labels: options.labels ?? [] } };
        },
        async get({ id }) {
          calls.labelsGet += 1;
          const found = (options.labelDetails ?? {})[id];
          if (!found) throw apiError(404, 'not found');
          return { data: found };
        },
        async create({ requestBody }) {
          calls.labelsCreate.push(requestBody.name);
          if ((options.existingLabelNames ?? []).includes(requestBody.name)) {
            throw apiError(409, 'Label name exists or conflicts');
          }
          return { data: { id: `Label_${requestBody.name}`, name: requestBody.name, type: 'user' } };
        },
      },
    },
  };
}

function makeStore(entries) {
  return new Map(entries.map((entry) => [entry.id, { ...entry, labelIds: [...entry.labelIds] }]));
}

// ── Defect 1: silent false success on nonexistent message ids ──────────────

test('addLabels reports only ids Gmail actually modified', async () => {
  const store = makeStore([
    { id: 'aaa', threadId: 'aaa', labelIds: ['INBOX'] },
    { id: 'bbb', threadId: 'zzz', labelIds: ['INBOX'] },
  ]);
  const gmail = makeFakeGmail(store);
  const client = makeClient(gmail);

  const result = await client.addLabels(['aaa', 'bbb', '0000000000000000'], ['Label_6']);

  assert.deepEqual(result.requested.sort(), ['0000000000000000', 'aaa', 'bbb']);
  assert.deepEqual(result.modified.sort(), ['aaa', 'bbb']);
  assert.deepEqual(result.notFound, ['0000000000000000']);
  assert.deepEqual(result.unverified, []);
});

test('addLabels on an all-bogus batch reports zero modified, not the input count', async () => {
  const client = makeClient(makeFakeGmail(makeStore([])));
  const result = await client.addLabels(['0000000000000000'], ['Label_6']);
  assert.equal(result.modified.length, 0);
  assert.deepEqual(result.notFound, ['0000000000000000']);
});

test('markAsRead verifies UNREAD is gone rather than assuming', async () => {
  const store = makeStore([{ id: 'aaa', threadId: 'aaa', labelIds: ['INBOX', 'UNREAD'] }]);
  const client = makeClient(makeFakeGmail(store));

  const result = await client.markAsRead(['aaa', '1111111111111111']);

  assert.deepEqual(result.modified, ['aaa']);
  assert.deepEqual(result.notFound, ['1111111111111111']);
  assert.ok(!store.get('aaa').labelIds.includes('UNREAD'));
});

test('archiveEmails verifies INBOX removal', async () => {
  const store = makeStore([{ id: 'aaa', threadId: 'aaa', labelIds: ['INBOX'] }]);
  const client = makeClient(makeFakeGmail(store));
  const result = await client.archiveEmails(['aaa', '0000000000000000']);
  assert.deepEqual(result.modified, ['aaa']);
  assert.deepEqual(result.notFound, ['0000000000000000']);
});

test('removeLabels verifies the label is actually gone', async () => {
  const store = makeStore([{ id: 'aaa', threadId: 'aaa', labelIds: ['INBOX', 'Label_6'] }]);
  const client = makeClient(makeFakeGmail(store));
  const result = await client.removeLabels(['aaa'], ['Label_6']);
  assert.deepEqual(result.modified, ['aaa']);
  assert.deepEqual(result.notFound, []);
});

test('trashEmails reports per-id outcome instead of the input count', async () => {
  const store = makeStore([{ id: 'aaa', threadId: 'aaa', labelIds: ['INBOX'] }]);
  const client = makeClient(makeFakeGmail(store));
  const result = await client.trashEmails(['aaa', '0000000000000000']);
  assert.deepEqual(result.modified, ['aaa']);
  assert.deepEqual(result.notFound, ['0000000000000000']);
});

test('a message id equal to its thread id is flagged as a possible thread-id mistake', async () => {
  const store = makeStore([
    { id: 'thread1', threadId: 'thread1', labelIds: [] },
    { id: 'msg2', threadId: 'thread1', labelIds: [] },
  ]);
  const client = makeClient(makeFakeGmail(store));
  const result = await client.addLabels(['thread1'], ['Label_6']);
  assert.deepEqual(result.threadIdLookalikes, ['thread1']);
  // Only the one message was touched — the sibling is untouched.
  assert.deepEqual(store.get('msg2').labelIds, []);
});

// ── P2: the thread-id warning must mean something ─────────────────────────

test('an ordinary single-message thread is NOT flagged as a thread-id mistake', async () => {
  // Every single-message thread has id === threadId, so the old check fired on
  // essentially every message and the warning became noise.
  const store = makeStore([{ id: 'solo', threadId: 'solo', labelIds: [] }]);
  const client = makeClient(makeFakeGmail(store));
  const result = await client.addLabels(['solo'], ['Label_6']);
  assert.deepEqual(result.modified, ['solo']);
  assert.deepEqual(result.threadIdLookalikes, []);
});

test('the thread-id check only costs a threads.get for actual candidates', async () => {
  const store = makeStore([
    { id: 'aaa', threadId: 'zzz', labelIds: [] },
    { id: 'bbb', threadId: 'yyy', labelIds: [] },
  ]);
  const gmail = makeFakeGmail(store);
  await makeClient(gmail).addLabels(['aaa', 'bbb'], ['Label_6']);
  assert.equal(gmail.calls.threadsGet, 0);
});

test('an unreadable thread keeps the warning rather than dropping it', async () => {
  const store = makeStore([{ id: 'solo', threadId: 'solo', labelIds: [] }]);
  const gmail = makeFakeGmail(store, { threadGetError: apiError(403, 'Forbidden') });
  const result = await makeClient(gmail).addLabels(['solo'], ['Label_6']);
  assert.deepEqual(result.threadIdLookalikes, ['solo']);
});

// ── P1: unverified means "unknown", and a rate limit must not fake one ────

test('a mutation Gmail accepts but does not apply is UNVERIFIED, not modified', async () => {
  // batchModify 204s, the read-back shows the label never landed.
  const store = makeStore([
    { id: 'aaa', threadId: 'zzz', labelIds: ['INBOX'] },
    { id: 'bbb', threadId: 'yyy', labelIds: ['INBOX'] },
  ]);
  const client = makeClient(makeFakeGmail(store, { stubbornIds: ['bbb'] }));

  const result = await client.addLabels(['aaa', 'bbb'], ['Label_6']);

  assert.deepEqual(result.modified, ['aaa']);
  assert.deepEqual(result.unverified, ['bbb']);
  assert.deepEqual(result.notFound, []);
  assert.ok(!store.get('bbb').labelIds.includes('Label_6'));
});

test('a non-404 error during read-back lands in unverified, not notFound', async () => {
  const store = makeStore([
    { id: 'aaa', threadId: 'zzz', labelIds: ['INBOX'] },
    { id: 'bbb', threadId: 'yyy', labelIds: ['INBOX'] },
  ]);
  const client = makeClient(
    makeFakeGmail(store, {
      // 403 is not retryable and is not a 404: the mutation may well have
      // landed (it did — see the store assertion below) but we cannot confirm.
      getFailures: { bbb: [apiError(403, 'Forbidden'), apiError(403, 'Forbidden')] },
    })
  );

  const result = await client.archiveEmails(['aaa', 'bbb']);

  assert.deepEqual(result.modified, ['aaa']);
  assert.deepEqual(result.unverified, ['bbb']);
  assert.deepEqual(result.notFound, []);
  // The archive DID succeed for bbb. Reporting it as failed would be a lie.
  assert.ok(!store.get('bbb').labelIds.includes('INBOX'));
});

test('a rate limit during read-back is retried, not reported as a failure', async () => {
  // The reproduced defect: archive succeeded for both, one 429 on the
  // verification get, and the tool reported bbb as unverified anyway.
  const store = makeStore([
    { id: 'aaa', threadId: 'zzz', labelIds: ['INBOX'] },
    { id: 'bbb', threadId: 'yyy', labelIds: ['INBOX'] },
  ]);
  const client = makeClient(
    makeFakeGmail(store, {
      getFailures: { bbb: [apiError(429, 'User-rate limit exceeded')] },
    })
  );

  const result = await client.archiveEmails(['aaa', 'bbb']);

  assert.deepEqual(result.modified.sort(), ['aaa', 'bbb']);
  assert.deepEqual(result.unverified, []);
  assert.deepEqual(store.get('aaa').labelIds, []);
  assert.deepEqual(store.get('bbb').labelIds, []);
});

test('a 5xx during read-back is retried too', async () => {
  const store = makeStore([{ id: 'aaa', threadId: 'zzz', labelIds: ['INBOX'] }]);
  const client = makeClient(
    makeFakeGmail(store, { getFailures: { aaa: [apiError(503, 'Backend Error')] } })
  );
  const result = await client.archiveEmails(['aaa']);
  assert.deepEqual(result.modified, ['aaa']);
});

test('a rate limit that never clears ends as unverified, never as failed', async () => {
  const store = makeStore([{ id: 'aaa', threadId: 'zzz', labelIds: ['INBOX'] }]);
  const client = makeClient(
    makeFakeGmail(store, {
      getFailures: {
        aaa: Array.from({ length: 6 }, () => apiError(429, 'User-rate limit exceeded')),
      },
    })
  );

  const result = await client.archiveEmails(['aaa']);
  assert.deepEqual(result.modified, []);
  assert.deepEqual(result.unverified, ['aaa']);
  assert.deepEqual(result.notFound, []);

  const text = formatModifyResult({
    verb: 'Archived (INBOX removed)',
    accountId: 'personal',
    result,
  });
  assert.match(text, /UNCONFIRMED/);
  assert.match(text, /not the same as failed/i);
  assert.ok(!/\bfailed\b/i.test(text.replace(/not the same as failed/i, '')));
});

test('retryable errors are classified, non-retryable ones are not', () => {
  assert.equal(isRetryableGmailError(apiError(429, 'User-rate limit exceeded')), true);
  assert.equal(isRetryableGmailError(apiError(500, 'Internal error')), true);
  assert.equal(isRetryableGmailError(apiError(503, 'Backend Error')), true);
  assert.equal(isRetryableGmailError(apiError(404, 'Not Found')), false);
  assert.equal(isRetryableGmailError(apiError(403, 'Forbidden')), false);
  assert.equal(isRetryableGmailError(apiError(401, 'invalid_grant')), false);
});

// ── P1: batch size is capped and chunked so the read-back cannot self-DoS ─

test('an over-large id batch is refused with a usable instruction', async () => {
  const client = makeClient(makeFakeGmail(makeStore([])));
  const ids = Array.from({ length: MAX_MODIFY_IDS + 1 }, (_, i) => `id${i}`);
  await assert.rejects(
    () => client.addLabels(ids, ['Label_6']),
    (error) => {
      assert.match(error.message, new RegExp(String(MAX_MODIFY_IDS)));
      assert.match(error.message, /split/i);
      return true;
    }
  );
  await assert.rejects(() => client.trashEmails(ids), /Split|split/);
});

test('a large but legal batch is chunked across batchModify requests', async () => {
  const entries = Array.from({ length: 150 }, (_, i) => ({
    id: `id${i}`,
    threadId: `th${i}`,
    labelIds: ['INBOX'],
  }));
  const gmail = makeFakeGmail(makeStore(entries));
  const result = await makeClient(gmail).archiveEmails(entries.map((e) => e.id));
  assert.equal(result.modified.length, 150);
  assert.deepEqual(gmail.calls.batchModifyIdCounts, [100, 50]);
  assert.ok(gmail.calls.batchModifyIdCounts.every((n) => n <= 100));
});

test('a bad label id surfaces an actionable error, not a raw Gmail 500', async () => {
  const client = makeClient(
    makeFakeGmail(makeStore([]), { batchModifyError: apiError(500, 'Internal error encountered.') })
  );
  await assert.rejects(
    () => client.addLabels(['aaa'], ['Label_999']),
    (error) => {
      assert.match(error.message, /Label_999/);
      assert.match(error.message, /label id/i);
      assert.match(error.message, /personal/);
      return true;
    }
  );
});

// ── Defect 4: thread-level labelling ───────────────────────────────────────

test('modifyThreadLabels labels every message in the conversation', async () => {
  const store = makeStore([
    { id: 'thread1', threadId: 'thread1', labelIds: [] },
    { id: 'msg2', threadId: 'thread1', labelIds: [] },
    { id: 'other', threadId: 'thread9', labelIds: [] },
  ]);
  const client = makeClient(makeFakeGmail(store));

  const result = await client.modifyThreadLabels('thread1', { addLabelIds: ['Label_6'] });

  assert.deepEqual(result.messageIds.sort(), ['msg2', 'thread1']);
  assert.deepEqual(result.modified.sort(), ['msg2', 'thread1']);
  assert.deepEqual(result.unverified, []);
  assert.deepEqual(store.get('other').labelIds, []);
});

test('modifyThreadLabels maps a rejected label to an actionable error', async () => {
  const client = makeClient(
    makeFakeGmail(makeStore([]), { threadModifyError: apiError(400, 'Invalid label: MUTE') })
  );
  await assert.rejects(
    () => client.modifyThreadLabels('t1', { addLabelIds: ['MUTE'] }),
    /MUTE/
  );
});

// ── Defect 10: mute must not claim success when Gmail rejects MUTE ─────────

test('tryNativeMuteThread reports failure instead of throwing or lying', async () => {
  const client = makeClient(
    makeFakeGmail(makeStore([]), { threadModifyError: apiError(400, 'Invalid label: MUTE') })
  );
  const result = await client.tryNativeMuteThread('t1');
  assert.equal(result.muted, false);
  assert.match(result.error, /MUTE/);
});

test('tryNativeMuteThread reports success when Gmail applies MUTE', async () => {
  const store = makeStore([{ id: 't1', threadId: 't1', labelIds: [] }]);
  const client = makeClient(makeFakeGmail(store));
  const result = await client.tryNativeMuteThread('t1');
  assert.equal(result.muted, true);
});

// ── Defect 5: label counts are never fabricated ───────────────────────────

test('getLabels leaves counts undefined when Gmail does not report them', async () => {
  const gmail = makeFakeGmail(makeStore([]), {
    labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }],
  });
  const labels = await makeClient(gmail).getLabels();
  assert.equal(labels[0].messagesTotal, undefined);
  assert.equal(gmail.calls.labelsGet, 0);
});

test('getLabels(includeCounts) fetches real counts per label', async () => {
  const gmail = makeFakeGmail(makeStore([]), {
    labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }],
    labelDetails: {
      INBOX: { id: 'INBOX', name: 'INBOX', messagesTotal: 31473, messagesUnread: 12, threadsTotal: 20000 },
    },
  });
  const labels = await makeClient(gmail).getLabels(true);
  assert.equal(labels[0].messagesTotal, 31473);
  assert.equal(labels[0].messagesUnread, 12);
  assert.equal(gmail.calls.labelsGet, 1);
});

// ── Defect 13: nested labels create their parents ─────────────────────────

test('createLabel creates missing parent labels before the leaf', async () => {
  const gmail = makeFakeGmail(makeStore([]), { labels: [] });
  const { label, createdParents } = await makeClient(gmail).createLabel('Work/Clients/Acme');
  assert.deepEqual(createdParents, ['Work', 'Work/Clients']);
  assert.equal(label.name, 'Work/Clients/Acme');
  assert.deepEqual(gmail.calls.labelsCreate, ['Work', 'Work/Clients', 'Work/Clients/Acme']);
});

test('createLabel skips parents that already exist', async () => {
  const gmail = makeFakeGmail(makeStore([]), {
    labels: [{ id: 'Label_1', name: 'Work', type: 'user' }],
  });
  const { createdParents } = await makeClient(gmail).createLabel('Work/Clients');
  assert.deepEqual(createdParents, []);
  assert.deepEqual(gmail.calls.labelsCreate, ['Work/Clients']);
});

// ── Defect 9: error mapping ───────────────────────────────────────────────

test('expired credentials name the account and the re-auth path that works', () => {
  const message = describeGmailApiError(apiError(401, 'invalid_grant'), 'fallback', {
    accountId: 'tamu',
    accountEmail: 'me@tamu.edu',
  });
  assert.match(message, /needs re-auth/i);
  assert.match(message, /tamu/);
  assert.match(message, /me@tamu\.edu/);
  // tools/reauth.mjs is the real path. begin_account_auth / finish_account_auth
  // are not listed on the mail endpoint (endpoints.json) and rejected before they run, so
  // naming them sent the caller into a dead end.
  assert.match(message, /tools\/reauth\.mjs tamu/);
  assert.ok(!/begin_account_auth|finish_account_auth/.test(message));
});

test('no user-facing Gmail error names a tool this server rejects', () => {
  const blocked = /begin_account_auth|finish_account_auth|get_all_attachments/;
  const contexts = [
    { accountId: 'personal' },
    {},
    { accountId: 'personal', labelIds: ['Label_bogus'] },
    { accountId: 'personal', messageIds: ['abc'] },
    { accountId: 'personal', threadId: 't1' },
  ];
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    for (const context of contexts) {
      const message = describeGmailApiError(
        apiError(status, status === 403 ? 'insufficient permission scope' : 'boom'),
        'fallback',
        context
      );
      assert.ok(!blocked.test(message), `HTTP ${status} names a blocked tool: ${message}`);
    }
  }
});

test('an insufficient-scope 403 also points at the script, not a blocked tool', () => {
  const message = describeGmailApiError(
    apiError(403, 'Request had insufficient authentication scopes.'),
    'fallback',
    { accountId: 'personal' }
  );
  assert.match(message, /tools\/reauth\.mjs/);
});

test('rate limiting is surfaced as a wait/retry condition', () => {
  const message = describeGmailApiError(apiError(429, 'User-rate limit exceeded'), 'fallback', {
    accountId: 'personal',
  });
  assert.match(message, /rate limit/i);
  assert.match(message, /retry/i);
});

test('a 500 with label ids points at the label ids', () => {
  const message = describeGmailApiError(apiError(500, 'Internal error encountered.'), 'fallback', {
    accountId: 'personal',
    labelIds: ['Label_bogus'],
  });
  assert.match(message, /Label_bogus/);
  assert.match(message, /display name/i);
});

test('a 404 explains that ids are per-account', () => {
  const message = describeGmailApiError(apiError(404, 'Not Found'), 'fallback', {
    accountId: 'personal',
    messageIds: ['0000000000000000'],
  });
  assert.match(message, /0000000000000000/);
  assert.match(message, /per-account/i);
});

// ── Defect 7: label ids in `label:` queries ───────────────────────────────

const LABEL_NAMES = new Map([
  ['Label_5459357416068177365', 'Cloudflare'],
  ['Label_8047751889411507926', 'BROH Internship'],
  ['Label_paren', 'paren(s)'],
  ['Label_brace', 'brace{x}'],
  ['Label_colon', 'colon:name'],
  ['Label_bracket', '[Notion]'],
  ['Label_neg', '-negative'],
  ['Label_quote', 'He said "hi"'],
  ['Label_slash', 'back\\slash'],
  ['Label_nested', 'Work/Clients'],
]);

const rewrite = (query) => rewriteLabelIdsInQuery(query, LABEL_NAMES);

test('a label id in a label: query is rewritten to its display name', () => {
  assert.deepEqual(rewrite('label:Label_5459357416068177365'), {
    query: 'label:Cloudflare',
    warnings: [],
  });
});

test('a display name containing spaces is quoted on rewrite', () => {
  assert.equal(
    rewrite('label:Label_8047751889411507926 newer_than:7d').query,
    'label:"BROH Internship" newer_than:7d'
  );
});

test('negated label ids are rewritten too', () => {
  assert.equal(rewrite('-label:Label_5459357416068177365').query, '-label:Cloudflare');
});

test('a nested label name keeps its slashes unquoted', () => {
  assert.deepEqual(rewrite('label:Label_nested'), { query: 'label:Work/Clients', warnings: [] });
});

test('unknown label ids and plain names are left untouched', () => {
  assert.equal(rewrite('label:Label_nope').query, 'label:Label_nope');
  assert.equal(rewrite('label:Cloudflare').query, 'label:Cloudflare');
  assert.equal(rewrite('from:a@b.com').query, 'from:a@b.com');
});

test('the label-map lookup is skipped for queries with no label id', () => {
  assert.equal(queryHasLabelIdCandidate('from:a@b.com is:unread'), false);
  assert.equal(queryHasLabelIdCandidate('label:Cloudflare'), false);
  assert.equal(queryHasLabelIdCandidate('label:Label_5'), true);
  // Regex is global; make sure state does not leak between calls.
  assert.equal(queryHasLabelIdCandidate('label:Label_5'), true);
});

// ── P1: the rewriter must not corrupt quoted phrases or mis-quote names ────

test('a label id inside a quoted phrase is NOT rewritten', () => {
  // The phrase is a literal the user is searching FOR. Rewriting inside it
  // silently changes what the search looks for.
  const result = rewrite('subject:"see label:Label_5459357416068177365 here"');
  assert.equal(result.query, 'subject:"see label:Label_5459357416068177365 here"');
  assert.deepEqual(result.warnings, []);
});

test('rewriting resumes after a quoted phrase closes', () => {
  assert.equal(
    rewrite('subject:"label:Label_nested" label:Label_5459357416068177365').query,
    'subject:"label:Label_nested" label:Cloudflare'
  );
});

test('an unterminated quote swallows the rest, as Gmail reads it', () => {
  assert.equal(
    rewrite('subject:"unclosed label:Label_5459357416068177365').query,
    'subject:"unclosed label:Label_5459357416068177365'
  );
});

test('a query with a label id only inside quotes needs no label lookup', () => {
  assert.equal(queryHasLabelIdCandidate('subject:"label:Label_5"'), false);
  assert.equal(queryHasLabelIdCandidate('subject:"label:Label_5" label:Label_9'), true);
});

test('a leading dash is still quoted, not refused', () => {
  // Confirmed live for `()`, `{}`, `[]`, `:` (docs/tickets/005) — a leading
  // `-` was never part of that test, so it keeps the old quote-and-hope
  // behavior rather than guessing it's also broken.
  assert.equal(rewrite('label:Label_neg').query, 'label:"-negative"');
});

test('names with Gmail grammar characters are refused and warned, never quote-and-hoped', () => {
  // Confirmed live against the real Gmail API (docs/tickets/005, 2026-09-15):
  // wrapping these in `"..."` does NOT work the way it does for a plain
  // space — the search silently matches zero even though the label has
  // messages. `(` `)` `{` `}` `[` `]` `:` must be refused, not quoted.
  for (const [labelId, name] of [
    ['Label_paren', 'paren(s)'],
    ['Label_brace', 'brace{x}'],
    ['Label_colon', 'colon:name'],
    ['Label_bracket', '[Notion]'],
  ]) {
    const result = rewrite(`label:${labelId}`);
    assert.equal(result.query, `label:${labelId}`);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes(JSON.stringify(name)));
    assert.match(result.warnings[0], /ZERO messages/);
  }
});

test('a label name Gmail cannot express is warned about, never mangled', () => {
  // The old code stripped the quotes and emitted label:"He said hi", which
  // matches no label at all and says nothing about it.
  const quoted = rewrite('label:Label_quote');
  assert.equal(quoted.query, 'label:Label_quote');
  assert.ok(!quoted.query.includes('He said hi'));
  assert.equal(quoted.warnings.length, 1);
  assert.match(quoted.warnings[0], /He said/);
  assert.match(quoted.warnings[0], /ZERO messages/);

  const slashed = rewrite('label:Label_slash');
  assert.equal(slashed.query, 'label:Label_slash');
  assert.equal(slashed.warnings.length, 1);
  assert.match(slashed.warnings[0], /backslash/i);
});

test('searchEmails carries the rewrite warning out to its caller', async () => {
  const store = makeStore([]);
  const gmail = makeFakeGmail(store, { labels: [{ id: 'Label_1', name: 'Real', type: 'user' }] });
  const page = await makeClient(gmail).searchEmails('label:Label_missing', 5);
  assert.equal(page.warnings.length, 1);
  assert.match(page.warnings[0], /^personal: /);
  assert.match(page.warnings[0], /Label_missing/);
  // The query still went to Gmail unrewritten rather than being silently altered.
  assert.equal(gmail.calls.list[0].q, 'label:Label_missing');
});

test('searchEmails rewrites a resolvable id and warns about nothing', async () => {
  const gmail = makeFakeGmail(makeStore([]), {
    labels: [{ id: 'Label_1', name: 'BROH Internship', type: 'user' }],
  });
  const page = await makeClient(gmail).searchEmails('label:Label_1 newer_than:7d', 5);
  assert.deepEqual(page.warnings, []);
  assert.equal(gmail.calls.list[0].q, 'label:"BROH Internship" newer_than:7d');
});

test('an unresolvable label id warns instead of silently matching nothing', () => {
  const result = rewrite('label:Label_nope newer_than:7d');
  assert.equal(result.query, 'label:Label_nope newer_than:7d');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Label_nope/);
  assert.match(result.warnings[0], /ZERO messages/);
  assert.match(result.warnings[0], /get_labels/);
});

// ── Defect 2 & 12: body truncation and attachment id placement ────────────

const SAMPLE_EMAIL = {
  id: 'm1',
  threadId: 't1',
  snippet: 'snippet',
  from: 'a@example.com',
  to: 'b@example.com',
  cc: '',
  subject: 'Subject',
  date: 'Sun, 9 Aug 2026 12:00:00 -0500',
  internalDate: 1,
  messageHeaderId: '<x@mail>',
  inReplyTo: '',
  references: '',
  body: 'X'.repeat(3000),
  labels: ['INBOX', 'UNREAD', 'Label_5'],
  labelNames: ['INBOX', 'UNREAD', 'Cloudflare'],
  attachments: [
    { id: 'A'.repeat(350), filename: 'doc.pdf', contentType: 'application/pdf', sizeBytes: 42, isInline: false },
  ],
  accountId: 'personal',
  accountEmail: 'me@example.com',
};

test('full body is reachable and truncation is announced with the real length', () => {
  const capped = formatEmailItem(SAMPLE_EMAIL, { includeBody: true, maxBodyChars: 600 });
  assert.match(capped, /truncated: showing 600 of 3000 characters/);

  const full = formatEmailItem(SAMPLE_EMAIL, { includeBody: true, maxBodyChars: 0 });
  assert.match(full, /complete, 3000 characters/);
  assert.ok(full.includes('X'.repeat(3000)));
});

test('attachment id blobs stay out of listings but appear on the read path', () => {
  const listing = formatEmailItem(SAMPLE_EMAIL, { includeBody: false, showAttachmentIds: false });
  assert.ok(!listing.includes('A'.repeat(350)));
  assert.match(listing, /doc\.pdf \(application\/pdf, 42 bytes\)/);

  const readPath = formatEmailItem(SAMPLE_EMAIL, { includeBody: false, showAttachmentIds: true });
  assert.ok(readPath.includes('A'.repeat(350)));
});

test('the attachment hint never points at a tool the server does not expose', () => {
  // the mail endpoint (endpoints.json) omits get_all_attachments, so the caller cannot invoke
  // it; the hint has to say so instead of sending them at a rejected call.
  const noTool = formatEmailItem(SAMPLE_EMAIL, { includeBody: false });
  assert.ok(!noTool.includes('get_all_attachments'));
  assert.match(noTool, /cannot be read through this server/i);

  const withTool = formatEmailItem(SAMPLE_EMAIL, {
    includeBody: false,
    attachmentReadTool: 'get_all_attachments',
  });
  assert.match(withTool, /call get_all_attachments with account="personal" email_id="m1"/);
});

// ── Defect 8: label state is visible on every result ──────────────────────

test('label ids and names are rendered on each result', () => {
  const rendered = formatEmailItem(SAMPLE_EMAIL, { includeBody: false });
  assert.match(rendered, /\*\*Labels\*\*: INBOX, UNREAD, Cloudflare/);
  assert.match(rendered, /\*\*Label IDs\*\*: INBOX, UNREAD, Label_5/);
});

// ── Defect 3: totals are Gmail's estimate, or explicitly unknown ──────────

test('the total is Gmail resultSizeEstimate, not the page size', () => {
  const output = formatEmailListOutput({
    title: 'Gmail Search Results',
    scopeText: 'account personal',
    queryText: 'in:sent',
    estimates: [{ accountId: 'personal', estimate: 201 }],
    returned: [SAMPLE_EMAIL],
    itemOptions: { includeBody: false },
    errors: [],
  });
  assert.match(output, /Estimated Total Matches\*\*: ~201/);
  assert.match(output, /\*\*Returned\*\*: 1/);
  assert.ok(!/Total Found/.test(output));
});

test('a missing estimate prints "unknown", never a fabricated number', () => {
  const output = formatEmailListOutput({
    title: 'Gmail Search Results',
    scopeText: 'account personal',
    queryText: 'x',
    estimates: [{ accountId: 'personal', estimate: undefined }],
    returned: [],
    itemOptions: { includeBody: false },
    errors: [],
  });
  assert.match(output, /Estimated Total Matches\*\*: unknown/);
});

test('per-account failures are shown up front, not buried', () => {
  const output = formatEmailListOutput({
    title: 'Gmail Search Results',
    scopeText: 'all enabled accounts (2)',
    queryText: 'x',
    estimates: [{ accountId: 'personal', estimate: 3 }],
    returned: [],
    itemOptions: { includeBody: false },
    errors: ['tamu: token needs re-auth'],
  });
  const bannerIndex = output.indexOf('INCOMPLETE');
  const scopeIndex = output.indexOf('**Scope**');
  assert.ok(bannerIndex > -1 && bannerIndex < scopeIndex);
  assert.match(output, /tamu: token needs re-auth/);
});

// ── Defect 6: pagination ──────────────────────────────────────────────────

test('a single-account page token round-trips as an opaque structured token', () => {
  const token = encodePageToken({ personal: { cursor: 'RAW_GMAIL_TOKEN' } });
  // It must NOT be the bare Gmail token: an aggregate token that happened to
  // hold one live cursor was indistinguishable from a single-account one, and
  // the decoder then dropped every other account back to page 1.
  assert.notEqual(token, 'RAW_GMAIL_TOKEN');
  assert.deepEqual(decodePageToken(token, ['personal']), { personal: { cursor: 'RAW_GMAIL_TOKEN' } });
});

test('an aggregate token keeps every account even when only one has a cursor', () => {
  // This is the exact P0 shape: tamu is finished, personal is on page 3.
  const token = encodePageToken({ personal: { cursor: 'P3' }, tamu: {} });
  const decoded = decodePageToken(token, ['personal', 'tamu']);
  assert.deepEqual(decoded, { personal: { cursor: 'P3' }, tamu: {} });
  // The old encoder returned the raw string 'P3' here, which the old decoder
  // then threw away entirely in multi-account mode.
  assert.notEqual(token, 'P3');
  assert.ok(Object.prototype.hasOwnProperty.call(decoded, 'tamu'));
});

test('a multi-account page token round-trips as one opaque string', () => {
  const token = encodePageToken({ personal: { cursor: 'AAA' }, tamu: { cursor: 'BBB' } });
  assert.notEqual(token, 'AAA');
  assert.deepEqual(decodePageToken(token, ['personal', 'tamu']), {
    personal: { cursor: 'AAA' },
    tamu: { cursor: 'BBB' },
  });
});

test('carry-over ids survive the round trip', () => {
  const token = encodePageToken({ personal: { carry: ['m1', 'm2'], estimate: 40 }, tamu: {} });
  assert.deepEqual(decodePageToken(token, ['personal', 'tamu']), {
    personal: { carry: ['m1', 'm2'], estimate: 40 },
    tamu: {},
  });
});

test('no cursors and no carry means no next page', () => {
  assert.equal(encodePageToken({}), undefined);
  assert.equal(encodePageToken({ personal: {}, tamu: {} }), undefined);
  assert.deepEqual(decodePageToken(undefined, ['personal']), {});
});

test('an account still holding carry-over keeps the token alive', () => {
  // "no more pages at Gmail" is not the same as "nothing left to show".
  assert.notEqual(encodePageToken({ personal: { carry: ['m9'] }, tamu: {} }), undefined);
  assert.notEqual(encodePageToken({ personal: { restart: true }, tamu: {} }), undefined);
});

// ── P0-1: a token that cannot be trusted must FAIL, not restart silently ──

test('a garbage page token is rejected instead of silently restarting', () => {
  assert.throws(
    () => decodePageToken('!!!!not-base64!!!!', ['personal']),
    (error) => {
      assert.match(error.message, /not a valid token issued by this server|did not decode/);
      assert.match(error.message, /page_token/);
      return true;
    }
  );
});

test('a raw Gmail token is no longer forwarded verbatim to Gmail', () => {
  // The old single-account path passed this straight through and the caller
  // got an opaque Gmail 400 back with no explanation.
  assert.throws(() => decodePageToken('CJDX0aX1s-4CEJDX0aX1s-4C', ['personal']), /page_token/);
});

test('a token naming accounts that are not in scope is rejected by name', () => {
  const foreign = Buffer.from(
    JSON.stringify({ v: 2, a: { ghost: { cursor: 'x' }, other: { cursor: 'y' } } }),
    'utf8'
  ).toString('base64url');
  assert.throws(
    () => decodePageToken(foreign, ['personal', 'tamu']),
    (error) => {
      assert.match(error.message, /ghost/);
      assert.match(error.message, /personal/);
      return true;
    }
  );
});

test('reusing an aggregate token with a narrowed account scope is rejected', () => {
  const token = encodePageToken({ personal: { cursor: 'P3' }, tamu: {} });
  assert.throws(() => decodePageToken(token, ['personal']), /tamu/);
});

test('a structurally wrong token is rejected rather than half-read', () => {
  const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  assert.throws(() => decodePageToken(b64({ v: 1, a: { personal: {} } }), ['personal']), /version/);
  assert.throws(() => decodePageToken(b64({ v: 2 }), ['personal']), /per-account positions/);
  assert.throws(() => decodePageToken(b64({ v: 2, a: { personal: 'raw' } }), ['personal']), /malformed/);
  assert.throws(
    () => decodePageToken(b64({ v: 2, a: { personal: { cursor: 7 } } }), ['personal']),
    /non-string/
  );
  assert.throws(
    () => decodePageToken(b64({ v: 2, a: { personal: { carry: [1, 2] } } }), ['personal']),
    /carry-over/
  );
});

// ── P0-2: the merge must not fetch results and then throw them away ───────

const email = (accountId, id, internalDate) => ({
  id,
  threadId: id,
  snippet: '',
  from: '',
  to: '',
  cc: '',
  subject: id,
  date: '',
  internalDate,
  messageHeaderId: '',
  inReplyTo: '',
  references: '',
  labels: [],
  attachments: [],
  accountId,
  accountEmail: `${accountId}@example.com`,
});

test('planPage carries every fetched-but-unreturned id into the next token', () => {
  const { returned, nextStates } = planPage(
    [
      {
        accountId: 'personal',
        candidates: [90, 80, 70, 60, 50].map((d, i) => email('personal', `p${i}`, d)),
        cursor: undefined,
      },
      {
        accountId: 'tamu',
        candidates: [45, 44, 43, 42, 41].map((d, i) => email('tamu', `t${i}`, d)),
        cursor: undefined,
      },
    ],
    5
  );

  assert.deepEqual(returned.map((m) => m.id), ['p0', 'p1', 'p2', 'p3', 'p4']);
  // The old code dropped t0..t4 on the floor and then reported "no more".
  assert.deepEqual(nextStates.tamu.carry, ['t0', 't1', 't2', 't3', 't4']);
  assert.equal(nextStates.personal.carry, undefined);
  assert.notEqual(encodePageToken(nextStates), undefined);
});

test('a failed account keeps its position instead of being read as finished', () => {
  const { nextStates } = planPage(
    [
      { accountId: 'personal', candidates: [email('personal', 'p0', 90)], cursor: 'P2' },
      { accountId: 'tamu', candidates: [], failedWithState: { cursor: 'T7' } },
    ],
    5
  );
  assert.deepEqual(nextStates.tamu, { cursor: 'T7' });
  assert.notEqual(encodePageToken(nextStates), undefined);
});

test('a page that fully drains both accounts ends the token', () => {
  const { returned, nextStates } = planPage(
    [
      { accountId: 'personal', candidates: [email('personal', 'p0', 90)], cursor: undefined },
      { accountId: 'tamu', candidates: [email('tamu', 't0', 80)], cursor: undefined },
    ],
    10
  );
  assert.equal(returned.length, 2);
  assert.equal(encodePageToken(nextStates), undefined);
});

test('paging a two-account search delivers every match exactly once', async () => {
  // 7 messages in one inbox, 5 in the other, 4 per page. Any id appearing on
  // two pages, or missing from all of them, is the bug this guards.
  const personalStore = makeStore(
    Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`,
      threadId: `p${i}`,
      labelIds: [],
      internalDate: 1000 - i * 10,
    }))
  );
  const tamuStore = makeStore(
    Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      threadId: `t${i}`,
      labelIds: [],
      internalDate: 995 - i * 10,
    }))
  );

  const clients = {
    personal: makeClient(makeFakeGmail(personalStore), ACCOUNT),
    tamu: makeClient(makeFakeGmail(tamuStore), { id: 'tamu', email: 'me@tamu.edu', enabled: true }),
  };
  const accountIds = ['personal', 'tamu'];
  const maxResults = 4;

  const seen = [];
  let token;
  for (let page = 0; page < 20; page += 1) {
    const states = decodePageToken(token, accountIds);
    const candidates = await Promise.all(
      accountIds.map(async (accountId) => {
        const result = await clients[accountId].searchEmails('x', maxResults, states[accountId]);
        return {
          accountId,
          candidates: result.messages,
          cursor: result.nextPageToken,
          estimate: result.resultSizeEstimate,
        };
      })
    );
    const { returned, nextStates } = planPage(candidates, maxResults);
    seen.push(...returned.map((m) => `${m.accountId}:${m.id}`));
    token = encodePageToken(nextStates);
    if (!token) break;
    assert.ok(returned.length > 0, 'a page that returns nothing must not offer a next token');
  }

  assert.equal(token, undefined, 'paging must terminate');
  assert.equal(new Set(seen).size, seen.length, `duplicate ids across pages: ${seen.join(', ')}`);
  assert.equal(seen.length, 12, `expected all 12 matches, got ${seen.length}`);
  assert.deepEqual(
    [...seen].sort(),
    [
      ...Array.from({ length: 7 }, (_, i) => `personal:p${i}`),
      ...Array.from({ length: 5 }, (_, i) => `tamu:t${i}`),
    ].sort()
  );
});

test('carried-over ids do not cost extra fetches on the next page', async () => {
  const store = makeStore(
    Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      threadId: `m${i}`,
      labelIds: [],
      internalDate: 100 - i,
    }))
  );
  const gmail = makeFakeGmail(store);
  const client = makeClient(gmail);

  const first = await client.searchEmails('x', 4, undefined);
  assert.deepEqual(first.messages.map((m) => m.id), ['m0', 'm1', 'm2', 'm3']);

  // Pretend the merge only had room for two of them.
  const second = await client.searchEmails('x', 4, {
    cursor: first.nextPageToken,
    carry: ['m2', 'm3'],
  });
  assert.deepEqual(second.messages.map((m) => m.id), ['m2', 'm3', 'm4', 'm5']);
  // Only the 2 missing slots were listed, so the page never exceeds its budget.
  assert.equal(gmail.calls.list.at(-1).maxResults, 2);
});

test('an account with a full carry buffer does not touch Gmail list at all', async () => {
  const store = makeStore([
    { id: 'm0', threadId: 'm0', labelIds: [], internalDate: 10 },
    { id: 'm1', threadId: 'm1', labelIds: [], internalDate: 9 },
  ]);
  const gmail = makeFakeGmail(store);
  const client = makeClient(gmail);
  const page = await client.searchEmails('x', 2, { cursor: 'off:5', carry: ['m0', 'm1'] });
  assert.deepEqual(page.messages.map((m) => m.id), ['m0', 'm1']);
  assert.equal(gmail.calls.list.length, 0);
  // The unconsumed cursor is handed straight back, not lost.
  assert.equal(page.nextPageToken, 'off:5');
});

test('an exhausted account is not restarted on a later page', async () => {
  const store = makeStore([{ id: 'm0', threadId: 'm0', labelIds: [], internalDate: 10 }]);
  const gmail = makeFakeGmail(store);
  const client = makeClient(gmail);
  // {} = "this account finished". It must NOT be treated as page 1.
  const page = await client.searchEmails('x', 5, {});
  assert.deepEqual(page.messages, []);
  assert.equal(gmail.calls.list.length, 0);
});

test('next page token and "more available" are surfaced', () => {
  const output = formatEmailListOutput({
    title: 'x',
    scopeText: 'account personal',
    queryText: 'x',
    estimates: [{ accountId: 'personal', estimate: 500 }],
    returned: [],
    itemOptions: { includeBody: false },
    nextPageToken: 'TOK',
    errors: [],
  });
  assert.match(output, /\*\*More Results Available\*\*: yes/);
  assert.match(output, /\*\*Next Page Token\*\*: TOK/);
});

test('"no more results" is only claimed when nothing was withheld', () => {
  const output = formatEmailListOutput({
    title: 'x',
    scopeText: 'all enabled accounts (2)',
    queryText: 'x',
    estimates: [{ accountId: 'personal', estimate: 5 }],
    returned: [],
    itemOptions: { includeBody: false },
    errors: [],
  });
  assert.match(output, /\*\*More Results Available\*\*: no —/);
  assert.match(output, /nothing fetched was withheld/);
});

test('"no more results" is not claimed outright when an account failed', () => {
  const output = formatEmailListOutput({
    title: 'x',
    scopeText: 'all enabled accounts (2)',
    queryText: 'x',
    estimates: [{ accountId: 'personal', estimate: 5 }],
    returned: [],
    itemOptions: { includeBody: false },
    errors: ['tamu: token needs re-auth'],
  });
  assert.match(output, /NOT a complete result set/);
});

test('query warnings are surfaced above the results, not swallowed', () => {
  const output = formatEmailListOutput({
    title: 'x',
    scopeText: 'account personal',
    queryText: 'label:Label_nope',
    estimates: [{ accountId: 'personal', estimate: 0 }],
    returned: [],
    itemOptions: { includeBody: false },
    errors: [],
    warnings: ['personal: `label:Label_nope` matches ZERO messages'],
  });
  const warnIndex = output.indexOf('Query warnings');
  assert.ok(warnIndex > -1 && warnIndex < output.indexOf('**Scope**'));
  assert.match(output, /Label_nope/);
});

// ── Reporting ─────────────────────────────────────────────────────────────

test('a partial modify reports the verified count and names the failures', () => {
  const text = formatModifyResult({
    verb: 'Added label(s)',
    accountId: 'personal',
    result: {
      requested: ['a', 'b', 'c', '0000000000000000'],
      modified: ['a', 'b', 'c'],
      notFound: ['0000000000000000'],
      unverified: [],
      threadIdLookalikes: [],
    },
  });
  assert.match(text, /3 of 4 message\(s\) verified/);
  assert.match(text, /1 not found/);
  assert.match(text, /0000000000000000/);
  assert.ok(text.startsWith('⚠️'));
});

test('a fully successful modify still reports the verified count', () => {
  const text = formatModifyResult({
    verb: 'Archived (INBOX removed)',
    accountId: 'personal',
    result: { requested: ['a'], modified: ['a'], notFound: [], unverified: [], threadIdLookalikes: [] },
  });
  assert.ok(text.startsWith('✅'));
  assert.match(text, /1 of 1 message\(s\) verified/);
});
