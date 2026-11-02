// Plan 002 Phase 3: the Docs body -> Markdown converter (ported from
// a-bonus/google-docs-mcp, retyped, extended). Cases mirror upstream's
// behaviour plus what spec 002 adds: images and footnotes leave a marker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { docsBodyToMarkdown, docsBodyToPlainText } from '../dist/docs/markdown.js';

const run = (content, textStyle) => ({ textRun: { content, textStyle } });
const para = (elements, extra = {}) => ({ paragraph: { elements, ...extra } });
const heading = (text, level) => para([run(text + '\n')], { paragraphStyle: { namedStyleType: `HEADING_${level}` } });

test('headings, paragraphs and inline styles', () => {
  const body = { content: [
    heading('Title here', 1),
    para([run('Plain, '), run('bold', { bold: true }), run(', '), run('italic', { italic: true }), run(', '), run('both', { bold: true, italic: true }), run('.\n')]),
    heading('Sub', 2),
    para([run('A '), run('link', { link: { url: 'https://example.com' } }), run(' and '), run('struck', { strikethrough: true }), run(' and '), run('under', { underline: true }), run('.\n')]),
    para([run('code here', { weightedFontFamily: { fontFamily: 'Courier New' } }), run('\n')]),
  ] };
  assert.equal(docsBodyToMarkdown(body), [
    '# Title here',
    '',
    'Plain, **bold**, *italic*, ***both***.',
    '',
    '## Sub',
    '',
    'A [link](https://example.com) and ~~struck~~ and <u>under</u>.',
    '',
    '`code here`',
  ].join('\n'));
});

test('TITLE and SUBTITLE map to H1/H2; deep headings cap at H6', () => {
  const body = { content: [
    para([run('Doc title\n')], { paragraphStyle: { namedStyleType: 'TITLE' } }),
    para([run('Doc subtitle\n')], { paragraphStyle: { namedStyleType: 'SUBTITLE' } }),
    heading('Deep', 6),
  ] };
  assert.equal(docsBodyToMarkdown(body), '# Doc title\n\n## Doc subtitle\n\n###### Deep');
});

test('ordered and unordered lists with nesting, decided by the list definition', () => {
  const lists = {
    'kix.ul': { listProperties: { nestingLevels: [{ glyphSymbol: '●' }, { glyphSymbol: '○' }] } },
    'kix.ol': { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }, { glyphType: 'ALPHA' }] } },
  };
  const body = { content: [
    para([run('one\n')], { bullet: { listId: 'kix.ul', nestingLevel: 0 } }),
    para([run('one-a\n')], { bullet: { listId: 'kix.ul', nestingLevel: 1 } }),
    para([run('two\n')], { bullet: { listId: 'kix.ul' } }),
    para([run('\n')]),
    para([run('first\n')], { bullet: { listId: 'kix.ol', nestingLevel: 0 } }),
    para([run('first-a\n')], { bullet: { listId: 'kix.ol', nestingLevel: 1 } }),
  ] };
  assert.equal(docsBodyToMarkdown(body, { lists }), '- one\n  - one-a\n- two\n\n1. first\n  1. first-a');
});

test('tables become Markdown tables with a header separator, and cell pipes are escaped', () => {
  const cell = (text) => ({ content: [para([run(text + '\n')])] });
  const body = { content: [{ table: { tableRows: [
    { tableCells: [cell('Name'), cell('Value')] },
    { tableCells: [cell('a|b'), cell('two words')] },
  ] } }] };
  assert.equal(docsBodyToMarkdown(body), '| Name | Value |\n| --- | --- |\n| a\\|b | two words |');
});

test('a 1x1 monospace table is a fenced code block', () => {
  const body = { content: [{ table: { tableRows: [{ tableCells: [{ content: [
    para([run('const x = 1;\n', { weightedFontFamily: { fontFamily: 'Roboto Mono' } })]),
    para([run('return x;\n', { weightedFontFamily: { fontFamily: 'Roboto Mono' } })]),
  ] }] }] } }] };
  assert.equal(docsBodyToMarkdown(body), '```\nconst x = 1;\nreturn x;\n```');
});

test('the section break that opens every body is not rendered; later ones and horizontal rules are', () => {
  const body = { content: [
    { sectionBreak: {} },
    para([run('Before\n')]),
    para([{ horizontalRule: {} }, run('\n')]),
    para([run('After\n')]),
    { sectionBreak: {} },
    para([run('Next section\n')]),
  ] };
  assert.equal(docsBodyToMarkdown(body), 'Before\n\n---\n\nAfter\n\n---\n\nNext section');
});

test('inline images and footnotes leave visible markers instead of vanishing (spec 002)', () => {
  const body = { content: [
    para([run('See '), { inlineObjectElement: { inlineObjectId: 'kix.img1' } }, run(' here'), { footnoteReference: { footnoteId: 'kix.fn1' } }, run('.\n')]),
    para([{ inlineObjectElement: { inlineObjectId: 'kix.img2' } }, run('\n')]),
    para([run('Again'), { footnoteReference: { footnoteId: 'kix.fn1' } }, run(' and'), { footnoteReference: { footnoteId: 'kix.fn2' } }, run('\n')]),
  ] };
  const ctx = {
    inlineObjects: { 'kix.img1': { inlineObjectProperties: { embeddedObject: { title: 'Chart of Q3' } } } },
    footnotes: { 'kix.fn1': { content: [para([run('The first note.\n')])] } },
  };
  assert.equal(docsBodyToMarkdown(body, ctx), [
    'See [image: Chart of Q3] here[^1].',
    '',
    '[image kix.img2]',
    '',
    'Again[^1] and[^2]',
    '',
    '[^1]: The first note.',
    '[^2]: (footnote text unavailable)',
  ].join('\n'));
});

test('plain text walks tables too, and an empty body renders as nothing', () => {
  const cell = (text) => ({ content: [para([run(text + '\n')])] });
  const body = { content: [para([run('Hello\n')]), { table: { tableRows: [{ tableCells: [cell('A'), cell('B')] }] } }] };
  assert.equal(docsBodyToPlainText(body), 'Hello\nA\nB\n');
  assert.equal(docsBodyToMarkdown(undefined), '');
  assert.equal(docsBodyToMarkdown({ content: [] }), '');
});

test('a table nested inside a table cell is kept as a marked, flattened note, never dropped', () => {
  const cell = (text) => ({ content: [para([run(text + '\n')])] });
  const inner = { table: { tableRows: [{ tableCells: [cell('x'), cell('y')] }] } };
  const body = { content: [{ table: { tableRows: [
    { tableCells: [cell('Head'), cell('Other')] },
    { tableCells: [{ content: [para([run('before\n')]), inner] }, cell('plain')] },
  ] } }] };
  assert.equal(docsBodyToMarkdown(body), '| Head | Other |\n| --- | --- |\n| before [nested table: x y] | plain |');
});
