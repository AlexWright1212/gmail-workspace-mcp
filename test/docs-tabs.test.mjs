// Plan 002 Phase 3: tab-addressed reads. Every tab is rendered from its own
// body in document order (children after their parent); a tab_id selects
// one; above the threshold a whole-document read returns the index, never a
// truncated text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenTabs, renderDocument, formatTabIndex } from '../dist/docs/tabs.js';

const run = (content) => ({ textRun: { content } });
const para = (text, extra = {}) => ({ paragraph: { elements: [run(text + '\n')], ...extra } });
const tab = (id, title, paragraphs, childTabs = []) => ({
  tabProperties: { tabId: id, title },
  documentTab: { body: { content: paragraphs } },
  childTabs,
});

const DOC = {
  documentId: 'doc1',
  title: 'Musings',
  tabs: [
    tab('t.0', 'Intro', [para('Welcome.')]),
    tab('t.1', 'Ideas', [para('Ideas', { paragraphStyle: { namedStyleType: 'HEADING_1' } }), para('first', { bullet: { listId: 'x' } })], [
      tab('t.1.1', 'Ideas / Deep', [para('Nested text.')]),
    ]),
    tab('t.2', 'Outro', [para('Bye.')]),
  ],
};

test('flattenTabs walks children after their parent and counts characters per tab', () => {
  const flat = flattenTabs(DOC);
  assert.deepEqual(flat.map((t) => [t.tabId, t.title, t.depth]), [
    ['t.0', 'Intro', 0], ['t.1', 'Ideas', 0], ['t.1.1', 'Ideas / Deep', 1], ['t.2', 'Outro', 0],
  ]);
  assert.equal(flat[0].characters, 'Welcome.\n'.length);
  assert.equal(flat[2].parentTabId, undefined); // Google fills parentTabId; the fake omits it
});

test('a whole-document read renders every tab, nested ones included, with headings and lists intact', () => {
  const r = renderDocument(DOC, { indexThreshold: 60_000 });
  assert.equal(r.kind, 'content');
  assert.equal(r.rendered.length, 4);
  assert.equal(r.rendered[1].markdown, '# Ideas\n\n- first');
  assert.equal(r.rendered[2].markdown, 'Nested text.');
});

test('tab_id reads exactly one tab; an unknown tab_id is refused with the tab list', () => {
  const r = renderDocument(DOC, { tabId: 't.1.1', indexThreshold: 60_000 });
  assert.equal(r.kind, 'content');
  assert.deepEqual(r.rendered.map((x) => x.tab.tabId), ['t.1.1']);
  assert.throws(() => renderDocument(DOC, { tabId: 't.9', indexThreshold: 60_000 }), /No tab with tab_id "t.9"[\s\S]*Intro[\s\S]*Ideas \/ Deep/);
});

test('above the threshold, a whole-document read returns the index and no text; tab_id still reads one tab', () => {
  const r = renderDocument(DOC, { indexThreshold: 10 });
  assert.equal(r.kind, 'index');
  assert.equal(r.tabs.length, 4);
  assert.equal(r.totalCharacters, r.tabs.reduce((n, t) => n + t.characters, 0));
  const one = renderDocument(DOC, { tabId: 't.2', indexThreshold: 10 });
  assert.equal(one.kind, 'content');
  assert.equal(one.rendered[0].markdown, 'Bye.');
});

test('formatTabIndex indents children and prints ids and sizes', () => {
  const text = formatTabIndex(flattenTabs(DOC));
  assert.match(text, /^- Intro \(tab_id: t\.0, 9 characters\)$/m);
  assert.match(text, /^  - Ideas \/ Deep \(tab_id: t\.1\.1, 13 characters\)$/m);
});

test('a legacy response with a body but no tabs is rendered as one tab, never as nothing', () => {
  const legacy = { documentId: 'd', title: 'Old', body: { content: [para('Only body.')] } };
  const r = renderDocument(legacy, { indexThreshold: 60_000 });
  assert.equal(r.kind, 'content');
  assert.equal(r.rendered.length, 1);
  assert.equal(r.rendered[0].tab.tabId, 't.0');
  assert.equal(r.rendered[0].markdown, 'Only body.');
});

test('a tab_id against a document with no tabs at all is refused, not silently empty', () => {
  assert.throws(() => renderDocument({ documentId: 'x', title: 'Empty' }, { tabId: 't.0', indexThreshold: 60_000 }), /No tab with tab_id "t.0"/);
  assert.deepEqual(renderDocument({ documentId: 'x', title: 'Empty' }, { indexThreshold: 60_000 }).rendered, []);
});
