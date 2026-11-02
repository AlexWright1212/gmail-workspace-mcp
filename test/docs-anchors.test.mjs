// Plan 002 Phase 4 (unit B): pure anchor resolution over one tab's body --
// findHeadings/listHeadings, findText (the a-bonus findElements port,
// contiguous-run units with a per-character index map, paragraph/cell hard
// boundaries, recursing into nested tables), and the internal-only
// paragraphAt/lastParagraph/bodyEndIndex helpers src/docs/writes.ts uses to
// report what Google now holds -- never to the model as a number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findHeadings, listHeadings, findText, formatHeadingList, paragraphAt, lastParagraph, bodyEndIndex } from '../dist/docs/anchors.js';

// Build fake bodies the way Google numbers a real one: body content starts
// at index 1, and each paragraph's endIndex is one past its trailing
// newline. `cursor` is threaded through so every element in one body stays
// contiguous, exactly as a real documents.get response would be.
function makeCursor() {
  return { v: 1 };
}

function mkPara(cursor, text, extra = {}) {
  const start = cursor.v;
  const full = `${text}\n`;
  const end = start + full.length;
  cursor.v = end;
  return {
    startIndex: start,
    endIndex: end,
    paragraph: { elements: [{ startIndex: start, endIndex: end, textRun: { content: full } }], ...extra },
  };
}

/** One paragraph made of several contiguous text runs (as Google emits when
 * a paragraph mixes bold/italic/plain styling) -- the last run carries the
 * paragraph's own trailing newline. */
function mkParaRuns(cursor, parts, extra = {}) {
  const start = cursor.v;
  const elements = parts.map((part) => {
    const s = cursor.v;
    const e = s + part.length;
    cursor.v = e;
    return { startIndex: s, endIndex: e, textRun: { content: part } };
  });
  return { startIndex: start, endIndex: cursor.v, paragraph: { elements, ...extra } };
}

/** A paragraph split by a non-text element (e.g. an inline image), which
 * consumes one index unit but contributes no textRun -- exactly what should
 * break findText's contiguous-run unit. */
function mkParaWithGap(cursor, before, after) {
  const start = cursor.v;
  const elements = [];
  let s = cursor.v;
  let e = s + before.length;
  elements.push({ startIndex: s, endIndex: e, textRun: { content: before } });
  cursor.v = e;
  s = cursor.v;
  e = s + 1;
  elements.push({ startIndex: s, endIndex: e, inlineObjectElement: { inlineObjectId: 'img1' } });
  cursor.v = e;
  s = cursor.v;
  e = s + after.length;
  elements.push({ startIndex: s, endIndex: e, textRun: { content: after } });
  cursor.v = e;
  return { startIndex: start, endIndex: cursor.v, paragraph: { elements } };
}

// ─── findHeadings / listHeadings ────────────────────────────────────────────

test('findHeadings matches HEADING_n/TITLE/SUBTITLE paragraphs case-insensitively and trimmed; listHeadings lists all of them', () => {
  const cursor = makeCursor();
  const h1 = mkPara(cursor, '  Roadmap  ', { paragraphStyle: { namedStyleType: 'HEADING_1' } });
  const body = {
    content: [
      mkPara(cursor, 'Intro text.'),
      h1,
      mkPara(cursor, 'Some body text under Roadmap.'),
      mkPara(cursor, 'Notes', { paragraphStyle: { namedStyleType: 'SUBTITLE' } }),
    ],
  };

  const found = findHeadings(body, 'roadmap');
  assert.equal(found.length, 1);
  assert.equal(found[0].text, 'Roadmap');
  assert.equal(found[0].level, 'HEADING_1');
  assert.equal(found[0].startIndex, h1.startIndex);
  assert.equal(found[0].endIndex, h1.endIndex);

  assert.equal(findHeadings(body, 'ROADMAP').length, 1);
  assert.equal(findHeadings(body, 'nonexistent').length, 0);

  const all = listHeadings(body);
  assert.deepEqual(all.map((h) => h.text), ['Roadmap', 'Notes']);
  assert.match(formatHeadingList(all), /\[HEADING_1\] Roadmap/);
  assert.match(formatHeadingList(all), /\[SUBTITLE\] Notes/);
  assert.equal(formatHeadingList([]), '(this tab has no headings)');
});

test('findHeadings does not match plain-body paragraphs or a heading appearing more than once', () => {
  const cursor = makeCursor();
  const body = {
    content: [
      mkPara(cursor, 'Overview', { paragraphStyle: { namedStyleType: 'HEADING_2' } }),
      mkPara(cursor, 'Overview'), // same text, no heading style -- must not count
      mkPara(cursor, 'Overview', { paragraphStyle: { namedStyleType: 'HEADING_2' } }), // duplicate heading
    ],
  };
  const found = findHeadings(body, 'Overview');
  assert.equal(found.length, 2);
});

// ─── findText ────────────────────────────────────────────────────────────────

test('a phrase split across two styled runs (contiguous indices) still matches', () => {
  const cursor = makeCursor();
  const p = mkParaRuns(cursor, ['Hello ', 'World'], {});
  const body = { content: [p] };
  const matches = findText(body, 'Hello World');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].startIndex, p.startIndex);
  assert.equal(matches[0].endIndex, p.startIndex + 'Hello World'.length);
});

test('a run gap (inline image between runs) breaks the unit: the spanning phrase does not match, but each side does', () => {
  const cursor = makeCursor();
  const p = mkParaWithGap(cursor, 'Hello ', 'World');
  const body = { content: [p] };
  assert.equal(findText(body, 'Hello World').length, 0);
  assert.equal(findText(body, 'Hello').length, 1);
  assert.equal(findText(body, 'World').length, 1);
});

test('text inside a table cell is found', () => {
  const cursor = makeCursor();
  const intro = mkPara(cursor, 'Contacts:');
  const cellPara = mkPara(cursor, 'Contact: Jane Doe');
  const table = {
    table: { tableRows: [{ tableCells: [{ content: [cellPara] }] }] },
  };
  const body = { content: [intro, table] };
  const matches = findText(body, 'Jane Doe');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].context, 'Contact: Jane Doe');
});

test('a table nested inside a cell is also searched (recursion)', () => {
  const cursor = makeCursor();
  const outerCellPara = mkPara(cursor, 'Outer cell text.');
  const innerCellPara = mkPara(cursor, 'Nested Bob is here.');
  const innerTable = { table: { tableRows: [{ tableCells: [{ content: [innerCellPara] }] }] } };
  const outerTable = { table: { tableRows: [{ tableCells: [{ content: [outerCellPara, innerTable] }] }] } };
  const body = { content: [outerTable] };
  const matches = findText(body, 'Nested Bob');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].context, 'Nested Bob is here.');
});

test('the same phrase in two paragraphs yields two results with distinct contexts', () => {
  const cursor = makeCursor();
  const p1 = mkPara(cursor, 'Reach out to Jane.');
  const p2 = mkPara(cursor, 'Ask Jane again next week.');
  const body = { content: [p1, p2] };
  const matches = findText(body, 'Jane');
  assert.equal(matches.length, 2);
  assert.notEqual(matches[0].context, matches[1].context);
  assert.equal(matches[0].context, 'Reach out to Jane.');
  assert.equal(matches[1].context, 'Ask Jane again next week.');
  assert.equal(matches[0].startIndex, p1.startIndex + 'Reach out to '.length);
  assert.equal(matches[1].startIndex, p2.startIndex + 'Ask '.length);
});

test('a phrase spanning two paragraphs is NOT matched -- the paragraph boundary is hard', () => {
  const cursor = makeCursor();
  const body = { content: [mkPara(cursor, 'Hello'), mkPara(cursor, 'World')] };
  // "Hello\nWorld" only occurs if the two paragraphs' units were wrongly concatenated.
  assert.equal(findText(body, 'Hello\nWorld').length, 0);
  assert.equal(findText(body, 'Hello').length, 1);
  assert.equal(findText(body, 'World').length, 1);
});

test('non-overlapping matches: two adjacent occurrences of the same short text do not overlap-count', () => {
  const cursor = makeCursor();
  const p = mkPara(cursor, 'aaaa');
  const body = { content: [p] };
  const matches = findText(body, 'aa');
  assert.equal(matches.length, 2);
});

test('findText on an empty query returns nothing', () => {
  const cursor = makeCursor();
  const body = { content: [mkPara(cursor, 'Hello')] };
  assert.equal(findText(body, '').length, 0);
});

// ─── paragraphAt / lastParagraph / bodyEndIndex ─────────────────────────────

test('paragraphAt finds the top-level paragraph containing an index; out of range is null', () => {
  const cursor = makeCursor();
  const p1 = mkPara(cursor, 'First.');
  const p2 = mkPara(cursor, 'Second.');
  const body = { content: [p1, p2] };

  assert.deepEqual(paragraphAt(body, p1.startIndex), { startIndex: p1.startIndex, endIndex: p1.endIndex, text: 'First.' });
  assert.deepEqual(paragraphAt(body, p2.startIndex + 2), { startIndex: p2.startIndex, endIndex: p2.endIndex, text: 'Second.' });
  assert.equal(paragraphAt(body, p2.endIndex + 100), null);
});

test('paragraphAt recurses into a table cell', () => {
  const cursor = makeCursor();
  const cellPara = mkPara(cursor, 'Cell text.');
  const table = { startIndex: cellPara.startIndex, endIndex: cellPara.endIndex + 2, table: { tableRows: [{ tableCells: [{ content: [cellPara] }] }] } };
  const body = { content: [table] };
  const found = paragraphAt(body, cellPara.startIndex + 1);
  assert.deepEqual(found, { startIndex: cellPara.startIndex, endIndex: cellPara.endIndex, text: 'Cell text.' });
});

test('lastParagraph returns the body\'s final top-level paragraph; bodyEndIndex is its endIndex', () => {
  const cursor = makeCursor();
  const p1 = mkPara(cursor, 'First.');
  const p2 = mkPara(cursor, 'Last one.');
  const body = { content: [p1, p2] };
  assert.deepEqual(lastParagraph(body), { startIndex: p2.startIndex, endIndex: p2.endIndex, text: 'Last one.' });
  assert.equal(bodyEndIndex(body), p2.endIndex);
});

test('bodyEndIndex on an empty body is 1 (an empty tab still has the un-deletable body newline)', () => {
  assert.equal(bodyEndIndex({ content: [] }), 1);
  assert.equal(bodyEndIndex(undefined), 1);
});
