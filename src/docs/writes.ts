/**
 * Google Docs writes (plan 002 Phase 4, unit B). Every function here takes
 * the raw `docs_v1.Docs` (and, for create_doc's folder move, `drive_v3.Drive`)
 * handle from `client.rawApis()` plus the account id -- no new methods were
 * added to src/gmail-client.ts (it is 3,200 lines and three Phase 4 units
 * would collide in it).
 *
 * THE TAB RULE (resolveTargetTab), identical for every edit tool: `tab_id`
 * given and valid -> that tab; given and unknown -> refused, naming the tab
 * index, nothing written; omitted on a one-tab doc -> that tab; omitted on a
 * multi-tab doc -> refused with the tab index, nothing written.
 *
 * Every batchUpdate here carries `tabId` on every location/range it sends
 * AND `writeControl.requiredRevisionId` set to the revisionId of the SAME
 * `documents.get` the positions were computed from, so a concurrent edit is
 * rejected by Google rather than landing in the wrong place (CLAUDE.md,
 * spec 002 "Stale positions"). No Docs tool ever takes or returns a
 * character index -- the indices below are computed fresh from a
 * `documents.get` inside each call and never appear in a tool's input or
 * output; only the resulting paragraph TEXT is reported.
 *
 * Anchor resolution (heading / text) is src/docs/anchors.ts, ported from
 * a-bonus/google-docs-mcp's `findElements`. See that module's doc comment
 * for the contiguous-run-unit rule.
 */
import type { docs_v1, drive_v3 } from 'googleapis';
import { describeGoogleApiError } from '../gmail-client.js';
import { flattenTabs, formatTabIndex, type FlatTab } from './tabs.js';
import { bodyEndIndex, findHeadings, findText, formatHeadingList, listHeadings, paragraphAt } from './anchors.js';

async function callDocs<T>(accountId: string, fallback: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(describeGoogleApiError(error, { service: 'Docs', accountId, fallback }));
  }
}

async function callDrive<T>(accountId: string, fallback: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(describeGoogleApiError(error, { service: 'Drive', accountId, fallback }));
  }
}

/** At most this many candidates are listed in an ambiguous-anchor refusal. */
export const MAX_LISTED_CANDIDATES = 10;

function listCandidates(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED_CANDIDATES).map((item, i) => `${i + 1}. ${item}`);
  if (items.length > MAX_LISTED_CANDIDATES) shown.push(`… and ${items.length - MAX_LISTED_CANDIDATES} more`);
  return shown.join('\n');
}

/**
 * A paragraph's trailing newline is part of its text in the Docs API, so a
 * query containing one could match through a paragraph boundary and a
 * replace would then merge two paragraphs. Anchors and find strings are
 * single-line by rule.
 */
function assertSingleLine(value: string, argName: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${argName} must not contain a line break -- it names text within one paragraph.`);
  }
}

async function fetchDoc(docsApi: docs_v1.Docs, accountId: string, documentId: string): Promise<docs_v1.Schema$Document> {
  return callDocs(accountId, 'Docs read failed.', async () => {
    const res = await docsApi.documents.get({ documentId, includeTabsContent: true });
    return res.data;
  });
}

async function batchUpdate(
  docsApi: docs_v1.Docs,
  accountId: string,
  documentId: string,
  requests: docs_v1.Schema$Request[],
  requiredRevisionId: string | null | undefined,
): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
  return callDocs(accountId, 'Docs write failed.', async () => {
    if (!requiredRevisionId) {
      // Without a revision id the write cannot be pinned to the document the
      // indices were computed from; refusing is safer than a silent edit that
      // may land in the wrong place (plan 002, "Stale positions").
      throw new Error('Google returned no revisionId for this document, so the edit cannot be safely applied. Retry.');
    }
    const res = await docsApi.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
        writeControl: { requiredRevisionId },
      },
    });
    return res.data;
  });
}

/** THE TAB RULE. A plain Error (never wrapped through describeGoogleApiError --
 * this is the tool refusing, not Google) naming the candidates, same message
 * shape as renderDocument's "No tab with tab_id" (src/docs/tabs.ts). */
export function resolveTargetTab(doc: docs_v1.Schema$Document, tabId?: string): FlatTab {
  const tabs = flattenTabs(doc);
  if (tabId && tabId.trim()) {
    const wanted = tabId.trim();
    const tab = tabs.find((t) => t.tabId === wanted);
    if (!tab) {
      throw new Error(`No tab with tab_id "${wanted}" in this document. Tabs are:\n${formatTabIndex(tabs)}`);
    }
    return tab;
  }
  if (tabs.length === 1) return tabs[0];
  if (tabs.length === 0) {
    throw new Error('This document has no tabs to write to.');
  }
  throw new Error(
    `This document has more than one tab; pass tab_id to say which one to edit. Tabs are:\n${formatTabIndex(tabs)}`,
  );
}

function styleResetRequests(tabId: string, textStart: number, textLength: number): docs_v1.Schema$Request[] {
  const range: docs_v1.Schema$Range = { startIndex: textStart, endIndex: textStart + textLength, tabId };
  return [
    { updateParagraphStyle: { range, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
    { deleteParagraphBullets: { range } },
  ];
}

function refetchTab(after: docs_v1.Schema$Document, tabId: string): FlatTab {
  const tab = flattenTabs(after).find((t) => t.tabId === tabId);
  if (!tab) throw new Error(`Tab "${tabId}" is gone after the write -- re-read the document.`);
  return tab;
}

// ─── create_doc ─────────────────────────────────────────────────────────────

export interface CreateDocResult {
  documentId: string;
  url: string;
  parents?: string[];
}

/** `createDocument` is reused from GmailAccountClient (its caller already has
 * `{ documentId, url }`); this only does the optional folder move, exactly as
 * `create_spreadsheet` (unit A) does: `files.get` for current parents, then
 * `files.update` addParents/removeParents, then a read-back for the parents
 * Google now reports. */
export async function moveDocToFolder(
  driveApi: drive_v3.Drive,
  accountId: string,
  documentId: string,
  folderId: string,
): Promise<string[]> {
  const current = await callDrive(accountId, 'Drive file lookup failed.', async () => {
    const res = await driveApi.files.get({ fileId: documentId, fields: 'parents', supportsAllDrives: true });
    return res.data;
  });
  const removeParents = (current.parents ?? []).join(',');
  await callDrive(accountId, 'Moving the document into the folder failed.', () =>
    driveApi.files.update({
      fileId: documentId,
      addParents: folderId,
      removeParents: removeParents || undefined,
      supportsAllDrives: true,
      fields: 'id',
    }),
  );
  const after = await callDrive(accountId, 'Drive file lookup failed.', async () => {
    const res = await driveApi.files.get({ fileId: documentId, fields: 'parents', supportsAllDrives: true });
    return res.data;
  });
  return after.parents ?? [];
}

// ─── append_doc_text ────────────────────────────────────────────────────────

export interface AppendDocTextArgs {
  text: string;
  tabId?: string;
  style: 'NORMAL_TEXT' | 'HEADING_1' | 'HEADING_2' | 'HEADING_3';
}

export interface AppendDocTextResult {
  tab: FlatTab;
  paragraphText: string;
}

export async function appendDocText(
  docsApi: docs_v1.Docs,
  accountId: string,
  documentId: string,
  args: AppendDocTextArgs,
): Promise<AppendDocTextResult> {
  const doc = await fetchDoc(docsApi, accountId, documentId);
  const tab = resolveTargetTab(doc, args.tabId);
  const body = tab.documentTab.body;
  const E = bodyEndIndex(body);

  const requests: docs_v1.Schema$Request[] = [
    { insertText: { endOfSegmentLocation: { tabId: tab.tabId }, text: `\n${args.text}` } },
    ...styleResetRequestsNamed(tab.tabId, E, args.text.length, args.style),
  ];
  await batchUpdate(docsApi, accountId, documentId, requests, doc.revisionId);

  const after = await fetchDoc(docsApi, accountId, documentId);
  const afterTab = refetchTab(after, tab.tabId);
  const p = paragraphAt(afterTab.documentTab.body, E);
  return { tab: afterTab, paragraphText: p?.text ?? args.text.trim() };
}

/** Like styleResetRequests, but with the named style append_doc_text asks for
 * instead of a hard-coded NORMAL_TEXT reset -- still ALWAYS applied so an
 * appended paragraph is never a bullet or a heading unless asked. */
function styleResetRequestsNamed(
  tabId: string,
  textStart: number,
  textLength: number,
  namedStyleType: string,
): docs_v1.Schema$Request[] {
  const range: docs_v1.Schema$Range = { startIndex: textStart, endIndex: textStart + textLength, tabId };
  return [
    { updateParagraphStyle: { range, paragraphStyle: { namedStyleType }, fields: 'namedStyleType' } },
    { deleteParagraphBullets: { range } },
  ];
}

// ─── replace_doc_text ───────────────────────────────────────────────────────

export interface ReplaceDocTextArgs {
  find: string;
  replaceWith: string;
  tabId?: string;
  matchCase: boolean;
}

export interface ReplaceDocTextResult {
  tab: FlatTab;
  occurrencesChanged: number;
}

export async function replaceDocText(
  docsApi: docs_v1.Docs,
  accountId: string,
  documentId: string,
  args: ReplaceDocTextArgs,
): Promise<ReplaceDocTextResult> {
  assertSingleLine(args.find, 'find');
  const doc = await fetchDoc(docsApi, accountId, documentId);
  const tab = resolveTargetTab(doc, args.tabId);

  const requests: docs_v1.Schema$Request[] = [
    {
      replaceAllText: {
        containsText: { text: args.find, matchCase: args.matchCase },
        replaceText: args.replaceWith,
        tabsCriteria: { tabIds: [tab.tabId] },
      },
    },
  ];
  const res = await batchUpdate(docsApi, accountId, documentId, requests, doc.revisionId);
  const occurrencesChanged = res.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
  return { tab, occurrencesChanged };
}

// ─── insert_doc_text ────────────────────────────────────────────────────────

export interface InsertDocTextArgs {
  text: string;
  position: 'before' | 'after' | 'replace';
  heading?: string;
  anchorText?: string;
  tabId?: string;
}

export interface InsertDocTextResult {
  tab: FlatTab;
  paragraphText: string;
  anchorDescription: string;
}

export async function insertDocText(
  docsApi: docs_v1.Docs,
  accountId: string,
  documentId: string,
  args: InsertDocTextArgs,
): Promise<InsertDocTextResult> {
  const hasHeading = !!args.heading && args.heading.trim() !== '';
  const hasAnchorText = !!args.anchorText && args.anchorText.trim() !== '';
  if (hasHeading === hasAnchorText) {
    throw new Error('Pass exactly one of "heading" or "anchor_text" to say where to insert.');
  }

  const doc = await fetchDoc(docsApi, accountId, documentId);
  const tab = resolveTargetTab(doc, args.tabId);
  const body = tab.documentTab.body;

  let requests: docs_v1.Schema$Request[];
  let targetIndex: number;
  let anchorDescription: string;

  if (hasHeading) {
    const query = args.heading!.trim();
    const matches = findHeadings(body, query);
    if (matches.length === 0) {
      throw new Error(
        `No heading "${query}" found in tab "${tab.title}". Headings in this tab:\n${formatHeadingList(listHeadings(body))}`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Heading "${query}" appears ${matches.length} times in tab "${tab.title}"; each occurrence:\n${listCandidates(
          matches.map((m) => `[${m.level}] "${m.text}"`),
        )}\nThis anchor is not unique -- narrow it, or use a different heading.`,
      );
    }
    const heading = matches[0];
    anchorDescription = `heading "${heading.text}"`;

    if (args.position === 'replace') {
      requests = [
        { deleteContentRange: { range: { startIndex: heading.startIndex, endIndex: heading.endIndex - 1, tabId: tab.tabId } } },
        { insertText: { location: { index: heading.startIndex, tabId: tab.tabId }, text: args.text } },
      ];
      targetIndex = heading.startIndex;
    } else if (args.position === 'before') {
      const insertAt = heading.startIndex;
      requests = [
        { insertText: { location: { index: insertAt, tabId: tab.tabId }, text: `${args.text}\n` } },
        ...styleResetRequests(tab.tabId, insertAt, args.text.length),
      ];
      targetIndex = insertAt;
    } else {
      // after
      const isLastParagraphOfBody = heading.endIndex === bodyEndIndex(body);
      if (isLastParagraphOfBody) {
        const E = heading.endIndex;
        requests = [
          { insertText: { location: { index: E - 1, tabId: tab.tabId }, text: `\n${args.text}` } },
          ...styleResetRequests(tab.tabId, E, args.text.length),
        ];
        targetIndex = E;
      } else {
        const insertAt = heading.endIndex;
        requests = [
          { insertText: { location: { index: insertAt, tabId: tab.tabId }, text: `${args.text}\n` } },
          ...styleResetRequests(tab.tabId, insertAt, args.text.length),
        ];
        targetIndex = insertAt;
      }
    }
  } else {
    const query = args.anchorText!;
    assertSingleLine(query, 'anchor_text');
    const matches = findText(body, query);
    if (matches.length === 0) {
      throw new Error(`Text "${query}" not found in tab "${tab.title}".`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Text "${query}" appears ${matches.length} times in tab "${tab.title}"; each occurrence:\n${listCandidates(
          matches.map((m) => `…${m.context}…`),
        )}\nThis anchor is not unique -- narrow it so it matches exactly one place.`,
      );
    }
    const m = matches[0];
    anchorDescription = `text "${query}"`;

    if (args.position === 'replace') {
      requests = [
        { deleteContentRange: { range: { startIndex: m.startIndex, endIndex: m.endIndex, tabId: tab.tabId } } },
        { insertText: { location: { index: m.startIndex, tabId: tab.tabId }, text: args.text } },
      ];
      targetIndex = m.startIndex;
    } else if (args.position === 'before') {
      requests = [{ insertText: { location: { index: m.startIndex, tabId: tab.tabId }, text: args.text } }];
      targetIndex = m.startIndex;
    } else {
      requests = [{ insertText: { location: { index: m.endIndex, tabId: tab.tabId }, text: args.text } }];
      targetIndex = m.endIndex;
    }
  }

  await batchUpdate(docsApi, accountId, documentId, requests, doc.revisionId);

  const after = await fetchDoc(docsApi, accountId, documentId);
  const afterTab = refetchTab(after, tab.tabId);
  const p = paragraphAt(afterTab.documentTab.body, targetIndex);
  return { tab: afterTab, paragraphText: p?.text ?? args.text.trim(), anchorDescription };
}
