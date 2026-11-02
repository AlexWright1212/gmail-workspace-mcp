/**
 * Google Drive tools. Moved out of src/index.ts during the plan 002 Phase 1
 * registry restructure; the READ tools (search_drive_files, list_drive_folder,
 * get_drive_file, read_drive_file) were reshaped in Phase 3 and are listed on
 * the workspace endpoint. The write tools below them are unchanged since
 * Phase 1 and listed nowhere until Phase 4. share_drive_file's allowlist
 * wiring (ADR 004) lives inside GmailAccountClient.shareDriveFile and is
 * untouched here; the tool itself is exposed on no endpoint (spec 002).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { drive_v3 } from 'googleapis';
import { promises as fs } from 'node:fs';
import { resolveReadAccounts, resolveWriteAccount } from '../accounts.js';
import { DRIVE_FILE_TYPES, describeGoogleApiError, type AttachmentMetadata, type DriveFileDetail, type DriveFileSummary, type DriveFileType } from '../gmail-client.js';
import { saveAndExtract } from '../attachments.js';
import { renderDocument, DEFAULT_INDEX_THRESHOLD } from '../docs/tabs.js';
import { formatDocumentRead } from './docs.js';
import { formatSpreadsheetMetadata } from './shared.js';
import { assertInsideOutbox, cleanupIfInOutbox, describeOutboxListing, listOutbox, resolveOutboxDir } from '../outbox.js';
import {
  textResult,
  clamp,
  valueToString,
  valueToNumber,
  valueToBoolean,
  driveFileDateForSort,
  formatDriveFileItem,
  formatDriveFileDetail,
  formatDriveFileListOutput,
  type SearchDriveFilesArgs,
} from './shared.js';
import type { ToolContext, ToolDefinition, ToolHandler, ToolModule } from './types.js';

const ACCOUNT_REQUIRED = 'Account to act as: "personal" or "tamu". Required -- use the account search_drive_files listed the file under; a file shared between the accounts works under either.';

export const searchDriveFilesTool: ToolDefinition = {
  name: 'search_drive_files',
  description:
    'Find files in Google Drive by name or by text inside them, newest first. Searches BOTH accounts unless account is given; every result names its account -- pass that account on later calls for the file. Filter with type (spreadsheet, document, folder, pdf, presentation). Use this first when the user names a file rather than an id.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to match in file names or file contents, e.g. "internship".' },
      account: { type: 'string', description: 'Optional: "personal" or "tamu". Omit to search both and merge.' },
      type: {
        type: 'string',
        enum: [...Object.keys(DRIVE_FILE_TYPES), 'any'],
        description: 'Restrict to one kind of file. Default any.',
      },
      max_results: { type: 'number', description: 'Maximum files to return (1-100, default 20).', default: 20 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
export const listDriveFolderTool: ToolDefinition = {
  name: 'list_drive_folder',
  description:
    'List the files and subfolders directly inside one Drive folder, newest first. Requires the folder id and its account (get both from search_drive_files with type folder). Not a search: use search_drive_files to find things by name.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      folder_id: { type: 'string', description: 'Drive folder id.' },
      max_results: { type: 'number', description: 'Maximum entries to return (1-200, default 50).', default: 50 },
      page_token: { type: 'string', description: 'Continue a previous listing from its "next page token".' },
    },
    required: ['account', 'folder_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
export const getDriveFileTool: ToolDefinition = {
  name: 'get_drive_file',
  description:
    'Metadata for one Drive file: name, type, size, parent folder ids, owners, modified time, link. Does not return content -- use read_drive_file for that.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      file_id: { type: 'string', description: 'Drive file id.' },
    },
    required: ['account', 'file_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
export const readDriveFileTool: ToolDefinition = {
  name: 'read_drive_file',
  description:
    'Read the text of a Drive file. A Google Doc comes back as Markdown with every tab (same as read_doc); a PDF, Word, PowerPoint or text file comes back as extracted text (scanned PDFs are OCRed); a Google Sheet returns its tab list and points you to the Sheets tools instead. Files with no text form are described, not dumped.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      file_id: { type: 'string', description: 'Drive file id.' },
    },
    required: ['account', 'file_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
export const createDriveFolderTool: ToolDefinition = {
  name: 'create_drive_folder',
  description:
    'Create a new folder in Google Drive, optionally inside a parent folder. Returns the new folder\'s id, name and parent -- pass the id to update_drive_file / upload_drive_file to place things in it. Does not move or rename anything that already exists.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      name: { type: 'string', description: 'Folder name.' },
      parent_id: { type: 'string', description: 'Optional Drive folder id to create the new folder inside. Omit to create it at the account\'s Drive root.' },
    },
    required: ['account', 'name'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};
export const updateDriveFileTool: ToolDefinition = {
  name: 'update_drive_file',
  description:
    'Rename a Drive file and/or move it into a different folder (give name and/or move_to_folder_id -- at least one is required). Moving removes the file from its current folder(s) and adds it to the new one; it does not copy the file. Not for editing a file\'s contents.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      file_id: { type: 'string', description: 'Drive file id, from search_drive_files or get_drive_file.' },
      name: { type: 'string', description: 'New file name. Omit to leave the name unchanged.' },
      move_to_folder_id: { type: 'string', description: 'Drive folder id to move the file into, from search_drive_files (type folder) or create_drive_folder. The file is removed from its current folder(s).' },
    },
    required: ['account', 'file_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};
export const trashDriveFileTool: ToolDefinition = {
  name: 'trash_drive_file',
  description:
    'Move a Drive file to trash. Recoverable from Google Drive\'s trash for a limited time -- this does not permanently delete it, and permanent deletion is not offered by this server. Reads the file back afterward to confirm it is trashed.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      file_id: { type: 'string', description: 'Drive file id.' },
    },
    required: ['account', 'file_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};
export const uploadDriveFileTool: ToolDefinition = {
  name: 'upload_drive_file',
  description:
    'Upload a file into Google Drive from the server\'s own outbox directory -- NOT from the calling client\'s machine, which this server cannot read directly. Call it WITHOUT path to see what is waiting in the outbox (nothing is uploaded); then call again with the filename. The outbox file is deleted once the upload succeeds.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: ACCOUNT_REQUIRED },
      path: {
        type: 'string',
        description:
          'The outbox file to upload: a bare filename as the outbox listing shows it (e.g. "report.pdf"), or its full path inside the outbox ("/root/.gmail-multi-mcp/outbox/report.pdf"). Omit to list the outbox instead of uploading. If the file lives on the machine you\'re running on, first copy it into the outbox (e.g. `scp <local path> root@100.64.0.10:/root/.gmail-multi-mcp/outbox/<filename>` over the same SSH access used for deploys). A path outside the outbox is refused before anything is uploaded.',
      },
      folder_id: { type: 'string', description: 'Optional Drive folder id to upload into. Omit to upload to the account\'s Drive root.' },
      name: { type: 'string', description: 'Optional filename to use in Drive. Defaults to the outbox file\'s own name.' },
      mime_type: { type: 'string', description: 'Optional MIME type override, e.g. "application/pdf". Guessed from the filename when omitted.' },
    },
    required: ['account'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};
export const shareDriveFileTool: ToolDefinition = {
          name: 'share_drive_file',
          description: 'Share a Google Drive file by adding a permission.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              file_id: { type: 'string', description: 'Google Drive file ID.' },
              email: { type: 'string', description: 'Email address of the person to share with (for type=user or type=group).' },
              role: { type: 'string', enum: ['reader', 'commenter', 'writer', 'owner'], description: 'Permission role.' },
              type: { type: 'string', enum: ['user', 'group', 'domain', 'anyone'], description: 'Permission type.' },
              send_notification: { type: 'boolean', description: 'Send notification email (default true).', default: true },
              notification_message: { type: 'string', description: 'Optional message included in the share notification email.' },
            },
            required: ['account', 'file_id', 'role', 'type'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true },
};
export async function handleSearchDriveFiles(
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
): Promise<CallToolResult> {
    const args: SearchDriveFilesArgs = {
      account: valueToString(rawArgs.account, '').trim() || undefined,
      query: valueToString(rawArgs.query, ''),
      max_results: valueToNumber(rawArgs.max_results, 20),
    };
    const type = (valueToString(rawArgs.type, 'any').trim() || 'any') as DriveFileType;
    if (type !== 'any' && !(type in DRIVE_FILE_TYPES)) {
      throw new Error(`Unknown type "${type}". Use one of: ${Object.keys(DRIVE_FILE_TYPES).join(', ')}, any.`);
    }

    if (!args.query || args.query.trim() === '') {
      throw new Error('query is required.');
    }

    const config = await ctx.loadConfig();
    const targetAccounts = resolveReadAccounts(config, args.account);
    const maxResults = clamp(args.max_results ?? 20, 1, 100);

    const accountResults = await Promise.all(
      targetAccounts.map(async (account) => {
        try {
          const client = await ctx.getClientForAccount(account);
          const files = await client.searchDriveFiles(args.query, maxResults, type);
          return { account, files, error: null as string | null };
        } catch (error) {
          return {
            account,
            files: [] as DriveFileSummary[],
            error: `${account.id}: ${(error as Error).message}`,
          };
        }
      })
    );

    const merged = accountResults
      .flatMap((result) => result.files)
      .sort((a, b) => driveFileDateForSort(b) - driveFileDateForSort(a));

    const errors = accountResults
      .map((result) => result.error)
      .filter((error): error is string => Boolean(error));

    const returned = merged.slice(0, maxResults);

    return textResult(
      formatDriveFileListOutput({
        title: 'Google Drive Search Results',
        scopeText: args.account
          ? `account ${args.account}`
          : `all enabled accounts (${targetAccounts.length})`,
        queryText: type === 'any' ? args.query : `${args.query} (type: ${type})`,
        totalFound: merged.length,
        returned,
        errors,
      })
    );
  }


export async function handleListDriveFolder(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const folderId = valueToString(rawArgs.folder_id, '').trim();
    if (!folderId) throw new Error('folder_id is required.');
    const maxResults = clamp(valueToNumber(rawArgs.max_results, 50), 1, 200);
    const pageToken = valueToString(rawArgs.page_token, '').trim() || undefined;

    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);
    const result = await client.listDriveFiles({ folderId, maxResults, pageToken });

    return textResult(
      formatDriveFileListOutput({
        title: 'Google Drive Folder Contents',
        scopeText: `account ${acc.id} (${acc.email})`,
        queryText: `folder ${folderId}`,
        totalFound: result.files.length,
        returned: result.files,
        errors: [],
        notes: result.nextPageToken ? [`Next page token: ${result.nextPageToken}`] : [],
      })
    );
  }


export async function handleGetDriveFile(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const fileId = valueToString(rawArgs.file_id).trim();
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);
    const file = await client.getDriveFile(fileId);
    return textResult(['# Google Drive File', '', formatDriveFileDetail(file)].join('\n'));
  }


/**
 * Largest non-Google file read_drive_file will download. Drive has no
 * ceiling (a multi-GB video is an ordinary Drive file) and the download is
 * buffered whole in the one process that also serves Mail, on a 1 GB
 * droplet -- so refuse above this rather than OOM. 25 MB is Gmail's own
 * attachment ceiling, the size the extractor already lives with.
 */
export const MAX_READ_BYTES = 25 * 1024 * 1024;

const GOOGLE_DOC = 'application/vnd.google-apps.document';
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';
const GOOGLE_SHORTCUT = 'application/vnd.google-apps.shortcut';

/**
 * Routes on the file's MIME type (plan 002 Phase 3): a Google Doc goes
 * through the same tab-aware Markdown reader as read_doc, so the two tools
 * cannot disagree; a Google Sheet is redirected to the Sheets tools with its
 * tab list; a folder to list_drive_folder; everything else is downloaded
 * (Slides exported to .pptx) and handed to the mail attachments' extractor.
 */
export async function handleReadDriveFile(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const fileId = valueToString(rawArgs.file_id).trim();
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);

    const meta = await client.getDriveFile(fileId);
    const header = [
      '# Google Drive File Content',
      '',
      `**Account**: ${acc.id} (${acc.email})`,
      `**File**: ${meta.name}`,
      `**File ID**: ${meta.id}`,
      `**Type**: ${meta.mimeType}`,
    ];
    if (meta.webViewLink) header.push(`**Open**: ${meta.webViewLink}`);

    if (meta.mimeType === GOOGLE_DOC) {
      const doc = await client.getDocumentWithTabs(fileId);
      const rendered = renderDocument(doc, { indexThreshold: DEFAULT_INDEX_THRESHOLD });
      return textResult([...header, '', formatDocumentRead(doc, rendered, { account: acc, documentId: fileId })].join('\n'));
    }

    if (meta.mimeType === GOOGLE_SHEET) {
      const sheetMeta = await client.getSheetsMetadata(fileId);
      return textResult([
        ...header,
        '',
        'This is a Google Sheet. Read it with the Sheets tools, passing this same account and spreadsheet_id:',
        '- read_sheet_records for a tab as header-keyed rows, read_sheet_range for a grid, find_sheet_rows to locate rows.',
        '',
        formatSpreadsheetMetadata(sheetMeta),
      ].join('\n'));
    }

    if (meta.mimeType === GOOGLE_FOLDER) {
      return textResult([...header, '', 'This is a folder. Use list_drive_folder with this id to see what is inside it.'].join('\n'));
    }

    if (meta.mimeType === GOOGLE_SHORTCUT) {
      return textResult([...header, '', 'This is a Drive shortcut; it has no content of its own. Use get_drive_file for its target.'].join('\n'));
    }

    if (meta.size !== undefined && meta.size > MAX_READ_BYTES) {
      return textResult([
        ...header,
        `**Size**: ${meta.size.toLocaleString()} bytes`,
        '',
        `This file is ${(meta.size / (1024 * 1024)).toFixed(1)} MB, above the ${MAX_READ_BYTES / (1024 * 1024)} MB limit for reading here (the whole file would have to be downloaded into the server's memory). Open it in Drive instead; nothing was downloaded.`,
      ].join('\n'));
    }

    const { bytes, contentType, filename } = await client.getDriveFileContent(fileId);
    const fakeMetadata: AttachmentMetadata = { id: fileId, filename, contentType, sizeBytes: bytes.length, isInline: false };
    const content = await saveAndExtract(bytes, fakeMetadata);

    const lines = [
      ...header,
      `**Downloaded As**: ${filename} (${contentType}, ${bytes.length.toLocaleString()} bytes)`,
      `**Saved To**: ${content.savedPath}`,
      `**Extraction Method**: ${content.extractionMethod}`,
    ];
    if (content.textTruncated) lines.push('**Text Truncated**: true (extracted text exceeds 500 KB; the saved file is complete)');
    if (content.extractionError) lines.push(`**Extraction Error**: ${content.extractionError}`);
    if (content.text) {
      lines.push('', '**Content**:', '', content.text);
    } else {
      lines.push('', `*(no text form for ${contentType} -- the file was saved to disk in full; nothing more can be read from it here)*`);
    }
    return textResult(lines.join('\n'));
  }


export async function handleCreateDriveFolder(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const name = valueToString(rawArgs.name, '').trim();
    if (!name) throw new Error('name is required.');
    const parentId = valueToString(rawArgs.parent_id, '').trim() || undefined;

    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);

    // create_drive_folder needs `parents` in the response, which
    // GmailAccountClient.createDriveFolder's field mask does not request
    // (it's shared with search-result formatting, which has no use for
    // parents). Call rawApis() directly rather than editing the client
    // (plan 002 Phase 4 contract: no new methods on gmail-client.ts).
    const requestBody: drive_v3.Schema$File = { name, mimeType: 'application/vnd.google-apps.folder' };
    if (parentId) requestBody.parents = [parentId];
    let created: drive_v3.Schema$File;
    try {
      const response = await client.rawApis().drive.files.create({
        supportsAllDrives: true,
        requestBody,
        fields: 'id,name,parents,webViewLink',
      });
      created = response.data;
    } catch (error) {
      throw new Error(describeGoogleApiError(error, { service: 'Drive', accountId: acc.id, fallback: 'Create folder failed.' }));
    }

    return textResult([
      '✅ Folder created.',
      '',
      `**Account**: ${acc.id} (${acc.email})`,
      `**Folder ID**: ${created.id}`,
      `**Name**: ${created.name}`,
      `**Parent IDs**: ${created.parents?.length ? created.parents.join(', ') : '(Drive root)'}`,
      created.webViewLink ? `**Open**: ${created.webViewLink}` : '',
    ].filter(Boolean).join('\n'));
  }


export async function handleUpdateDriveFile(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const fileId = valueToString(rawArgs.file_id, '').trim();
    if (!fileId) throw new Error('file_id is required.');
    const name = valueToString(rawArgs.name, '').trim() || undefined;
    const moveToFolderId = valueToString(rawArgs.move_to_folder_id, '').trim() || undefined;
    if (!name && !moveToFolderId) {
      throw new Error('Provide name and/or move_to_folder_id -- update_drive_file needs at least one thing to change.');
    }

    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);

    let addParents: string | undefined;
    let removeParents: string | undefined;
    if (moveToFolderId) {
      const current = await client.getDriveFile(fileId);
      addParents = moveToFolderId;
      removeParents = current.parents?.length ? current.parents.join(',') : undefined;
    }

    await client.updateDriveFile(fileId, { name, addParents, removeParents });
    // updateDriveFile's field mask doesn't include parents (see
    // createDriveFolder's comment above) -- read the file back for the
    // report so it reflects what Google confirms, not what was requested.
    const after = await client.getDriveFile(fileId);

    return textResult(['✅ Drive file updated.', '', formatDriveFileDetail(after)].join('\n'));
  }


export async function handleTrashDriveFile(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const fileId = valueToString(rawArgs.file_id, '').trim();
    if (!fileId) throw new Error('file_id is required.');
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);

    await client.trashDriveFile(fileId);
    const after = await client.getDriveFile(fileId);

    return textResult([
      `✅ File trashed in account ${acc.id} -- recoverable from Drive's trash.`,
      '',
      `**Name**: ${after.name}`,
      `**File ID**: ${after.id}`,
      `**Trashed**: ${after.trashed ? 'yes' : 'no'}`,
    ].join('\n'));
  }


/** True when `candidate` names the outbox directory itself (trailing slash or not), by realpath. */
async function isOutboxDirItself(candidate: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([fs.realpath(candidate), fs.realpath(resolveOutboxDir())]);
    return a === b;
  } catch {
    return false;
  }
}

export async function handleUploadDriveFile(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const requestedPath = valueToString(rawArgs.path, '').trim();

    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);

    // No path, or the outbox directory itself: list the outbox and stop.
    // Plan 002 Phase 5's agent runs showed that without this an agent asked
    // "upload the file in my outbox" has no honest move -- it cannot see the
    // outbox and must not guess a name -- and that its first probe is the
    // directory path, which used to be refused as "outside the outbox".
    if (!requestedPath || (await isOutboxDirItself(requestedPath))) {
      const entries = await listOutbox();
      return textResult([
        `Nothing was uploaded. ${describeOutboxListing(entries)}`,
        entries.length > 0
          ? 'Call upload_drive_file again with path set to one of those filenames to upload it.'
          : 'Copy a file into the outbox first (see the path argument), then call again with its filename.',
      ].join('\n'));
    }

    // Refuse before any Google call -- the one legitimate source for this
    // tool is the outbox, not an arbitrary VPS path (unlike mail attachments,
    // which may already live anywhere on the VPS). A bare filename is
    // resolved inside the outbox by the same guard.
    const localPath = await assertInsideOutbox(requestedPath);

    const client = await ctx.getClientForAccount(acc);
    const file = await client.uploadDriveFile({
      localPath,
      name: valueToString(rawArgs.name, '').trim() || undefined,
      folderId: valueToString(rawArgs.folder_id, '').trim() || undefined,
      mimeType: valueToString(rawArgs.mime_type, '').trim() || undefined,
    });
    // Only clean up on a successful upload -- a failed upload leaves the
    // file in the outbox so the caller can retry without re-copying it.
    await cleanupIfInOutbox(localPath);

    return textResult([
      '✅ File uploaded to Google Drive; the outbox copy was deleted.',
      '',
      formatDriveFileDetail(file),
    ].join('\n'));
  }


export async function handleShareDriveFile(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const account = valueToString(rawArgs.account);
    const config = await ctx.loadConfig();
    const acc = resolveWriteAccount(config, account);
    const client = await ctx.getClientForAccount(acc);
    const result = await client.shareDriveFile(valueToString(rawArgs.file_id).trim(), {
      email: valueToString(rawArgs.email, '').trim() || undefined,
      role: valueToString(rawArgs.role),
      type: valueToString(rawArgs.type),
      sendNotification: rawArgs.send_notification !== undefined ? valueToBoolean(rawArgs.send_notification, true) : true,
      notificationMessage: valueToString(rawArgs.notification_message, '').trim() || undefined,
    });
    return textResult([
      `✅ Drive file shared in account ${acc.id}.`,
      `- File ID: ${valueToString(rawArgs.file_id)}`,
      `- Role: ${valueToString(rawArgs.role)}`,
      `- Type: ${valueToString(rawArgs.type)}`,
      rawArgs.email ? `- Email: ${valueToString(rawArgs.email)}` : '',
      `- Permission ID: ${result.permissionId}`,
    ].filter(Boolean).join('\n'));
  }

export const definitions: ToolDefinition[] = [
  searchDriveFilesTool,
  listDriveFolderTool,
  getDriveFileTool,
  readDriveFileTool,
  uploadDriveFileTool,
  createDriveFolderTool,
  updateDriveFileTool,
  trashDriveFileTool,
  shareDriveFileTool,
];

export const handlers: Record<string, ToolHandler> = {
  search_drive_files: handleSearchDriveFiles,
  list_drive_folder: handleListDriveFolder,
  get_drive_file: handleGetDriveFile,
  read_drive_file: handleReadDriveFile,
  upload_drive_file: handleUploadDriveFile,
  create_drive_folder: handleCreateDriveFolder,
  update_drive_file: handleUpdateDriveFile,
  trash_drive_file: handleTrashDriveFile,
  share_drive_file: handleShareDriveFile,
};

const driveModule: ToolModule = { definitions, handlers };
export default driveModule;
