/**
 * Google Docs tools. Moved out of src/index.ts during the plan 002 Phase 1
 * registry restructure. read_doc (Phase 3, listed on the workspace endpoint)
 * replaces the inherited docs_get, which asked Google for the document
 * without tab content -- so it saw only the first tab -- and then cut the
 * text at 2,000 characters (spec 002, "Known Symptoms To Avoid"). read_doc
 * renders every tab through src/docs/tabs.ts and never truncates.
 *
 * The write tools below it (Phase 4, plan 002 unit B) replace the inherited
 * docs_create / docs_append / docs_replace_text -- the old docs_append
 * computed its insertion point from the legacy first-tab body -- and delete
 * docs_insert_table / docs_apply_style outright, with no replacement: both
 * took character indices from the caller, which CLAUDE.md forbids ("No Docs
 * tool ever takes or returns a character index"). Every write below is
 * tab-addressed (src/docs/writes.ts' resolveTargetTab, "the tab rule") and,
 * for insert_doc_text, anchor-based (src/docs/anchors.ts, ported from
 * a-bonus/google-docs-mcp's findElements) -- the model names a heading or a
 * unique passage, never a position, and the server resolves it at call time
 * against a writeControl.requiredRevisionId so a concurrent edit is
 * rejected by Google rather than landing in the wrong place.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { docs_v1 } from 'googleapis';
import { resolveWriteAccount } from '../accounts.js';
import type { AccountConfig } from '../config.js';
import { DEFAULT_INDEX_THRESHOLD, formatTabIndex, renderDocument, type RenderedDocument } from '../docs/tabs.js';
import { appendDocText, insertDocText, moveDocToFolder, replaceDocText } from '../docs/writes.js';
import { textResult, valueToBoolean, valueToString } from './shared.js';
import type { ToolContext, ToolDefinition, ToolHandler, ToolModule } from './types.js';

const ACCOUNT_REQUIRED = 'Account the document id belongs to: "personal" or "tamu". Required.';
const TAB_ID_PARAM =
  'Which tab to edit, by tab_id from a previous read_doc result. Required when the document has more than one tab; a single-tab document does not need it and the tool uses its only tab.';

export const readDocTool: ToolDefinition = {
  name: 'read_doc',
  description:
    'Read a Google Doc as Markdown -- every tab, nested tabs included, with headings, lists, links and tables kept, and each tab labelled with its title and tab_id. Nothing is truncated: a very long document returns a tab index instead, and tab_id then reads one tab. Find the document id with search_drive_files (type document).',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'Account the document id belongs to: "personal" or "tamu". Required.' },
      document_id: { type: 'string', description: 'Google Docs document id.' },
      tab_id: { type: 'string', description: 'Optional: read only this tab (ids come from a previous read_doc result).' },
    },
    required: ['account', 'document_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

export const createDocTool: ToolDefinition = {
  name: 'create_doc',
  description:
    'Create a new, empty Google Doc with the given title, optionally inside a Drive folder. Reports the document id, URL and, if a folder was given, the parent folders Google confirms after the move. Add content afterwards with append_doc_text or insert_doc_text -- this tool never writes text.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      title: { type: 'string', description: 'Title for the new document.' },
      folder_id: { type: 'string', description: 'Optional: Drive folder id to move the new document into (from search_drive_files or list_drive_folder).' },
    },
    required: ['account', 'title'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};

export const appendDocTextTool: ToolDefinition = {
  name: 'append_doc_text',
  description:
    'Add a new paragraph at the end of one tab in a Google Doc, as its own last paragraph -- it is never merged into whatever paragraph was previously last. Optionally style the new paragraph as a heading; otherwise it is always plain text, never a bullet or a heading it did not ask for. Reports the paragraph Google now holds after re-reading the tab.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      document_id: { type: 'string', description: 'Google Docs document id.' },
      text: { type: 'string', description: 'Text of the new paragraph. No leading/trailing newline needed.' },
      tab_id: { type: 'string', description: TAB_ID_PARAM },
      style: {
        type: 'string',
        enum: ['NORMAL_TEXT', 'HEADING_1', 'HEADING_2', 'HEADING_3'],
        description: 'Paragraph style for the new paragraph. Default NORMAL_TEXT.',
      },
    },
    required: ['account', 'document_id', 'text'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};

export const replaceDocTextTool: ToolDefinition = {
  name: 'replace_doc_text',
  description:
    'Find and replace every occurrence of an exact phrase throughout one tab of a Google Doc. Only the named tab is touched -- the same phrase elsewhere in the document is untouched. Reports how many occurrences Google changed; zero means nothing matched and nothing changed.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      document_id: { type: 'string', description: 'Google Docs document id.' },
      find: { type: 'string', description: 'Exact text to find.' },
      replace_with: { type: 'string', description: 'Text to replace each occurrence with.' },
      tab_id: { type: 'string', description: TAB_ID_PARAM },
      match_case: { type: 'boolean', description: 'Case-sensitive match. Default false.' },
    },
    required: ['account', 'document_id', 'find', 'replace_with'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};

export const insertDocTextTool: ToolDefinition = {
  name: 'insert_doc_text',
  description:
    'Insert or replace text at a named place in one tab of a Google Doc -- directly under/above a heading, or immediately before/after/in place of a unique passage -- without ever handling a character position. Pass exactly one of heading or anchor_text. Refused, with every match listed, if the anchor is missing or matches more than one place; nothing is written when refused.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      document_id: { type: 'string', description: 'Google Docs document id.' },
      text: { type: 'string', description: 'Text to insert (or the replacement text, when position is "replace").' },
      position: {
        type: 'string',
        enum: ['before', 'after', 'replace'],
        description: 'Where text lands relative to the anchor: as a new paragraph before/after a heading, inline before/after a text passage, or in place of the anchor itself.',
      },
      heading: { type: 'string', description: 'Anchor: a heading\'s exact text (case-insensitive, whitespace-trimmed). Exactly one of heading/anchor_text is required.' },
      anchor_text: { type: 'string', description: 'Anchor: an exact, unique passage of body text (case-sensitive). Exactly one of heading/anchor_text is required.' },
      tab_id: { type: 'string', description: TAB_ID_PARAM },
    },
    required: ['account', 'document_id', 'text', 'position'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};

/**
 * Shared by read_doc and read_drive_file (Drive routes a Google Doc here) so
 * the two cannot render the same document differently.
 */
export function formatDocumentRead(
  doc: docs_v1.Schema$Document,
  rendered: RenderedDocument,
  opts: { account: AccountConfig; documentId: string },
): string {
  const id = doc.documentId ?? opts.documentId;
  const lines: string[] = [
    `# Google Doc: ${doc.title ?? '(untitled)'}`,
    '',
    `**Account**: ${opts.account.id} (${opts.account.email})`,
    `**Document ID**: ${id}`,
    `**URL**: https://docs.google.com/document/d/${id}/edit`,
    `**Tabs** (${rendered.tabs.length}):`,
    formatTabIndex(rendered.tabs),
    '',
  ];

  if (rendered.kind === 'index') {
    lines.push(
      `This document is ${rendered.totalCharacters.toLocaleString()} characters across ${rendered.tabs.length} tabs, above the ${DEFAULT_INDEX_THRESHOLD.toLocaleString()}-character single-read limit, so only the tab index is returned. Call read_doc again with tab_id to read one tab at a time; nothing is truncated.`,
    );
    return lines.join('\n');
  }

  if (rendered.rendered.length === 0) {
    lines.push('*(the document has no tabs and no body)*');
    return lines.join('\n');
  }

  for (const { tab, markdown } of rendered.rendered) {
    lines.push('---', `**Tab: ${tab.title}** (tab_id: ${tab.tabId})`, '', markdown || '*(empty tab)*', '');
  }
  return lines.join('\n');
}

function formatEditReport(opts: {
  summary: string;
  account: AccountConfig;
  documentId: string;
  tab: { title: string; tabId: string };
  extraLines?: string[];
  paragraphText: string;
}): string {
  const lines = [
    opts.summary,
    `Account: ${opts.account.id} (${opts.account.email})`,
    `Document ID: ${opts.documentId}`,
    `Tab: ${opts.tab.title} (tab_id: ${opts.tab.tabId})`,
  ];
  if (opts.extraLines?.length) lines.push(...opts.extraLines);
  lines.push('', 'Paragraph now:', '', opts.paragraphText || '(empty paragraph)');
  return lines.join('\n');
}

export async function handleReadDoc(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const account = valueToString(rawArgs.account);
  const config = await ctx.loadConfig();
  const acc = resolveWriteAccount(config, account);
  const client = await ctx.getClientForAccount(acc);
  const documentId = valueToString(rawArgs.document_id).trim();
  const tabId = valueToString(rawArgs.tab_id, '').trim() || undefined;
  const doc = await client.getDocumentWithTabs(documentId);
  const rendered = renderDocument(doc, { tabId, indexThreshold: DEFAULT_INDEX_THRESHOLD });
  return textResult(formatDocumentRead(doc, rendered, { account: acc, documentId }));
}

export async function handleCreateDoc(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const account = valueToString(rawArgs.account);
  const config = await ctx.loadConfig();
  const acc = resolveWriteAccount(config, account);
  const client = await ctx.getClientForAccount(acc);
  const title = valueToString(rawArgs.title).trim();
  if (!title) throw new Error('title is required.');

  const created = await client.createDocument(title);
  const folderId = valueToString(rawArgs.folder_id, '').trim() || undefined;

  const lines = [
    '✅ Google Doc created.',
    `Account: ${acc.id} (${acc.email})`,
    `Document ID: ${created.documentId}`,
    `URL: ${created.url}`,
  ];
  if (folderId) {
    const { drive } = client.rawApis();
    const parents = await moveDocToFolder(drive, acc.id, created.documentId, folderId);
    lines.push(`Parents: ${parents.length ? parents.join(', ') : '(none reported)'}`);
  }
  return textResult(lines.join('\n'));
}

export async function handleAppendDocText(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const account = valueToString(rawArgs.account);
  const config = await ctx.loadConfig();
  const acc = resolveWriteAccount(config, account);
  const client = await ctx.getClientForAccount(acc);
  const documentId = valueToString(rawArgs.document_id).trim();
  if (!documentId) throw new Error('document_id is required.');
  const text = valueToString(rawArgs.text);
  if (!text.trim()) throw new Error('text is required.');
  const tabId = valueToString(rawArgs.tab_id, '').trim() || undefined;
  const style = (valueToString(rawArgs.style, 'NORMAL_TEXT') || 'NORMAL_TEXT') as
    | 'NORMAL_TEXT'
    | 'HEADING_1'
    | 'HEADING_2'
    | 'HEADING_3';

  const { docs } = client.rawApis();
  const result = await appendDocText(docs, acc.id, documentId, { text, tabId, style });

  return textResult(
    formatEditReport({
      summary: '✅ Text appended to the tab.',
      account: acc,
      documentId,
      tab: result.tab,
      paragraphText: result.paragraphText,
    }),
  );
}

export async function handleReplaceDocText(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const account = valueToString(rawArgs.account);
  const config = await ctx.loadConfig();
  const acc = resolveWriteAccount(config, account);
  const client = await ctx.getClientForAccount(acc);
  const documentId = valueToString(rawArgs.document_id).trim();
  if (!documentId) throw new Error('document_id is required.');
  const find = valueToString(rawArgs.find);
  if (!find) throw new Error('find is required.');
  const replaceWith = valueToString(rawArgs.replace_with);
  const tabId = valueToString(rawArgs.tab_id, '').trim() || undefined;
  const matchCase = valueToBoolean(rawArgs.match_case, false);

  const { docs } = client.rawApis();
  const result = await replaceDocText(docs, acc.id, documentId, { find, replaceWith, tabId, matchCase });

  const summary =
    result.occurrencesChanged > 0
      ? `✅ Replaced ${result.occurrencesChanged} occurrence(s) of "${find}".`
      : `✅ Replace ran but changed nothing -- "${find}" was not found in this tab.`;

  return textResult(
    [
      summary,
      `Account: ${acc.id} (${acc.email})`,
      `Document ID: ${documentId}`,
      `Tab: ${result.tab.title} (tab_id: ${result.tab.tabId})`,
    ].join('\n'),
  );
}

export async function handleInsertDocText(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const account = valueToString(rawArgs.account);
  const config = await ctx.loadConfig();
  const acc = resolveWriteAccount(config, account);
  const client = await ctx.getClientForAccount(acc);
  const documentId = valueToString(rawArgs.document_id).trim();
  if (!documentId) throw new Error('document_id is required.');
  const text = valueToString(rawArgs.text);
  if (!text) throw new Error('text is required.');
  const position = valueToString(rawArgs.position) as 'before' | 'after' | 'replace';
  if (!['before', 'after', 'replace'].includes(position)) {
    throw new Error('position must be one of "before", "after", "replace".');
  }
  const heading = valueToString(rawArgs.heading, '').trim() || undefined;
  const anchorText = valueToString(rawArgs.anchor_text, '') || undefined;
  const tabId = valueToString(rawArgs.tab_id, '').trim() || undefined;

  const { docs } = client.rawApis();
  const result = await insertDocText(docs, acc.id, documentId, { text, position, heading, anchorText, tabId });

  return textResult(
    formatEditReport({
      summary: `✅ Text inserted (${position}, ${result.anchorDescription}).`,
      account: acc,
      documentId,
      tab: result.tab,
      paragraphText: result.paragraphText,
    }),
  );
}

export const definitions: ToolDefinition[] = [
  readDocTool,
  createDocTool,
  appendDocTextTool,
  replaceDocTextTool,
  insertDocTextTool,
];

export const handlers: Record<string, ToolHandler> = {
  read_doc: handleReadDoc,
  create_doc: handleCreateDoc,
  append_doc_text: handleAppendDocText,
  replace_doc_text: handleReplaceDocText,
  insert_doc_text: handleInsertDocText,
};

const docsModule: ToolModule = { definitions, handlers };
export default docsModule;
