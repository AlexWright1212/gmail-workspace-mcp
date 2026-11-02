/**
 * Tab-addressed Google Docs reads (plan 002 Phase 3; the rule is
 * aaronsb/google-workspace-mcp's ADR-306, adopted here): every read walks
 * `document.tabs[]` and `childTabs[]` recursively and renders each tab from
 * its own `documentTab.body`, never from the legacy first-tab `document.body`.
 * `documents.get` must have been called with `includeTabsContent: true` --
 * without it Google returns the first tab only and nothing says the others
 * exist (spec 002, "First-tab blindness").
 *
 * A document whose text exceeds `indexThreshold` characters and was asked for
 * without a `tabId` returns the tab INDEX (title, id, depth, size) instead
 * of the text, so the caller reads tabs one at a time. Nothing is ever
 * truncated ("Silent truncation" in the spec).
 */
import type { docs_v1 } from 'googleapis';
import { docsBodyToMarkdown, docsBodyToPlainText } from './markdown.js';

/**
 * Plain-text characters above which a whole-document read returns the tab
 * index instead of the text. 60,000 is the plan's starting guess ("Still
 * only a guess"); revisit after Phase 5's transcripts.
 */
export const DEFAULT_INDEX_THRESHOLD = 60_000;

export interface FlatTab {
  tabId: string;
  title: string;
  /** 0 for a top-level tab, 1 for its child, ... */
  depth: number;
  parentTabId?: string;
  characters: number;
  documentTab: docs_v1.Schema$DocumentTab;
}

/** Depth-first, document order: a parent, then its children, then the next sibling. */
export function flattenTabs(doc: docs_v1.Schema$Document): FlatTab[] {
  const out: FlatTab[] = [];
  const walk = (tabs: docs_v1.Schema$Tab[] | undefined | null, depth: number): void => {
    for (const tab of tabs ?? []) {
      const props = tab.tabProperties ?? {};
      const documentTab = tab.documentTab ?? {};
      out.push({
        tabId: props.tabId ?? '',
        title: props.title ?? '(untitled tab)',
        depth,
        parentTabId: props.parentTabId ?? undefined,
        characters: docsBodyToPlainText(documentTab.body).length,
        documentTab,
      });
      walk(tab.childTabs, depth + 1);
    }
  };
  walk(doc.tabs, 0);

  if (out.length === 0 && doc.body) {
    // Should not happen with includeTabsContent=true, but never render nothing
    // when Google gave us a body: treat it as the single first tab.
    out.push({
      tabId: 't.0',
      title: doc.title ?? '(untitled tab)',
      depth: 0,
      characters: docsBodyToPlainText(doc.body).length,
      documentTab: { body: doc.body, lists: doc.lists, inlineObjects: doc.inlineObjects, footnotes: doc.footnotes },
    });
  }
  return out;
}

export function renderTabMarkdown(tab: FlatTab): string {
  const dt = tab.documentTab;
  return docsBodyToMarkdown(dt.body, { lists: dt.lists, inlineObjects: dt.inlineObjects, footnotes: dt.footnotes });
}

export function formatTabIndex(tabs: FlatTab[]): string {
  return tabs
    .map((t) => `${'  '.repeat(t.depth)}- ${t.title} (tab_id: ${t.tabId}, ${t.characters.toLocaleString()} characters)`)
    .join('\n');
}

export interface RenderOptions {
  tabId?: string;
  /** Characters of plain text above which a whole-document read returns the index instead. */
  indexThreshold: number;
}

export type RenderedDocument =
  | { kind: 'content'; tabs: FlatTab[]; rendered: Array<{ tab: FlatTab; markdown: string }> }
  | { kind: 'index'; tabs: FlatTab[]; totalCharacters: number };

export function renderDocument(doc: docs_v1.Schema$Document, opts: RenderOptions): RenderedDocument {
  const tabs = flattenTabs(doc);
  if (tabs.length === 0 && !opts.tabId) return { kind: 'content', tabs, rendered: [] };

  if (opts.tabId) {
    const wanted = opts.tabId.trim();
    const tab = tabs.find((t) => t.tabId === wanted);
    if (!tab) {
      throw new Error(
        `No tab with tab_id "${wanted}" in this document. Tabs are:\n${formatTabIndex(tabs)}`,
      );
    }
    return { kind: 'content', tabs, rendered: [{ tab, markdown: renderTabMarkdown(tab) }] };
  }

  const totalCharacters = tabs.reduce((n, t) => n + t.characters, 0);
  if (totalCharacters > opts.indexThreshold) {
    return { kind: 'index', tabs, totalCharacters };
  }
  return { kind: 'content', tabs, rendered: tabs.map((tab) => ({ tab, markdown: renderTabMarkdown(tab) })) };
}
