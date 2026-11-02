/**
 * Anchor resolution for Google Docs writes (plan 002 Phase 4, unit B) --
 * finding a heading or a passage of text WITHIN ONE TAB's body and handing
 * back its position, so src/docs/writes.ts can build a batchUpdate request.
 * No Docs tool ever takes or returns a character index (CLAUDE.md); the
 * numbers this module produces stay inside the server and are used only to
 * build requests and to re-locate a paragraph for a report -- never printed
 * or accepted as a tool argument.
 *
 * Ported from a-bonus/google-docs-mcp's `findElements` (MIT,
 * src/googleDocsApiHelpers.ts, ~lines 486-579): each PARAGRAPH (top-level or
 * inside a table cell, recursing into nested tables) is one searchable unit
 * built from CONTIGUOUS text runs with a per-character index map. A unit
 * ends at any document-index discontinuity -- a non-text element (inline
 * image, footnote reference, page break) or a run whose startIndex isn't the
 * previous run's last index + 1. Building the map per character (not
 * firstRunStart + offset) keeps indices exact even when a run/style
 * boundary splits a word, so a phrase styled mid-way (bold, link, colour)
 * still matches. The paragraph (and table cell) is a HARD boundary: a
 * phrase spanning two paragraphs, or crossing an inline object, is not
 * matched. Unlike upstream, we already have the whole tab body in memory
 * (no field mask, no extra fetch) and we recurse into tables nested inside
 * table cells, not just one level.
 */
import type { docs_v1 } from 'googleapis';

const HEADING_STYLE_RE = /^HEADING_\d+$|^TITLE$|^SUBTITLE$/;
const CONTEXT_MAX_CHARS = 120;

export interface HeadingMatch {
  text: string;
  /** The paragraph's namedStyleType, e.g. "HEADING_2", "TITLE". */
  level: string;
  startIndex: number;
  endIndex: number;
}

export interface TextMatch {
  startIndex: number;
  endIndex: number;
  /** The whole containing paragraph's plain text, trimmed, for a refusal message. */
  context: string;
}

export interface ParagraphAt {
  startIndex: number;
  endIndex: number;
  text: string;
}

function paragraphPlainText(paragraph: docs_v1.Schema$Paragraph): string {
  let out = '';
  for (const el of paragraph.elements ?? []) out += el.textRun?.content ?? '';
  return out;
}

function contextSnippet(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > CONTEXT_MAX_CHARS ? `${trimmed.slice(0, CONTEXT_MAX_CHARS)}…` : trimmed;
}

/**
 * Every top-level paragraph in `body` whose named style is HEADING_n / TITLE
 * / SUBTITLE, regardless of text -- the candidate list for a refusal.
 * Headings inside a table cell are not included: a heading is a document
 * structure element, not something an author puts inside a cell.
 */
export function listHeadings(body: docs_v1.Schema$Body | undefined | null): HeadingMatch[] {
  const out: HeadingMatch[] = [];
  for (const el of body?.content ?? []) {
    const paragraph = el.paragraph;
    if (!paragraph) continue;
    const styleType = paragraph.paragraphStyle?.namedStyleType;
    if (!styleType || !HEADING_STYLE_RE.test(styleType)) continue;
    if (el.startIndex == null || el.endIndex == null) continue;
    out.push({ text: paragraphPlainText(paragraph).trim(), level: styleType, startIndex: el.startIndex, endIndex: el.endIndex });
  }
  return out;
}

export function formatHeadingList(headings: HeadingMatch[]): string {
  if (headings.length === 0) return '(this tab has no headings)';
  return headings.map((h) => `- [${h.level}] ${h.text || '(empty heading)'}`).join('\n');
}

/**
 * Headings in `body` whose trimmed text equals `query` trimmed,
 * case-insensitively. Zero, one, or (if the doc has a duplicate heading)
 * more than one result -- the caller decides what each count means.
 */
export function findHeadings(body: docs_v1.Schema$Body | undefined | null, query: string): HeadingMatch[] {
  const wanted = query.trim().toLowerCase();
  return listHeadings(body).filter((h) => h.text.toLowerCase() === wanted);
}

/**
 * Every non-overlapping, case-sensitive, exact occurrence of `query` in
 * `body`, searching top-level paragraphs and paragraphs inside table cells
 * (recursing into a table nested inside a cell). See the module doc for the
 * contiguous-run-unit rule that keeps this from matching across a paragraph
 * boundary or an inline object.
 */
export function findText(body: docs_v1.Schema$Body | undefined | null, query: string): TextMatch[] {
  if (!query) return [];

  interface Unit { text: string; map: number[] }
  const units: Unit[] = [];

  const collect = (content: docs_v1.Schema$StructuralElement[] | undefined | null): void => {
    for (const el of content ?? []) {
      if (el.paragraph) {
        let text = '';
        let map: number[] = [];
        const flush = (): void => {
          if (map.length > 0) units.push({ text, map });
          text = '';
          map = [];
        };
        for (const pe of el.paragraph.elements ?? []) {
          const runText = pe.textRun?.content;
          if (runText != null && pe.startIndex != null) {
            if (map.length > 0 && pe.startIndex !== map[map.length - 1] + 1) flush();
            for (let i = 0; i < runText.length; i++) {
              text += runText[i];
              map.push(pe.startIndex + i);
            }
          } else {
            flush(); // non-text element (inline image, footnote ref, ...) ends the unit
          }
        }
        flush();
      } else if (el.table) {
        for (const row of el.table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) {
            collect(cell.content); // recurses into a table nested inside this cell too
          }
        }
      }
    }
  };
  collect(body?.content);

  const results: TextMatch[] = [];
  for (const unit of units) {
    let from = 0;
    for (;;) {
      const at = unit.text.indexOf(query, from);
      if (at === -1) break;
      const startIndex = unit.map[at];
      const endIndex = unit.map[at + query.length - 1] + 1;
      results.push({ startIndex, endIndex, context: contextSnippet(unit.text) });
      from = at + query.length; // non-overlapping
    }
  }
  return results;
}

/**
 * The top-level-or-cell paragraph whose range contains `index`, recursing
 * into (nested) tables. Purely internal bookkeeping: used to re-locate a
 * paragraph after a write so the tool can print its text, never its index.
 */
export function paragraphAt(body: docs_v1.Schema$Body | undefined | null, index: number): ParagraphAt | null {
  const search = (content: docs_v1.Schema$StructuralElement[] | undefined | null): ParagraphAt | null => {
    for (const el of content ?? []) {
      if (el.startIndex == null || el.endIndex == null) continue;
      if (index < el.startIndex || index >= el.endIndex) continue;
      if (el.paragraph) {
        return { startIndex: el.startIndex, endIndex: el.endIndex, text: paragraphPlainText(el.paragraph).trim() };
      }
      if (el.table) {
        for (const row of el.table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) {
            const found = search(cell.content);
            if (found) return found;
          }
        }
      }
    }
    return null;
  };
  return search(body?.content);
}

/** The body's last top-level paragraph (never inside a table). */
export function lastParagraph(body: docs_v1.Schema$Body | undefined | null): ParagraphAt | null {
  const content = body?.content ?? [];
  for (let i = content.length - 1; i >= 0; i--) {
    const el = content[i];
    if (el.paragraph && el.startIndex != null && el.endIndex != null) {
      return { startIndex: el.startIndex, endIndex: el.endIndex, text: paragraphPlainText(el.paragraph).trim() };
    }
  }
  return null;
}

/**
 * One past the body's very last character -- the position of its
 * un-deletable trailing newline plus one. `append_doc_text` inserts right
 * before that newline; this is what `E` means throughout src/docs/writes.ts.
 */
export function bodyEndIndex(body: docs_v1.Schema$Body | undefined | null): number {
  const content = body?.content ?? [];
  const last = content[content.length - 1];
  return last?.endIndex ?? 1;
}
