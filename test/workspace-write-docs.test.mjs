// Plan 002 Phase 4 (unit B): the Docs WRITE tool handlers, driven with a
// fake GmailAccountClient (rawApis().docs / .drive) so assertions are about
// (a) exactly what was sent to Google -- every request carries tabId,
// writeControl.requiredRevisionId is set from the doc just fetched, and a
// refusal never reaches batchUpdate -- and (b) what the tool printed from
// the fake response. Real Google state is the live harness's job
// (tools/live/workspace-check.mjs), not this file's.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handlers as docs,
  createDocTool,
  appendDocTextTool,
  replaceDocTextTool,
  insertDocTextTool,
} from '../dist/tools/docs.js';

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
const REPORTS = []; // every successful report's text, for the no-index scan at the bottom
const record = (t) => { REPORTS.push(t); return t; };

// ─── Fixture builder -- real Google index numbering, computed not guessed ──
// Each paragraph's start is the previous one's endIndex (body content starts
// at index 1); its own endIndex is one past its trailing newline -- exactly
// how src/docs/tabs.ts / anchors.ts expect a documents.get response to look.
function paraEl(text_, start, extra = {}) {
  const full = `${text_}\n`;
  const end = start + full.length;
  return { startIndex: start, endIndex: end, paragraph: { elements: [{ startIndex: start, endIndex: end, textRun: { content: full } }], ...extra } };
}

// ─── Single-tab fixture: Overview (H1) / a body paragraph / Conclusion (H2, last) ──
const OVERVIEW_TEXT = 'Overview';
const BODY_TEXT = 'First paragraph of the tab.';
const CONCLUSION_TEXT = 'Conclusion';

const P1 = paraEl(OVERVIEW_TEXT, 1, { paragraphStyle: { namedStyleType: 'HEADING_1' } });
const P2 = paraEl(BODY_TEXT, P1.endIndex);
const P3 = paraEl(CONCLUSION_TEXT, P2.endIndex, { paragraphStyle: { namedStyleType: 'HEADING_2' } });

// The exact document-space range of "paragraph" inside P2's text, computed
// (not hand-counted) from the same offset findText itself would produce.
const ANCHOR_WORD = 'paragraph';
const ANCHOR_OFFSET = BODY_TEXT.indexOf(ANCHOR_WORD);
const ANCHOR_START = P2.startIndex + ANCHOR_OFFSET;
const ANCHOR_END = ANCHOR_START + ANCHOR_WORD.length;

function soloDocBefore(revisionId = 'rev-solo-1') {
  return {
    documentId: 'D1',
    title: 'Solo Doc',
    revisionId,
    tabs: [{ tabProperties: { tabId: 't.0', title: 'Only Tab' }, documentTab: { body: { content: [P1, P2, P3] } } }],
  };
}

/** A post-edit document whose only tab's body is exactly `content` -- used as
 * the SECOND `documents.get` response so the handler's report comes from the
 * re-fetch, never from the request args. */
function soloDocAfter(content, revisionId = 'rev-solo-2') {
  return {
    documentId: 'D1',
    title: 'Solo Doc',
    revisionId,
    tabs: [{ tabProperties: { tabId: 't.0', title: 'Only Tab' }, documentTab: { body: { content } } }],
  };
}

// ─── Two-tab fixture, for THE TAB RULE ──────────────────────────────────────
// Both tabs' single paragraph shares "marker text" so the same anchor_text
// resolves (unambiguously, within whichever tab is selected) regardless of
// which tab THE TAB RULE picks.
const ALPHA_P = paraEl('Alpha marker text.', 1);
const BETA_P = paraEl('Beta marker text.', 1);
function twoTabDoc(revisionId = 'rev-two-1') {
  return {
    documentId: 'D2',
    title: 'Two Tab Doc',
    revisionId,
    tabs: [
      { tabProperties: { tabId: 't.a', title: 'Alpha' }, documentTab: { body: { content: [ALPHA_P] } } },
      { tabProperties: { tabId: 't.b', title: 'Beta' }, documentTab: { body: { content: [BETA_P] } } },
    ],
  };
}
function twoTabDocAfter(tabId, content, revisionId = 'rev-two-2') {
  const other = tabId === 't.a' ? { tabProperties: { tabId: 't.b', title: 'Beta' }, documentTab: { body: { content: [BETA_P] } } }
    : { tabProperties: { tabId: 't.a', title: 'Alpha' }, documentTab: { body: { content: [ALPHA_P] } } };
  const mine = { tabProperties: { tabId, title: tabId === 't.a' ? 'Alpha' : 'Beta' }, documentTab: { body: { content } } };
  return { documentId: 'D2', title: 'Two Tab Doc', revisionId, tabs: tabId === 't.a' ? [mine, other] : [other, mine] };
}

// ─── Fake googleapis handles ────────────────────────────────────────────────

function fakeDocsApi(getSequence, batchUpdateResponse = {}) {
  const calls = { gets: [], batchUpdates: [] };
  let i = 0;
  const api = {
    documents: {
      get: async (params) => {
        calls.gets.push(params);
        const doc = getSequence[Math.min(i, getSequence.length - 1)];
        i++;
        return { data: doc };
      },
      batchUpdate: async (params) => {
        calls.batchUpdates.push(params);
        return { data: batchUpdateResponse };
      },
      create: async () => { throw new Error('documents.create must not be called from a raw-api write path'); },
    },
  };
  return { api, calls };
}

function fakeDriveApi({ currentParents = ['OLD_PARENT'] } = {}) {
  const calls = { gets: [], updates: [] };
  const api = {
    files: {
      get: async (params) => {
        calls.gets.push(params);
        // First get() returns current parents; the read-back after update returns the new ones.
        const afterUpdate = calls.updates.length > 0;
        return { data: { parents: afterUpdate ? ['NEW_FOLDER'] : currentParents } };
      },
      update: async (params) => {
        calls.updates.push(params);
        return { data: { id: params.fileId } };
      },
    },
  };
  return { api, calls };
}

function makeClient({ docsApi, driveApi, createDocumentResult }) {
  return {
    rawApis: () => ({ docs: docsApi, drive: driveApi }),
    createDocument: async (title) => createDocumentResult ?? { documentId: 'NEWDOC', url: 'https://docs.google.com/document/d/NEWDOC/edit' },
  };
}

// ─── append_doc_text ─────────────────────────────────────────────────────────

test('append_doc_text: inserts "\\n"+text at endOfSegmentLocation, then styles+deletes bullets over [E, E+text.length), with tabId and writeControl on every request', async () => {
  const NEW_PARA = paraEl('New line.', P3.endIndex);
  const { api, calls } = fakeDocsApi([soloDocBefore('rev-append-1'), soloDocAfter([P1, P2, P3, NEW_PARA])], {});
  const client = makeClient({ docsApi: api });
  const ctx = makeCtx(() => client);

  const out = text(await docs.append_doc_text({ account: 'personal', document_id: 'D1', text: 'New line.' }, ctx));
  record(out);

  assert.equal(calls.gets.length, 2, 'fetches before AND after the write');
  assert.equal(calls.batchUpdates.length, 1);
  const req = calls.batchUpdates[0];
  assert.equal(req.documentId, 'D1');
  assert.equal(req.requestBody.writeControl.requiredRevisionId, 'rev-append-1');

  const E = P3.endIndex;
  const [insert, style, bullets] = req.requestBody.requests;
  assert.deepEqual(insert.insertText.endOfSegmentLocation, { tabId: 't.0' });
  assert.equal(insert.insertText.text, '\nNew line.');
  assert.deepEqual(style.updateParagraphStyle.range, { startIndex: E, endIndex: E + 'New line.'.length, tabId: 't.0' });
  assert.equal(style.updateParagraphStyle.paragraphStyle.namedStyleType, 'NORMAL_TEXT');
  assert.deepEqual(bullets.deleteParagraphBullets.range, { startIndex: E, endIndex: E + 'New line.'.length, tabId: 't.0' });

  assert.match(out, /^✅ Text appended to the tab\.$/m);
  assert.match(out, /Tab: Only Tab \(tab_id: t\.0\)/);
  assert.match(out, /New line\./);
});

test('append_doc_text: a non-default style is applied instead of NORMAL_TEXT, and is still ALWAYS applied (deterministic)', async () => {
  const NEW_PARA = paraEl('Heads up', P3.endIndex, { paragraphStyle: { namedStyleType: 'HEADING_2' } });
  const { api, calls } = fakeDocsApi([soloDocBefore(), soloDocAfter([P1, P2, P3, NEW_PARA])]);
  const client = makeClient({ docsApi: api });
  const ctx = makeCtx(() => client);

  await docs.append_doc_text({ account: 'personal', document_id: 'D1', text: 'Heads up', style: 'HEADING_2' }, ctx);
  const style = calls.batchUpdates[0].requestBody.requests[1];
  assert.equal(style.updateParagraphStyle.paragraphStyle.namedStyleType, 'HEADING_2');
});

test('append_doc_text: the report comes from the SECOND fetch, not the request args', async () => {
  // The after-doc's new paragraph deliberately has different text than what was sent,
  // proving the report is read back rather than echoed.
  const NEW_PARA = paraEl('Google now holds this instead.', P3.endIndex);
  const { api } = fakeDocsApi([soloDocBefore(), soloDocAfter([P1, P2, P3, NEW_PARA])]);
  const client = makeClient({ docsApi: api });
  const ctx = makeCtx(() => client);
  const out = text(await docs.append_doc_text({ account: 'personal', document_id: 'D1', text: 'What was requested.' }, ctx));
  record(out);
  assert.match(out, /Google now holds this instead\./);
  assert.doesNotMatch(out, /What was requested\./);
});

// ─── replace_doc_text ────────────────────────────────────────────────────────

test('replace_doc_text: replaceAllText with tabsCriteria and writeControl; reports occurrencesChanged from the reply', async () => {
  const { api, calls } = fakeDocsApi([soloDocBefore('rev-replace-1')], { replies: [{ replaceAllText: { occurrencesChanged: 3 } }] });
  const client = makeClient({ docsApi: api });
  const ctx = makeCtx(() => client);

  const out = text(await docs.replace_doc_text({ account: 'personal', document_id: 'D1', find: 'foo', replace_with: 'bar' }, ctx));
  record(out);

  assert.equal(calls.gets.length, 1, 'replace does not need a re-fetch: the reply itself carries the count');
  const req = calls.batchUpdates[0].requestBody;
  assert.equal(req.writeControl.requiredRevisionId, 'rev-replace-1');
  const [r] = req.requests;
  assert.deepEqual(r.replaceAllText.containsText, { text: 'foo', matchCase: false });
  assert.equal(r.replaceAllText.replaceText, 'bar');
  assert.deepEqual(r.replaceAllText.tabsCriteria, { tabIds: ['t.0'] });
  assert.match(out, /Replaced 3 occurrence/);
});

test('replace_doc_text: zero occurrences is reported plainly, not as an error', async () => {
  const { api } = fakeDocsApi([soloDocBefore()], { replies: [{ replaceAllText: { occurrencesChanged: 0 } }] });
  const client = makeClient({ docsApi: api });
  const ctx = makeCtx(() => client);
  const out = text(await docs.replace_doc_text({ account: 'personal', document_id: 'D1', find: 'nope', replace_with: 'x' }, ctx));
  record(out);
  assert.match(out, /changed nothing -- "nope" was not found/);
});

test('replace_doc_text: match_case is passed through', async () => {
  const { api, calls } = fakeDocsApi([soloDocBefore()], { replies: [{ replaceAllText: { occurrencesChanged: 1 } }] });
  const client = makeClient({ docsApi: api });
  const ctx = makeCtx(() => client);
  await docs.replace_doc_text({ account: 'personal', document_id: 'D1', find: 'X', replace_with: 'Y', match_case: true }, ctx);
  assert.equal(calls.batchUpdates[0].requestBody.requests[0].replaceAllText.containsText.matchCase, true);
});

// ─── insert_doc_text: heading anchor request construction ──────────────────

test('insert_doc_text heading before: inserts text+"\\n" at the heading startIndex, then styles the inserted range NORMAL_TEXT', async () => {
  const NEW_PARA = paraEl('Lead-in', P1.startIndex);
  const { api, calls } = fakeDocsApi([soloDocBefore('rev-h-before'), soloDocAfter([NEW_PARA, P1, P2, P3])]);
  const client = makeClient({ docsApi: api });
  const ctx = makeCtx(() => client);

  const out = text(await docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'Lead-in', position: 'before', heading: 'Overview' }, ctx));
  record(out);

  const req = calls.batchUpdates[0].requestBody;
  assert.equal(req.writeControl.requiredRevisionId, 'rev-h-before');
  const [insert, style, bullets] = req.requests;
  assert.deepEqual(insert.insertText.location, { index: P1.startIndex, tabId: 't.0' });
  assert.equal(insert.insertText.text, 'Lead-in\n');
  const range = { startIndex: P1.startIndex, endIndex: P1.startIndex + 'Lead-in'.length, tabId: 't.0' };
  assert.deepEqual(style.updateParagraphStyle.range, range);
  assert.equal(style.updateParagraphStyle.paragraphStyle.namedStyleType, 'NORMAL_TEXT');
  assert.deepEqual(bullets.deleteParagraphBullets.range, range);
  assert.match(out, /Lead-in/);
});

test('insert_doc_text heading after (not the last paragraph): inserts text+"\\n" at the heading endIndex', async () => {
  const NEW_PARA = paraEl('Right after', P1.endIndex);
  const { api, calls } = fakeDocsApi([soloDocBefore('rev-h-after'), soloDocAfter([P1, NEW_PARA, P2, P3])]);
  const client = makeClient({ docsApi: api });
  const ctx = makeCtx(() => client);

  const out = text(await docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'Right after', position: 'after', heading: 'Overview' }, ctx));
  record(out);

  const req = calls.batchUpdates[0].requestBody;
  const [insert, style] = req.requests;
  assert.deepEqual(insert.insertText.location, { index: P1.endIndex, tabId: 't.0' });
  assert.equal(insert.insertText.text, 'Right after\n');
  assert.deepEqual(style.updateParagraphStyle.range, { startIndex: P1.endIndex, endIndex: P1.endIndex + 'Right after'.length, tabId: 't.0' });
  assert.match(out, /Right after/);
});

test('insert_doc_text heading after, WHEN the heading is the last paragraph of the body: inserts "\\n"+text at endIndex-1 (before the un-deletable final newline)', async () => {
  const E = P3.endIndex; // Conclusion is the body's last paragraph
  const NEW_PARA = paraEl('Final note', E);
  const { api, calls } = fakeDocsApi([soloDocBefore('rev-h-last'), soloDocAfter([P1, P2, P3, NEW_PARA])]);
  const client = makeClient({ docsApi: api });
  const ctx = makeCtx(() => client);

  const out = text(await docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'Final note', position: 'after', heading: 'Conclusion' }, ctx));
  record(out);

  const req = calls.batchUpdates[0].requestBody;
  const [insert, style] = req.requests;
  assert.deepEqual(insert.insertText.location, { index: E - 1, tabId: 't.0' });
  assert.equal(insert.insertText.text, '\nFinal note');
  assert.deepEqual(style.updateParagraphStyle.range, { startIndex: E, endIndex: E + 'Final note'.length, tabId: 't.0' });
  assert.match(out, /Final note/);
});

test('insert_doc_text heading replace: deletes the heading text (keeping its trailing newline) then inserts the new text at the same startIndex -- the paragraph, and its style, is preserved', async () => {
  const NEW_PARA = paraEl('New Title', P1.startIndex, { paragraphStyle: { namedStyleType: 'HEADING_1' } });
  const { api, calls } = fakeDocsApi([soloDocBefore('rev-h-replace'), soloDocAfter([NEW_PARA, P2, P3])]);
  const client = makeClient({ docsApi: api });
  const ctx = makeCtx(() => client);

  const out = text(await docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'New Title', position: 'replace', heading: 'Overview' }, ctx));
  record(out);

  const req = calls.batchUpdates[0].requestBody;
  assert.equal(req.requests.length, 2, 'replace is delete+insert only -- no style reset');
  const [del, insert] = req.requests;
  assert.deepEqual(del.deleteContentRange.range, { startIndex: P1.startIndex, endIndex: P1.endIndex - 1, tabId: 't.0' });
  assert.deepEqual(insert.insertText.location, { index: P1.startIndex, tabId: 't.0' });
  assert.equal(insert.insertText.text, 'New Title');
  assert.match(out, /New Title/);
});

// ─── insert_doc_text: text anchor request construction ─────────────────────

test('insert_doc_text text anchor before/after/replace: inline, no newline added, and each request targets the resolved match', async () => {
  {
    const NEW_PARA = paraEl(`${BODY_TEXT.slice(0, ANCHOR_OFFSET)}XX ${BODY_TEXT.slice(ANCHOR_OFFSET)}`, P2.startIndex);
    const { api, calls } = fakeDocsApi([soloDocBefore('rev-t-before'), soloDocAfter([P1, NEW_PARA, P3])]);
    const client = makeClient({ docsApi: api });
    const out = text(await docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'XX ', position: 'before', anchor_text: ANCHOR_WORD }, makeCtx(() => client)));
    record(out);
    const [insert] = calls.batchUpdates[0].requestBody.requests;
    assert.equal(calls.batchUpdates[0].requestBody.requests.length, 1);
    assert.deepEqual(insert.insertText.location, { index: ANCHOR_START, tabId: 't.0' });
    assert.equal(insert.insertText.text, 'XX ');
  }
  {
    const { api, calls } = fakeDocsApi([soloDocBefore('rev-t-after'), soloDocAfter([P1, P2, P3])]);
    const client = makeClient({ docsApi: api });
    await docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: ' YY', position: 'after', anchor_text: ANCHOR_WORD }, makeCtx(() => client));
    const [insert] = calls.batchUpdates[0].requestBody.requests;
    assert.deepEqual(insert.insertText.location, { index: ANCHOR_END, tabId: 't.0' });
    assert.equal(insert.insertText.text, ' YY');
  }
  {
    const { api, calls } = fakeDocsApi([soloDocBefore('rev-t-replace'), soloDocAfter([P1, P2, P3])]);
    const client = makeClient({ docsApi: api });
    await docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'section', position: 'replace', anchor_text: ANCHOR_WORD }, makeCtx(() => client));
    const [del, insert] = calls.batchUpdates[0].requestBody.requests;
    assert.deepEqual(del.deleteContentRange.range, { startIndex: ANCHOR_START, endIndex: ANCHOR_END, tabId: 't.0' });
    assert.deepEqual(insert.insertText.location, { index: ANCHOR_START, tabId: 't.0' });
    assert.equal(insert.insertText.text, 'section');
  }
});

// ─── insert_doc_text: refusals happen BEFORE any batchUpdate ───────────────

test('insert_doc_text refuses when neither heading nor anchor_text is given -- no Google call at all', async () => {
  const { api, calls } = fakeDocsApi([soloDocBefore()]);
  const client = makeClient({ docsApi: api });
  await assert.rejects(
    docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'x', position: 'before' }, makeCtx(() => client)),
    /exactly one of "heading" or "anchor_text"/,
  );
  assert.equal(calls.gets.length, 0);
  assert.equal(calls.batchUpdates.length, 0);
});

test('insert_doc_text refuses when BOTH heading and anchor_text are given -- no Google call at all', async () => {
  const { api, calls } = fakeDocsApi([soloDocBefore()]);
  const client = makeClient({ docsApi: api });
  await assert.rejects(
    docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'x', position: 'before', heading: 'Overview', anchor_text: 'paragraph' }, makeCtx(() => client)),
    /exactly one of "heading" or "anchor_text"/,
  );
  assert.equal(calls.gets.length, 0);
  assert.equal(calls.batchUpdates.length, 0);
});

test('insert_doc_text: a heading with zero matches is refused listing the tab\'s headings; nothing written', async () => {
  const { api, calls } = fakeDocsApi([soloDocBefore()]);
  const client = makeClient({ docsApi: api });
  await assert.rejects(
    docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'x', position: 'before', heading: 'Nonexistent' }, makeCtx(() => client)),
    /No heading "Nonexistent" found[\s\S]*Overview[\s\S]*Conclusion/,
  );
  assert.equal(calls.batchUpdates.length, 0);
});

test('insert_doc_text: a heading with more than one match is refused listing every occurrence with context; nothing written', async () => {
  const DUP_A = paraEl('Status', 1, { paragraphStyle: { namedStyleType: 'HEADING_1' } });
  const DUP_B = paraEl('Status', DUP_A.endIndex, { paragraphStyle: { namedStyleType: 'HEADING_2' } });
  const dupDoc = { documentId: 'DDUP', title: 'Dup', revisionId: 'rev-dup', tabs: [{ tabProperties: { tabId: 't.0', title: 'Only' }, documentTab: { body: { content: [DUP_A, DUP_B] } } }] };
  const { api, calls } = fakeDocsApi([dupDoc]);
  const client = makeClient({ docsApi: api });
  await assert.rejects(
    docs.insert_doc_text({ account: 'personal', document_id: 'DDUP', text: 'x', position: 'before', heading: 'Status' }, makeCtx(() => client)),
    /appears 2 times[\s\S]*1\. \[HEADING_1\][\s\S]*2\. \[HEADING_2\]/,
  );
  assert.equal(calls.batchUpdates.length, 0);
});

test('insert_doc_text: text anchor with zero matches is refused "not found in tab"; nothing written', async () => {
  const { api, calls } = fakeDocsApi([soloDocBefore()]);
  const client = makeClient({ docsApi: api });
  await assert.rejects(
    docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'x', position: 'before', anchor_text: 'zzzznope' }, makeCtx(() => client)),
    /"zzzznope" not found in tab "Only Tab"/,
  );
  assert.equal(calls.batchUpdates.length, 0);
});

test('insert_doc_text: text anchor with more than one match is refused listing every occurrence with context; nothing written', async () => {
  const A = paraEl('Reach out to Acme Corp soon.', 1);
  const B = paraEl('Acme Corp replied yesterday.', A.endIndex);
  const dupDoc = { documentId: 'DDUP2', title: 'Dup2', revisionId: 'rev-dup2', tabs: [{ tabProperties: { tabId: 't.0', title: 'Only' }, documentTab: { body: { content: [A, B] } } }] };
  const { api, calls } = fakeDocsApi([dupDoc]);
  const client = makeClient({ docsApi: api });
  await assert.rejects(
    docs.insert_doc_text({ account: 'personal', document_id: 'DDUP2', text: 'x', position: 'before', anchor_text: 'Acme Corp' }, makeCtx(() => client)),
    /appears 2 times[\s\S]*Reach out to Acme Corp soon\.[\s\S]*Acme Corp replied yesterday\./,
  );
  assert.equal(calls.batchUpdates.length, 0);
});

// ─── THE TAB RULE, applied identically by append/replace/insert ────────────

const TAB_RULE_CASES = [
  {
    name: 'append_doc_text',
    call: (client, args) => docs.append_doc_text({ account: 'personal', document_id: args.documentId, text: 'x', tab_id: args.tabId }, makeCtx(() => client)),
  },
  {
    name: 'replace_doc_text',
    call: (client, args) => docs.replace_doc_text({ account: 'personal', document_id: args.documentId, find: 'a', replace_with: 'b', tab_id: args.tabId }, makeCtx(() => client)),
  },
  {
    name: 'insert_doc_text',
    call: (client, args) => docs.insert_doc_text({ account: 'personal', document_id: args.documentId, text: 'x', position: 'before', anchor_text: 'marker text', tab_id: args.tabId }, makeCtx(() => client)),
  },
];

for (const { name, call } of TAB_RULE_CASES) {
  test(`${name}: tab_id given and valid uses that tab`, async () => {
    const { api, calls } = fakeDocsApi([twoTabDoc(), twoTabDocAfter('t.b', [BETA_P])], { replies: [{ replaceAllText: { occurrencesChanged: 1 } }] });
    const client = makeClient({ docsApi: api });
    await call(client, { documentId: 'D2', tabId: 't.b' });
    assert.equal(calls.batchUpdates.length, 1);
    // every request in the batch carries the resolved tab's id
    for (const req of calls.batchUpdates[0].requestBody.requests) {
      const carrier = req.insertText?.location ?? req.insertText?.endOfSegmentLocation ?? req.updateParagraphStyle?.range ?? req.deleteParagraphBullets?.range ?? req.deleteContentRange?.range ?? req.replaceAllText?.tabsCriteria;
      const tabIdSeen = carrier?.tabId ?? carrier?.tabIds?.[0];
      assert.equal(tabIdSeen, 't.b');
    }
  });

  test(`${name}: tab_id given and UNKNOWN is refused with the tab index; no batchUpdate`, async () => {
    const { api, calls } = fakeDocsApi([twoTabDoc()]);
    const client = makeClient({ docsApi: api });
    await assert.rejects(call(client, { documentId: 'D2', tabId: 'nope' }), /No tab with tab_id "nope"[\s\S]*Alpha[\s\S]*Beta/);
    assert.equal(calls.batchUpdates.length, 0);
  });

  test(`${name}: tab_id omitted on a ONE-tab document uses that tab`, async () => {
    const afterContent = name === 'append_doc_text' ? [P1, P2, P3, paraEl('x', P3.endIndex)]
      : name === 'insert_doc_text' ? [P1, P2, P3]
      : [P1, P2, P3];
    const { api, calls } = fakeDocsApi([soloDocBefore(), soloDocAfter(afterContent)], { replies: [{ replaceAllText: { occurrencesChanged: 1 } }] });
    const client = makeClient({ docsApi: api });
    if (name === 'insert_doc_text') {
      // the shared insert call anchors on "Alpha body", which only exists in the two-tab
      // fixture; use the heading anchor instead so this scenario is meaningful for a solo doc.
      await docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'x', position: 'before', heading: 'Overview' }, makeCtx(() => client));
    } else {
      await call(client, { documentId: 'D1', tabId: undefined });
    }
    assert.equal(calls.batchUpdates.length, 1);
  });

  test(`${name}: tab_id omitted on a MULTI-tab document is refused with the tab index; no batchUpdate`, async () => {
    const { api, calls } = fakeDocsApi([twoTabDoc()]);
    const client = makeClient({ docsApi: api });
    await assert.rejects(call(client, { documentId: 'D2', tabId: undefined }), /more than one tab[\s\S]*Alpha[\s\S]*Beta/);
    assert.equal(calls.batchUpdates.length, 0);
  });
}

// ─── create_doc ──────────────────────────────────────────────────────────────

test('create_doc: without folder_id just creates and reports id/url', async () => {
  const { api } = fakeDriveApi();
  const client = makeClient({ docsApi: fakeDocsApi([]).api, driveApi: api, createDocumentResult: { documentId: 'NEWDOC', url: 'https://docs.google.com/document/d/NEWDOC/edit' } });
  const out = text(await docs.create_doc({ account: 'personal', title: 'My New Doc' }, makeCtx(() => client)));
  record(out);
  assert.match(out, /Document ID: NEWDOC/);
  assert.match(out, /URL: https:\/\/docs\.google\.com\/document\/d\/NEWDOC\/edit/);
  assert.doesNotMatch(out, /Parents:/);
});

test('create_doc with folder_id: moves the new file via files.get (current parents) -> files.update (add/remove) -> reads parents back', async () => {
  const { api: driveApi, calls } = fakeDriveApi({ currentParents: ['ROOT'] });
  const client = makeClient({ docsApi: fakeDocsApi([]).api, driveApi, createDocumentResult: { documentId: 'NEWDOC2', url: 'https://docs.google.com/document/d/NEWDOC2/edit' } });
  const out = text(await docs.create_doc({ account: 'personal', title: 'Foldered Doc', folder_id: 'NEW_FOLDER' }, makeCtx(() => client)));
  record(out);

  assert.equal(calls.gets.length, 2, 'current parents, then a read-back after the move');
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].fileId, 'NEWDOC2');
  assert.equal(calls.updates[0].addParents, 'NEW_FOLDER');
  assert.equal(calls.updates[0].removeParents, 'ROOT');
  assert.match(out, /Parents: NEW_FOLDER/);
});

// ─── No character index ever appears in a Docs tool's schema or output ─────

test('no Docs write tool schema exposes a character index, and no printed report mentions one', () => {
  for (const def of [createDocTool, appendDocTextTool, replaceDocTextTool, insertDocTextTool]) {
    for (const key of Object.keys(def.inputSchema.properties)) {
      assert.ok(!/index/i.test(key), `${def.name}.${key} looks like a character index`);
    }
    assert.ok(def.description.length >= 60 && def.description.length <= 512, `${def.name} description length`);
    assert.match(def.name, /^[a-z]+(_[a-z]+){1,3}$/);
  }
  assert.ok(REPORTS.length > 5, 'sanity: reports were actually collected');
  for (const report of REPORTS) {
    assert.ok(!/\bindex\b/i.test(report), `a printed report mentions "index":\n${report}`);
  }
});

// ─── Adversarial review fixes, 2026-09-19 ──────────────────────────────────

test('insert_doc_text: an anchor with many matches lists at most 10 candidates and says how many more; nothing written', async () => {
  const content = [];
  let at = 1;
  for (let i = 0; i < 25; i += 1) { const p = paraEl(`Paragraph ${i} mentions Acme Corp here.`, at); content.push(p); at = p.endIndex; }
  const doc = { documentId: 'DMANY', title: 'Many', revisionId: 'rev-many', tabs: [{ tabProperties: { tabId: 't.0', title: 'Only' }, documentTab: { body: { content } } }] };
  const { api, calls } = fakeDocsApi([doc]);
  const client = makeClient({ docsApi: api });
  await assert.rejects(
    docs.insert_doc_text({ account: 'personal', document_id: 'DMANY', text: 'x', position: 'after', anchor_text: 'Acme Corp' }, makeCtx(() => client)),
    (err) => {
      assert.match(err.message, /appears 25 times/);
      assert.equal((err.message.match(/^\d+\. /gm) ?? []).length, 10, 'exactly ten numbered candidates');
      assert.match(err.message, /… and 15 more/);
      return true;
    },
  );
  assert.equal(calls.batchUpdates.length, 0);
});

test('insert_doc_text and replace_doc_text refuse an anchor_text / find containing a line break, before any write', async () => {
  const { api, calls } = fakeDocsApi([soloDocBefore()]);
  const client = makeClient({ docsApi: api });
  await assert.rejects(
    docs.insert_doc_text({ account: 'personal', document_id: 'D1', text: 'x', position: 'replace', anchor_text: 'Hello\n' }, makeCtx(() => client)),
    /anchor_text must not contain a line break/,
  );
  await assert.rejects(
    docs.replace_doc_text({ account: 'personal', document_id: 'D1', find: 'a\nb', replace_with: 'c' }, makeCtx(() => client)),
    /find must not contain a line break/,
  );
  assert.equal(calls.batchUpdates.length, 0);
});

test('a document fetched without a revisionId is refused rather than edited unpinned', async () => {
  const doc = soloDocBefore();
  delete doc.revisionId;
  const { api, calls } = fakeDocsApi([doc]);
  const client = makeClient({ docsApi: api });
  await assert.rejects(
    docs.append_doc_text({ account: 'personal', document_id: 'D1', text: 'x' }, makeCtx(() => client)),
    /no revisionId/,
  );
  assert.equal(calls.batchUpdates.length, 0);
});
