/**
 * Attachment-reading tools: get_attachment, get_all_attachments. Moved out
 * of src/index.ts during the plan 002 Phase 1 registry restructure. Not
 * listed on any endpoint today (same as before -- see src/tools/accounts.ts's
 * doc comment for why that is not new).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveWriteAccount } from '../accounts.js';
import { saveAndExtract, type AttachmentContent } from '../attachments.js';
import {
  textResult,
  formatAttachmentContent,
  valueToString,
  type GetAttachmentArgs,
  type GetAllAttachmentsArgs,
} from './shared.js';
import type { ToolContext, ToolDefinition, ToolHandler, ToolModule } from './types.js';

export const getAttachmentTool: ToolDefinition = {
          name: 'get_attachment',
          description:
            'Download and extract text from one Gmail attachment by its attachment_id (PDF, DOCX, XLSX, images via OCR).',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              email_id: { type: 'string', description: 'Gmail message id the attachment belongs to.' },
              attachment_id: { type: 'string', description: 'Attachment id, from the message\'s attachment list.' },
            },
            required: ['account', 'email_id', 'attachment_id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const getAllAttachmentsTool: ToolDefinition = {
          name: 'get_all_attachments',
          description:
            'Download and extract text from every attachment on one Gmail message (PDF, DOCX, XLSX, images via OCR).',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              email_id: { type: 'string', description: 'Gmail message id to fetch attachments from.' },
            },
            required: ['account', 'email_id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export async function handleGetAttachment(
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
): Promise<CallToolResult> {
    const args: GetAttachmentArgs = {
      account: valueToString(rawArgs.account),
      email_id: valueToString(rawArgs.email_id),
      attachment_id: valueToString(rawArgs.attachment_id),
    };

    if (!args.account || !args.email_id || !args.attachment_id) {
      throw new Error('account, email_id, and attachment_id are required.');
    }

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);

    const { bytes, metadata } = await client.getAttachment(
      args.email_id,
      args.attachment_id,
    );
    const content = await saveAndExtract(bytes, metadata);

    return textResult(
      [
        '# Gmail Attachment',
        '',
        `**Account**: ${account.id} (${account.email})`,
        `**Message ID**: ${args.email_id}`,
        `**Attachment ID**: ${args.attachment_id}`,
        '',
        formatAttachmentContent(content),
      ].join('\n'),
    );
  }


export async function handleGetAllAttachments(
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
): Promise<CallToolResult> {
    const args: GetAllAttachmentsArgs = {
      account: valueToString(rawArgs.account),
      email_id: valueToString(rawArgs.email_id),
    };

    if (!args.account || !args.email_id) {
      throw new Error('account and email_id are required.');
    }

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);

    const fetchResults = await client.fetchAllAttachments(args.email_id);

    // Pair each fetch result with its metadata so the settled loop always has
    // the attachment ID, even when saveAndExtract itself rejects.
    const settled = await Promise.allSettled(
      fetchResults.map((result) => {
        if ('error' in result) return Promise.reject(new Error(result.error));
        return saveAndExtract(result.bytes, result.metadata);
      }),
    );

    const attachments: AttachmentContent[] = [];
    const errors: Array<{ attachment_id: string; error: string }> = [];

    settled.forEach((result, index) => {
      const attachmentId = fetchResults[index]?.metadata.id ?? '(unknown)';
      if (result.status === 'fulfilled') {
        attachments.push(result.value);
      } else {
        const msg =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push({ attachment_id: attachmentId, error: msg });
      }
    });

    const lines = [
      '# Gmail Attachments',
      '',
      `**Account**: ${account.id} (${account.email})`,
      `**Message ID**: ${args.email_id}`,
      `**Attachments**: ${attachments.length}`,
      `**Errors**: ${errors.length}`,
      '',
    ];

    attachments.forEach((att, index) => {
      lines.push(`## ${index + 1}. ${att.filename}`);
      lines.push(formatAttachmentContent(att));
      lines.push('');
    });

    if (errors.length > 0) {
      lines.push('## Errors');
      errors.forEach((err) => {
        lines.push(`- ${err.attachment_id}: ${err.error}`);
      });
    }

    return textResult(lines.join('\n'));
  }

  // ─── Drive handlers ────────────────────────────────────────────────────────

export const definitions: ToolDefinition[] = [
  getAttachmentTool,
  getAllAttachmentsTool,
];

export const handlers: Record<string, ToolHandler> = {
  get_attachment: handleGetAttachment,
  get_all_attachments: handleGetAllAttachments,
};

const attachmentsModule: ToolModule = { definitions, handlers };
export default attachmentsModule;
