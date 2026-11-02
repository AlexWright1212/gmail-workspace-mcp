/**
 * Google Docs body -> Markdown (plan 002 Phase 3).
 *
 * Ported from a-bonus/google-docs-mcp `src/markdown-transformer/docsToMarkdown.ts`
 * (MIT), retyped against googleapis' `docs_v1.Schema$*` and extended where
 * the spec demands it:
 *  - one tab's body at a time (`docsBodyToMarkdown(body, tab)`), never the
 *    legacy first-tab `document.body` -- see src/docs/tabs.ts;
 *  - inline images and footnotes become visible markers instead of vanishing
 *    (spec 002, "content the Markdown form cannot carry ... is noted in
 *    place rather than dropped without trace");
 *  - horizontal rules render as `---`; table cell text escapes `|`.
 * Headings, bold/italic/strikethrough/underline, links, monospace-as-code,
 * nested ordered/unordered lists, tables and 1x1 "code block" tables all
 * behave as upstream. test/docs-markdown.test.mjs holds the cases.
 */
import type { docs_v1 } from 'googleapis';

const CODE_FONT_FAMILIES = new Set(['Roboto Mono', 'Courier New', 'Consolas', 'monospace']);

/** The per-tab lookups a body needs to render. */
export interface TabContext {
  lists?: Record<string, docs_v1.Schema$List> | null;
  inlineObjects?: Record<string, docs_v1.Schema$InlineObject> | null;
  footnotes?: Record<string, docs_v1.Schema$Footnote> | null;
}

export function docsBodyToMarkdown(body: docs_v1.Schema$Body | undefined | null, ctx: TabContext = {}): string {
  if (!body?.content) return '';
  const state: RenderState = { ctx, footnotesUsed: [] };
  let md = '';
  body.content.forEach((element, i) => {
    // Every Docs body (and every tab) opens with a sectionBreak element. It
    // marks where the body starts, not a rule the author drew, so it is not
    // rendered; later section breaks are.
    if (i === 0 && element.sectionBreak) return;
    md += convertStructuralElement(element, state);
  });
  md = md.replace(/\n{3,}/g, '\n\n').trim();
  if (state.footnotesUsed.length > 0) {
    md += '\n\n' + state.footnotesUsed
      .map((id, i) => `[^${i + 1}]: ${footnoteText(state.ctx.footnotes?.[id])}`)
      .join('\n');
  }
  return md;
}

/** Plain text of a body, no formatting -- what size thresholds and anchors count. */
export function docsBodyToPlainText(body: docs_v1.Schema$Body | undefined | null): string {
  let out = '';
  for (const el of body?.content ?? []) {
    if (el.paragraph) {
      for (const pe of el.paragraph.elements ?? []) out += pe.textRun?.content ?? '';
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) out += docsBodyToPlainText({ content: cell.content ?? [] });
      }
    }
  }
  return out;
}

interface RenderState {
  ctx: TabContext;
  footnotesUsed: string[];
}

function convertStructuralElement(element: docs_v1.Schema$StructuralElement, state: RenderState): string {
  if (element.paragraph) return convertParagraph(element.paragraph, state);
  if (element.table) return convertTable(element.table, state);
  if (element.sectionBreak) return '\n---\n\n';
  return '';
}

// ─── Paragraphs ─────────────────────────────────────────────────────────────

function convertParagraph(paragraph: docs_v1.Schema$Paragraph, state: RenderState): string {
  const headingLevel = getHeadingLevel(paragraph);
  const listInfo = getListInfo(paragraph, state.ctx.lists ?? {});
  const text = extractFormattedText(paragraph.elements ?? [], state);

  if (headingLevel && text.trim()) {
    return `${'#'.repeat(Math.min(headingLevel, 6))} ${text.trim()}\n\n`;
  }
  if (listInfo && text.trim()) {
    const indent = '  '.repeat(listInfo.nestingLevel);
    const marker = listInfo.ordered ? '1.' : '-';
    return `${indent}${marker} ${text.trim()}\n`;
  }
  if (text.trim()) return `${text.trim()}\n\n`;
  return '\n';
}

function getHeadingLevel(paragraph: docs_v1.Schema$Paragraph): number | null {
  const styleType = paragraph.paragraphStyle?.namedStyleType;
  if (!styleType) return null;
  if (styleType === 'TITLE') return 1;
  if (styleType === 'SUBTITLE') return 2;
  const match = /^HEADING_(\d)$/.exec(styleType);
  return match ? Number(match[1]) : null;
}

interface ListInfo { ordered: boolean; nestingLevel: number }

function getListInfo(paragraph: docs_v1.Schema$Paragraph, lists: Record<string, docs_v1.Schema$List>): ListInfo | null {
  if (!paragraph.bullet) return null;
  const nestingLevel = paragraph.bullet.nestingLevel ?? 0;
  const listId = paragraph.bullet.listId ?? undefined;
  let ordered = false;
  const levels = listId ? lists[listId]?.listProperties?.nestingLevels : undefined;
  const level = levels?.[nestingLevel];
  // glyphType is set for ordered lists (DECIMAL, ALPHA, ROMAN ...); unordered
  // lists carry glyphSymbol instead.
  if (level?.glyphType && level.glyphType !== 'GLYPH_TYPE_UNSPECIFIED') ordered = true;
  return { ordered, nestingLevel };
}

// ─── Inline elements ────────────────────────────────────────────────────────

function extractFormattedText(elements: docs_v1.Schema$ParagraphElement[], state: RenderState): string {
  let result = '';
  for (const element of elements) {
    if (element.textRun) {
      result += convertTextRun(element.textRun);
    } else if (element.inlineObjectElement) {
      result += inlineObjectMarker(element.inlineObjectElement, state.ctx);
    } else if (element.footnoteReference) {
      result += footnoteMarker(element.footnoteReference, state);
    } else if (element.horizontalRule) {
      result += '\n---\n';
    }
    // pageBreak, columnBreak, equation, person, richLink, autoText: no text form.
    // A richLink (smart chip) has a title we can show:
    if (element.richLink?.richLinkProperties?.title) {
      const p = element.richLink.richLinkProperties;
      result += p.uri ? `[${p.title}](${p.uri})` : p.title;
    }
    if (element.person?.personProperties?.name) {
      result += `@${element.person.personProperties.name}`;
    }
  }
  return result;
}

function inlineObjectMarker(el: docs_v1.Schema$InlineObjectElement, ctx: TabContext): string {
  const id = el.inlineObjectId ?? '';
  const embedded = id ? ctx.inlineObjects?.[id]?.inlineObjectProperties?.embeddedObject : undefined;
  const label = embedded?.title || embedded?.description;
  return label ? `[image: ${label}]` : `[image${id ? ` ${id}` : ''}]`;
}

function footnoteMarker(ref: docs_v1.Schema$FootnoteReference, state: RenderState): string {
  const id = ref.footnoteId ?? '';
  let index = state.footnotesUsed.indexOf(id);
  if (index < 0) { state.footnotesUsed.push(id); index = state.footnotesUsed.length - 1; }
  return `[^${index + 1}]`;
}

function footnoteText(fn: docs_v1.Schema$Footnote | undefined): string {
  if (!fn) return '(footnote text unavailable)';
  return docsBodyToPlainText({ content: fn.content ?? [] }).replace(/\s+/g, ' ').trim() || '(empty footnote)';
}

function convertTextRun(textRun: docs_v1.Schema$TextRun): string {
  const text = textRun.content ?? '';
  const style = textRun.textStyle;
  if (!style) return text;

  // Monospace -> code span; no nested formatting inside a code span.
  if (isCodeStyled(style)) {
    const trimmed = text.replace(/\n$/, '');
    if (trimmed) return `\`${trimmed}\`${text.endsWith('\n') ? '\n' : ''}`;
    return text;
  }

  // Keep the trailing newline outside the markers ("**text**\n", not "**text\n**").
  const trailingNewline = text.endsWith('\n');
  const content = trailingNewline ? text.slice(0, -1) : text;
  if (!content) return text;

  let formatted = content;
  if (style.bold && style.italic) formatted = `***${formatted}***`;
  else if (style.bold) formatted = `**${formatted}**`;
  else if (style.italic) formatted = `*${formatted}*`;
  if (style.strikethrough) formatted = `~~${formatted}~~`;
  if (style.underline && !style.link) formatted = `<u>${formatted}</u>`;
  if (style.link?.url) formatted = `[${formatted}](${style.link.url})`;
  return formatted + (trailingNewline ? '\n' : '');
}

function isCodeStyled(style: docs_v1.Schema$TextStyle): boolean {
  const fontFamily = style.weightedFontFamily?.fontFamily;
  return typeof fontFamily === 'string' && CODE_FONT_FAMILIES.has(fontFamily);
}

// ─── Tables ─────────────────────────────────────────────────────────────────

function convertTable(table: docs_v1.Schema$Table, state: RenderState): string {
  const rows = table.tableRows ?? [];
  if (rows.length === 0) return '';
  if (isCodeBlockTable(table)) return convertCodeBlockTable(table);

  let md = '\n';
  let first = true;
  for (const row of rows) {
    const cells = row.tableCells ?? [];
    if (cells.length === 0) continue;
    md += '|' + cells.map((cell) => ` ${extractCellText(cell, state)} |`).join('') + '\n';
    if (first) {
      md += '|' + cells.map(() => ' --- |').join('') + '\n';
      first = false;
    }
  }
  return md + '\n';
}

/** Google Docs' "Code block" building block is a styled 1x1 table. */
function isCodeBlockTable(table: docs_v1.Schema$Table): boolean {
  const rows = table.tableRows ?? [];
  if (rows.length !== 1) return false;
  const cells = rows[0].tableCells ?? [];
  if (cells.length !== 1) return false;
  const cell = cells[0];

  const bg = cell.tableCellStyle?.backgroundColor?.color?.rgbColor;
  if (bg) {
    const r = bg.red ?? 0, g = bg.green ?? 0, b = bg.blue ?? 0;
    if (r > 0.85 && g > 0.85 && b > 0.85 && r < 1 && g < 1 && b < 1) return true;
  }
  for (const element of cell.content ?? []) {
    for (const pe of element.paragraph?.elements ?? []) {
      if (pe.textRun?.textStyle && isCodeStyled(pe.textRun.textStyle)) return true;
    }
  }
  return false;
}

function convertCodeBlockTable(table: docs_v1.Schema$Table): string {
  const cell = table.tableRows![0].tableCells![0];
  let code = docsBodyToPlainText({ content: cell.content ?? [] });
  if (code.endsWith('\n')) code = code.slice(0, -1);
  return '\n```\n' + code + '\n```\n\n';
}

function extractCellText(cell: docs_v1.Schema$TableCell, state: RenderState): string {
  let text = '';
  for (const element of cell.content ?? []) {
    if (element.paragraph?.elements) {
      text += extractFormattedText(element.paragraph.elements, state).replace(/\n/g, ' ').trim() + ' ';
    } else if (element.table) {
      // A table inside a cell has no Markdown form; keep its text, marked,
      // rather than dropping it without trace (spec 002).
      const inner = docsBodyToPlainText({ content: [element] }).replace(/\s+/g, ' ').trim();
      text += `[nested table: ${inner || '(empty)'}] `;
    }
  }
  return text.trim().replace(/\|/g, '\\|');
}
