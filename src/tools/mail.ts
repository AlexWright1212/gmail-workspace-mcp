/**
 * Gmail message/label/thread/draft/send/block tools, plus get_signature.
 * Moved out of src/index.ts during the plan 002 Phase 1 registry restructure
 * -- handler bodies are unchanged except for the mechanical `this.` -> `ctx.`
 * substitutions described in the plan. This is the module the `mail`
 * endpoint (endpoints.json) draws its 23 exposed tools from; get_signature
 * is defined here but, like today, not listed on any endpoint yet.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AccountConfig } from '../config.js';
import { resolveReadAccounts, resolveWriteAccount } from '../accounts.js';
import { GmailAccountClient, type MessageListPage, type ParsedEmail } from '../gmail-client.js';
import { htmlToPlainText } from '../compose.js';
import {
  DEFAULT_LIST_BODY_CHARS,
  decodePageToken,
  encodePageToken,
  formatEmailItem,
  formatEmailListOutput,
  formatModifyResult,
  planPage,
  type AccountPageState,
} from '../gmail-format.js';
import {
  textResult,
  formatAccountFrom,
  clamp,
  valueToString,
  valueToBoolean,
  valueToNumber,
  valueToStringArray,
  valueToAttachmentArray,
  isGenericSubject,
  type ReadEmailsArgs,
  type SearchEmailsArgs,
  type ThreadArgs,
  type LabelsArgs,
  type MessageIdsArgs,
  type AddLabelsArgs,
  type DeleteLabelArgs,
  type CreateLabelArgs,
  type DeleteDraftsArgs,
  type OutgoingEmailArgs,
  type BlockSenderArgs,
  type UnblockSenderArgs,
  type BlockAction,
} from './shared.js';
import type { ToolContext, ToolDefinition, ToolHandler, ToolModule } from './types.js';

/**
 * get_email_thread's description text (below) embeds this at definition-build
 * time -- read_emails/search_emails instead compute the equivalent value at
 * CALL time via ctx.isToolEnabled('get_all_attachments') (see their handlers),
 * which is the pattern every other endpoint-aware reference to attachment
 * reading uses. get_email_thread's description cannot do the same: tool
 * definitions are built once, at registry-import time, and shared across
 * every endpoint that lists this tool -- there is no ctx yet.
 *
 * Hardcoded to the "not enabled" branch because that is what it has always
 * evaluated to: get_all_attachments has never appeared in tools-enabled.json
 * (pre-Phase-1) and does not appear in endpoints.json's mail.tools today
 * (src/tools/attachments.ts is registered but mounted on no endpoint). This
 * keeps the mail endpoint's tools/list byte-identical to the pre-refactor
 * golden snapshot (test/golden/mail-tools-list.json), which is the Phase 1
 * non-negotiable. If get_all_attachments is ever added to an endpoint, this
 * line needs to change by hand -- there's no way around that with static
 * definitions shared across endpoints.
 */
const ATTACHMENT_READ_TOOL: string | undefined = undefined;

export const readEmailsTool: ToolDefinition = {
          name: 'read_emails',
          description:
            'List messages from one account, or from every enabled inbox merged together when `account` is omitted. Same Gmail query syntax as search_emails (see that tool for the operator reference); an empty query lists the most recent mail across all folders. Returns individual messages, not threads — use get_email_thread with a returned Thread ID to read a whole conversation. Each result carries its label ids and display names, so unread/starred/important state is visible without a second call. With include_body=true the plaintext body is included, truncated at 2000 characters; pass full_body=true for the complete text. Reports Gmail\'s own estimate of total matches plus a next_page_token when more results exist.',
          inputSchema: {
            type: 'object',
            properties: {
              account: {
                type: 'string',
                description: 'Optional account id ("personal", "tamu"). Omit to aggregate across all enabled accounts.',
              },
              query: {
                type: 'string',
                description: 'Optional Gmail query string. Empty lists the most recent mail.',
                default: '',
              },
              max_results: {
                type: 'number',
                description: 'Maximum emails to return per account (1-500).',
                default: 20,
              },
              include_body: {
                type: 'boolean',
                description: 'Include the plaintext body of each message.',
                default: false,
              },
              full_body: {
                type: 'boolean',
                description:
                  'With include_body=true, return the ENTIRE body instead of the first 2000 characters. Use when you need to reason over the full text.',
                default: false,
              },
              page_token: {
                type: 'string',
                description:
                  'Token from a previous call\'s "Next Page Token" to fetch the next page. Reuse the SAME query, max_results and `account` scope — the token records every queried account\'s position, including matches already fetched but not shown, and is rejected with an explanation if the scope changed.',
              },
            },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const searchEmailsTool: ToolDefinition = {
          name: 'search_emails',
          description:
            'Search Gmail using standard Gmail query syntax. Omitting `account` searches all enabled inboxes and merges results; pass `account` ("personal", "tamu") to scope to one. Returns individual messages, not threads — use get_email_thread with the returned Thread ID to see replies and full message bodies. Supported: `from:` `to:` `cc:` `subject:` `after:/before:YYYY/MM/DD` `newer_than:/older_than:` (e.g. `7d`, `1y`) `has:attachment` `filename:` `is:unread/starred/important` `in:inbox/sent/trash/anywhere` `category:` `larger:/smaller:`, `"exact phrase"`, `-` to negate, `OR` or `{a b}` to match either, `( )` to group. `label:` takes the label\'s DISPLAY NAME, not its id — quote names with spaces: `label:"BROH Internship"`. (A `Label_...` id would match nothing in Gmail, so this server rewrites recognized ids to the matching display name for you; prefer the name anyway.) Archived and sent mail are included by default; use `in:inbox` to restrict. Each result lists its label ids and names (UNREAD, STARRED, IMPORTANT, SENT, user labels). Bodies are not included — use read_emails(include_body=true) or get_email_thread. "Estimated Total Matches" is Gmail\'s own resultSizeEstimate for the whole query and is approximate; use page_token to page through everything.',
          inputSchema: {
            type: 'object',
            properties: {
              account: {
                type: 'string',
                description: 'Optional account id ("personal", "tamu"). Omit to aggregate across all enabled accounts.',
              },
              query: {
                type: 'string',
                description: 'Gmail search query, e.g. `from:alice@example.com newer_than:30d has:attachment`.',
              },
              max_results: {
                type: 'number',
                description: 'Maximum emails to return per account (1-500).',
                default: 25,
              },
              page_token: {
                type: 'string',
                description:
                  'Token from a previous call\'s "Next Page Token" to fetch the next page. Reuse the SAME query, max_results and `account` scope — the token records every queried account\'s position, including matches already fetched but not shown, and is rejected with an explanation if the scope changed.',
              },
            },
            required: ['query'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const getEmailThreadTool: ToolDefinition = {
          name: 'get_email_thread',
          description:
            `Read an entire conversation: every message in the thread, in chronological order, with the COMPLETE plaintext body of each (no truncation unless you set max_body_chars). This is the tool to use when you need to reason over what was actually said — search_emails and read_emails only give previews. Each message also lists its label ids/names and attachment metadata (filename, MIME type, size, attachment_id). ${
              ATTACHMENT_READ_TOOL
                ? `To read attachment content — PDF text, DOCX, XLSX, images via OCR — call ${ATTACHMENT_READ_TOOL} with the "Gmail ID" shown for that message.`
                : 'Attachment CONTENT is not readable through this server — no attachment-reading tool is enabled, so only the metadata above is available.'
            } Thread ids are per-account; use the Thread ID from a search against the SAME account.`,
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              thread_id: { type: 'string', description: 'Gmail thread id, from search_emails / read_emails.' },
              max_body_chars: {
                type: 'number',
                description:
                  'Truncate each message body to this many characters. 0 (default) returns the complete body. Only set this if a thread is too large to handle.',
                default: 0,
              },
            },
            required: ['account', 'thread_id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const getLabelsTool: ToolDefinition = {
          name: 'get_labels',
          description:
            'List every label in one account with its id, display name, and type (system vs user). Use the `id` for label_messages / unlabel_messages / label_thread; use the display `name` in a search query (`label:Cloudflare`, `label:"BROH Internship"`) — a label id in a `label:` query matches nothing. Message counts are NOT included by default because Gmail\'s label list does not report them; pass include_counts=true for real message/thread/unread counts (one extra API call per label).',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              include_counts: {
                type: 'boolean',
                description:
                  'Fetch real messagesTotal / messagesUnread / threadsTotal per label. Costs one API call per label; without it counts are reported as unknown rather than guessed.',
                default: false,
              },
            },
            required: ['account'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const markAsReadTool: ToolDefinition = {
          name: 'mark_as_read',
          description:
            'Remove the UNREAD label from specific messages in one account. Message-level: passing a thread id affects only the first message of that conversation. Each id is read back after the change, so the response reports how many messages were actually modified and names any id Gmail could not find.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              message_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Gmail message ids ("Gmail ID" in search results), not thread ids.',
              },
            },
            required: ['account', 'message_ids'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const labelMessagesTool: ToolDefinition = {
          name: 'label_messages',
          description:
            'Add one or more labels to specific MESSAGES in one account. Message-level only — a Gmail thread id usually equals the id of the thread\'s first message, so passing a thread id here labels just that one message; use label_thread to label the whole conversation. label_ids must be label IDs from get_labels for this same account (e.g. "Label_5459..." or a system label such as STARRED/IMPORTANT), not display names. Every id is read back afterwards, so the response reports the verified count and names any id that does not exist.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              message_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Gmail message ids to update.',
              },
              label_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Label IDs (from get_labels) to add. Not display names.',
              },
            },
            required: ['account', 'message_ids', 'label_ids'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const unlabelMessagesTool: ToolDefinition = {
          name: 'unlabel_messages',
          description:
            'Remove one or more labels from specific MESSAGES in one account. Message-level only — use unlabel_thread for a whole conversation. label_ids must be label IDs from get_labels for this same account, not display names. Every id is read back afterwards, so the response reports the verified count and names any id that does not exist.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              message_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Gmail message ids to update.',
              },
              label_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Label IDs (from get_labels) to remove. Not display names.',
              },
            },
            required: ['account', 'message_ids', 'label_ids'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const labelThreadTool: ToolDefinition = {
          name: 'label_thread',
          description:
            'Add labels to EVERY message in a conversation (users.threads.modify), which is what Gmail\'s UI does when you label a thread. Use this rather than label_messages whenever you have a Thread ID and mean the whole conversation. Reversible with unlabel_thread.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              thread_id: { type: 'string', description: 'Gmail thread id.' },
              label_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Label IDs (from get_labels) to add to every message in the thread.',
              },
            },
            required: ['account', 'thread_id', 'label_ids'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const unlabelThreadTool: ToolDefinition = {
          name: 'unlabel_thread',
          description:
            'Remove labels from EVERY message in a conversation (users.threads.modify). Pass label_ids=["INBOX"] to archive an entire thread, or ["UNREAD"] to mark the whole conversation read.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              thread_id: { type: 'string', description: 'Gmail thread id.' },
              label_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Label IDs to remove from every message in the thread.',
              },
            },
            required: ['account', 'thread_id', 'label_ids'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const archiveEmailsTool: ToolDefinition = {
          name: 'archive_emails',
          description:
            'Archive specific MESSAGES by removing their INBOX label — they stay in All Mail and remain searchable. Message-level only; use unlabel_thread with label_ids=["INBOX"] to archive a whole conversation. Reversible with label_messages(["INBOX"]). Every id is read back afterwards, so the response reports the verified count and names any id that does not exist.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              message_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Gmail message ids to archive.',
              },
            },
            required: ['account', 'message_ids'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const trashEmailsTool: ToolDefinition = {
          name: 'trash_emails',
          description:
            'Move specific MESSAGES to Gmail\'s Trash, where they are recoverable for 30 days before permanent deletion. Message-level only. Each message is trashed individually and confirmed, so the response reports the verified count and names any id that does not exist.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              message_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Gmail message ids to trash.',
              },
            },
            required: ['account', 'message_ids'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true },
};
export const createLabelTool: ToolDefinition = {
          name: 'create_label',
          description:
            'Create a new Gmail label in one account. Nested labels use "/" in the name ("Work/Invoices"); any missing parent labels are created too, so the hierarchy shows up correctly in Gmail. Returns the new label id — use that id with label_messages/label_thread, and the display name in `label:` search queries.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              name: { type: 'string', description: 'Label name. Use "/" for nesting, e.g. "Work/Invoices".' },
              label_list_visibility: {
                type: 'string',
                description: 'Gmail labelListVisibility value (default: labelShow).',
                default: 'labelShow',
              },
              message_list_visibility: {
                type: 'string',
                description: 'Gmail messageListVisibility value (default: show).',
                default: 'show',
              },
            },
            required: ['account', 'name'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const deleteLabelTool: ToolDefinition = {
          name: 'delete_label',
          description:
            'Permanently delete a user label from one account. The label is removed from every message that carried it; the messages themselves are untouched. Not reversible — the label id is gone and must be recreated. System labels (INBOX, SENT, STARRED, …) cannot be deleted.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              label_id: { type: 'string', description: 'Label id (from get_labels) to delete.' },
            },
            required: ['account', 'label_id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true },
};
export const blockSenderTool: ToolDefinition = {
          name: 'block_sender',
          description:
            'Block a sender in ONE account by creating a persistent Gmail filter (the same mechanism as Gmail\'s native "Block" button): future mail matching `from:<sender>` is auto-trashed, marked spam, or archived. This is a settings change that keeps applying until it is removed, and future mail is silently dropped — say what you are about to block and why before calling it. By default NO existing mail is touched; set also_trash_existing=true only when the user asks for a cleanup as well. Reverse with unblock_sender.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              sender: {
                type: 'string',
                description:
                  'Email address (e.g. "spam@foo.com"), domain ("@foo.com"), or Gmail search fragment ("from:x subject:promo").',
              },
              action: {
                type: 'string',
                enum: ['trash', 'archive', 'spam'],
                description:
                  'What to do with matching mail. "trash" (default) mirrors Gmail\'s Block button.',
                default: 'trash',
              },
              also_trash_existing: {
                type: 'boolean',
                description:
                  'If true, ALSO retroactively trashes up to 100 existing messages from this sender. Defaults to false — blocking should not bulk-trash mail as a side effect. Trash is recoverable for 30 days.',
                default: false,
              },
            },
            required: ['account', 'sender'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true },
};
export const listBlockedSendersTool: ToolDefinition = {
          name: 'list_blocked_senders',
          description:
            'List all Gmail filters for an account. Use to find filter_id for unblock_sender, or to audit what is being auto-trashed/archived/spammed.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
            },
            required: ['account'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const unblockSenderTool: ToolDefinition = {
          name: 'unblock_sender',
          description:
            'Remove a Gmail filter. Specify either filter_id (exact match) or sender (matches filters whose "from" criteria equals this value).',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              filter_id: {
                type: 'string',
                description: 'Filter id from list_blocked_senders. Prefer this when known.',
              },
              sender: {
                type: 'string',
                description:
                  'Sender string to match against filters\' from criteria. Used when filter_id is not provided.',
              },
            },
            required: ['account'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const muteThreadTool: ToolDefinition = {
          name: 'mute_thread',
          description:
            'Attempts Gmail\'s native conversation mute (the reserved MUTE label via users.threads.modify), then archives the thread. Gmail\'s API does not officially expose muting, so the native attempt may be rejected — in that case the response says explicitly that the thread was ARCHIVED, not muted, and that new replies will return to the inbox. It never reports "muted" for something that is not a mute. Optionally (also_filter_subject=true) installs a subject-matching filter; read the response\'s collateral-scope warning first, because such a filter auto-archives that subject from ANY sender indefinitely.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              thread_id: {
                type: 'string',
                description: 'Thread id (from search_emails / read_emails / get_email_thread).',
              },
              also_filter_subject: {
                type: 'boolean',
                description:
                  'Also create a persistent Gmail filter that auto-archives any future message with this thread\'s subject — from ANY sender, indefinitely. Far broader than a mute. Default false.',
                default: false,
              },
            },
            required: ['account', 'thread_id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const createDraftTool: ToolDefinition = {
          name: 'create_draft',
          description:
            'Write an email and save it as a draft without sending it — the normal composition path for mail intended for anyone. Also how to compose a REPLY: pass thread_id, plus in_reply_to and references from get_email_thread, so it threads correctly instead of starting a new conversation. Returns a draft_id usable with send_draft or delete_drafts.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              to: { type: 'string', description: 'Recipient email address(es).' },
              subject: { type: 'string', description: 'Email subject.' },
              body: {
                type: 'string',
                description:
                  'Email body as plain text. Blank lines separate paragraphs; a single newline is a line break; lines starting with "-" or "1." become bullet/numbered lists. Do NOT pass HTML — matching text/plain and text/html parts are generated from this one string, and "<", ">" and "&" are escaped so they render literally.',
              },
              cc: { type: 'string', description: 'Optional CC list.' },
              bcc: { type: 'string', description: 'Optional BCC list.' },
              attachments: {
                type: 'array',
                description: 'Optional local file attachments.',
                items: {
                  type: 'object',
                  properties: {
                    path: {
                      type: 'string',
                      description:
                        'Path readable by THIS SERVER (the VPS), not by you or the calling client. If the file lives on the machine you\'re running on, first copy it to /root/.gmail-multi-mcp/outbox/ on the VPS (e.g. `scp <local path> root@100.64.0.10:/root/.gmail-multi-mcp/outbox/<filename>` over the same SSH access used for deploys), then pass the resulting VPS path here. Files read from that outbox directory are deleted automatically once attached; paths anywhere else on the VPS are left alone.',
                    },
                    filename: {
                      type: 'string',
                      description: 'Optional override filename shown in Gmail.',
                    },
                    content_type: {
                      type: 'string',
                      description: 'Optional MIME type override (for example application/pdf).',
                    },
                  },
                  required: ['path'],
                  additionalProperties: false,
                },
              },
              thread_id: {
                type: 'string',
                description: 'Optional Gmail thread ID. When set, the draft is created as a reply in that thread.',
              },
              in_reply_to: {
                type: 'string',
                description: 'Optional RFC 2822 Message-ID of the email being replied to. Sets the In-Reply-To header for proper threading.',
              },
              references: {
                type: 'string',
                description: 'Optional RFC 2822 References header value for threading.',
              },
              // include_signature is deliberately NOT exposed. Gmail signature
              // reuse is disabled by owner decision (2026-08-17): the Gmail API
              // only reports a signature that is set as the account's DEFAULT,
              // and setting a default would make Gmail auto-insert it into
              // every compose. Drafts are reviewed by hand anyway, so a plain
              // "Best, Alex" sign-off in the body is sufficient. The underlying
              // code path is intact and dormant -- see docs/adr/005-disable-gmail-signature-reuse.md.
            },
            required: ['account', 'to', 'subject', 'body'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
};
export const sendMessageTool: ToolDefinition = {
          name: 'send_message',
          description:
            'Compose and SEND an email in one step. Same input contract as create_draft. ' +
            'SERVER-ENFORCED LIMIT: this server only delivers to addresses on a fixed allowlist ' +
            'held outside the repo, and it checks the final message bytes immediately before ' +
            'handing them to Gmail. A recipient that is not on that list is refused and no send ' +
            'request is made — the refusal comes from the server, not from the assistant\'s ' +
            'judgment, and no phrasing of the request, tool argument, or additional context can ' +
            'lift it. There is also no tool for editing the allowlist. To reach anyone else, use ' +
            'create_draft and let the owner send it from Gmail.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              to: {
                type: 'string',
                description:
                  'Recipient email address(es). Must be on the server\'s send allowlist or the send is refused.',
              },
              subject: { type: 'string', description: 'Email subject.' },
              body: {
                type: 'string',
                description:
                  'Email body as plain text. Blank lines separate paragraphs; a single newline is a line break; lines starting with "-" or "1." become bullet/numbered lists. Do NOT pass HTML — matching text/plain and text/html parts are generated from this one string, and "<", ">" and "&" are escaped so they render literally.',
              },
              cc: {
                type: 'string',
                description: 'Optional CC list. Also checked against the send allowlist.',
              },
              bcc: {
                type: 'string',
                description: 'Optional BCC list. Also checked against the send allowlist.',
              },
              attachments: {
                type: 'array',
                description: 'Optional local file attachments.',
                items: {
                  type: 'object',
                  properties: {
                    path: {
                      type: 'string',
                      description:
                        'Path readable by THIS SERVER (the VPS), not by you or the calling client. If the file lives on the machine you\'re running on, first copy it to /root/.gmail-multi-mcp/outbox/ on the VPS (e.g. `scp <local path> root@100.64.0.10:/root/.gmail-multi-mcp/outbox/<filename>` over the same SSH access used for deploys), then pass the resulting VPS path here. Files read from that outbox directory are deleted automatically once attached; paths anywhere else on the VPS are left alone.',
                    },
                    filename: {
                      type: 'string',
                      description: 'Optional override filename shown in Gmail.',
                    },
                    content_type: {
                      type: 'string',
                      description: 'Optional MIME type override (for example application/pdf).',
                    },
                  },
                  required: ['path'],
                  additionalProperties: false,
                },
              },
              thread_id: {
                type: 'string',
                description: 'Optional Gmail thread ID. When set, the message is sent into that thread.',
              },
              in_reply_to: {
                type: 'string',
                description: 'Optional RFC 2822 Message-ID of the email being replied to. Sets the In-Reply-To header for proper threading.',
              },
              references: {
                type: 'string',
                description: 'Optional RFC 2822 References header value for threading.',
              },
              // include_signature is deliberately NOT exposed -- see the note on
              // create_draft above. Signature reuse is disabled by owner decision.
            },
            required: ['account', 'to', 'subject', 'body'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true },
};
export const sendDraftTool: ToolDefinition = {
          name: 'send_draft',
          description:
            'Send an existing draft by its draft_id (from list_drafts / search_drafts). ' +
            'SERVER-ENFORCED LIMIT: before sending, the server re-fetches the draft\'s actual ' +
            'raw bytes and checks those recipients against a fixed allowlist held outside the ' +
            'repo — not whatever the draft was created with. A draft addressed to anyone not on ' +
            'the list is refused and no send request is made. The restriction is enforced by the ' +
            'server and cannot be lifted from a conversation.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              draft_id: {
                type: 'string',
                description: 'Draft id, as returned by create_draft, list_drafts or search_drafts.',
              },
            },
            required: ['account', 'draft_id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true },
};
export const getSignatureTool: ToolDefinition = {
          name: 'get_signature',
          description:
            'Read the email signature currently configured in one account\'s own Gmail settings (users.settings.sendAs). Gmail stores signatures as HTML, so the HTML is returned along with a plain-text rendering. An account with no signature configured is a normal, valid answer — it reports "no signature configured", not an error. This server stores no signature of its own.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
            },
            required: ['account'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const deleteDraftsTool: ToolDefinition = {
          name: 'delete_drafts',
          description: 'Permanently delete one or more drafts in one account (account required). Draft IDs are returned by create_draft or list_drafts.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              draft_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Draft IDs to delete (as returned by create_draft or list_drafts).',
              },
            },
            required: ['account', 'draft_ids'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true },
};
export const listDraftsTool: ToolDefinition = {
          name: 'list_drafts',
          description: 'List drafts in an account sorted oldest-first by internalDate. Returns draft_id (for delete_drafts), message_id, thread_id, subject, to, and internalDate.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              max_results: { type: 'number', description: 'Maximum number of drafts to return (default 20, max 500).', default: 20 },
            },
            required: ['account'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export const searchDraftsTool: ToolDefinition = {
          name: 'search_drafts',
          description: 'Search drafts by Gmail query string. Returns draft_id (for delete_drafts), message_id, thread_id, subject, to, and snippet. Use instead of search_emails when you need to delete or send a found draft.',
          inputSchema: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account id ("personal", "tamu").' },
              query: { type: 'string', description: 'Gmail search query (e.g. "to:bob@example.com" or "subject:follow up").' },
              max_results: { type: 'number', description: 'Maximum number of results (default 20).', default: 20 },
            },
            required: ['account', 'query'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false },
};
export async function handleReadEmails(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const attachmentReadTool = ctx.isToolEnabled('get_all_attachments') ? 'get_all_attachments' : undefined;
    const args: ReadEmailsArgs = {
      account: valueToString(rawArgs.account, '').trim() || undefined,
      query: valueToString(rawArgs.query, ''),
      max_results: valueToNumber(rawArgs.max_results, 20),
      include_body: valueToBoolean(rawArgs.include_body, false),
    };

    const config = await ctx.loadConfig();
    const targetAccounts = resolveReadAccounts(config, args.account);
    const query = args.query?.trim() ?? '';
    const includeBody = args.include_body ?? false;
    const fullBody = valueToBoolean(rawArgs.full_body, false);
    const maxResults = clamp(args.max_results ?? 20, 1, 500);

    const page = await fetchMergedPage(ctx, {
      accounts: targetAccounts,
      maxResults,
      rawPageToken: valueToString(rawArgs.page_token, '').trim() || undefined,
      fetch: (client, state) => client.readEmails(query, maxResults, includeBody, state),
    });

    return textResult(
      formatEmailListOutput({
        title: 'Gmail Emails',
        scopeText: args.account
          ? `account ${args.account}`
          : `all enabled accounts (${targetAccounts.length})`,
        queryText: query,
        estimates: page.estimates,
        returned: page.returned,
        itemOptions: {
          includeBody,
          maxBodyChars: fullBody ? 0 : DEFAULT_LIST_BODY_CHARS,
          showAttachmentIds: false,
          fullBodyParamHint: 'full_body=true',
          attachmentReadTool: attachmentReadTool,
        },
        nextPageToken: page.nextPageToken,
        errors: page.errors,
        warnings: page.warnings,
      })
    );
  }

  /**
   * Runs one paged query across every target account and merges the results.
   *
   * The whole point is that the merge cannot lose anything. Each account is
   * asked for at most `maxResults`; the top `maxResults` overall are returned;
   * every fetched-but-not-returned id is written into the next page token as
   * carry-over. An account's Gmail cursor therefore never advances past a
   * message the caller has not been shown.
   */


export async function fetchMergedPage(
  ctx: ToolContext,
  input: {
    accounts: AccountConfig[];
    maxResults: number;
    rawPageToken?: string;
    fetch: (client: GmailAccountClient, state?: AccountPageState) => Promise<MessageListPage>;
  }): Promise<{
    returned: ParsedEmail[];
    nextPageToken?: string;
    errors: string[];
    warnings: string[];
    estimates: Array<{ accountId: string; estimate?: number }>;
  }> {
    const accountIds = input.accounts.map((account) => account.id);
    // Any problem with the token throws here, by design. Silently starting over
    // hands back page 1 again and pages forever without ever saying why.
    const priorStates = decodePageToken(input.rawPageToken, accountIds);

    const perAccount = await Promise.all(
      input.accounts.map(async (account) => {
        const priorState = priorStates[account.id];
        try {
          const client = await ctx.getClientForAccount(account);
          const page = await input.fetch(client, priorState);
          return {
            accountId: account.id,
            candidates: page.messages,
            cursor: page.nextPageToken,
            estimate: page.resultSizeEstimate,
            warnings: page.warnings ?? [],
            error: null as string | null,
          };
        } catch (error) {
          return {
            accountId: account.id,
            candidates: [] as ParsedEmail[],
            cursor: undefined as string | undefined,
            estimate: undefined as number | undefined,
            warnings: [] as string[],
            error: `${account.id}: ${(error as Error).message}`,
            // Hold this account's position exactly where it was so a retry
            // resumes instead of restarting or being taken for "finished".
            failedWithState: priorState ?? { restart: true },
          };
        }
      })
    );

    const { returned, nextStates } = planPage(perAccount, input.maxResults);

    return {
      returned,
      nextPageToken: encodePageToken(nextStates),
      errors: perAccount.map((entry) => entry.error).filter((e): e is string => Boolean(e)),
      warnings: perAccount.flatMap((entry) => entry.warnings),
      estimates: perAccount.map((entry) => ({
        accountId: entry.accountId,
        estimate: entry.estimate,
      })),
    };
  }


export async function handleSearchEmails(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const attachmentReadTool = ctx.isToolEnabled('get_all_attachments') ? 'get_all_attachments' : undefined;
    const args: SearchEmailsArgs = {
      account: valueToString(rawArgs.account, '').trim() || undefined,
      query: valueToString(rawArgs.query, ''),
      max_results: valueToNumber(rawArgs.max_results, 25),
    };

    if (!args.query || args.query.trim() === '') {
      throw new Error('query is required.');
    }

    const config = await ctx.loadConfig();
    const targetAccounts = resolveReadAccounts(config, args.account);
    const maxResults = clamp(args.max_results ?? 25, 1, 500);

    const page = await fetchMergedPage(ctx, {
      accounts: targetAccounts,
      maxResults,
      rawPageToken: valueToString(rawArgs.page_token, '').trim() || undefined,
      fetch: (client, state) => client.searchEmails(args.query, maxResults, state),
    });

    return textResult(
      formatEmailListOutput({
        title: 'Gmail Search Results',
        scopeText: args.account
          ? `account ${args.account}`
          : `all enabled accounts (${targetAccounts.length})`,
        queryText: args.query,
        estimates: page.estimates,
        returned: page.returned,
        itemOptions: {
          includeBody: false,
          showAttachmentIds: false,
          attachmentReadTool: attachmentReadTool,
        },
        nextPageToken: page.nextPageToken,
        errors: page.errors,
        warnings: page.warnings,
      })
    );
  }


export async function handleGetThread(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const attachmentReadTool = ctx.isToolEnabled('get_all_attachments') ? 'get_all_attachments' : undefined;
    const args: ThreadArgs = {
      account: valueToString(rawArgs.account),
      thread_id: valueToString(rawArgs.thread_id),
    };

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);
    const thread = await client.getThread(args.thread_id);

    // Full text by default: this is the read path, and a thread tool that
    // silently drops the second half of every message defeats its own purpose.
    const maxBodyChars = clamp(valueToNumber(rawArgs.max_body_chars, 0), 0, 5_000_000);

    const lines = [
      '# Gmail Thread',
      '',
      `**Account**: ${account.id} (${account.email})`,
      `**Thread ID**: ${thread.threadId}`,
      `**Messages**: ${thread.messages.length}`,
      `**Body**: ${maxBodyChars > 0 ? `truncated at ${maxBodyChars} characters per message` : 'complete (untruncated)'}`,
      '',
    ];

    thread.messages.forEach((message, index) => {
      lines.push(`## ${index + 1}. ${message.subject}`);
      lines.push(
        formatEmailItem(message, {
          includeBody: true,
          maxBodyChars,
          showAttachmentIds: true,
          fullBodyParamHint: 'max_body_chars=0',
          attachmentReadTool: attachmentReadTool,
        })
      );
      lines.push('');
    });

    return textResult(lines.join('\n'));
  }


export async function handleGetLabels(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: LabelsArgs = {
      account: valueToString(rawArgs.account),
    };
    const includeCounts = valueToBoolean(rawArgs.include_counts, false);

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);
    const labels = await client.getLabels(includeCounts);

    const lines = [
      '# Gmail Labels',
      '',
      `**Account**: ${account.id} (${account.email})`,
      `**Count**: ${labels.length}`,
      '',
      '`id` is what label_messages / unlabel_messages / label_thread take.',
      '`name` is what a Gmail *search* takes: `label:Cloudflare`, or `label:"BROH Internship"` when it contains spaces.',
    ];
    if (!includeCounts) {
      lines.push(
        '_Message counts omitted: Gmail does not return them from the label list, so any number here would be invented. Pass `include_counts=true` for real counts (one extra API call per label)._'
      );
    }
    lines.push('');

    const describeCount = (value: number | undefined): string =>
      typeof value === 'number' ? String(value) : 'unknown';

    // Gmail's label list includes star sub-labels (YELLOW_STAR, RED_STAR, …).
    // They are not ordinary labels and mean nothing in a `label:` query, so
    // flag them rather than listing them as if they were user labels.
    const isStarSubLabel = (id: string): boolean => /_(STAR|STARRED|GUILLEMET|BANG|CHECK)$/i.test(id);

    labels.forEach((label, index) => {
      const note = isStarSubLabel(label.id)
        ? ' | note=Gmail star sub-label; use STARRED for starring, and it is not valid in a `label:` search'
        : '';
      const base = `${index + 1}. ${label.name} | id=${label.id} | type=${label.type ?? 'unknown'}${note}`;
      if (!includeCounts) {
        lines.push(base);
        return;
      }
      lines.push(
        `${base} | messages=${describeCount(label.messagesTotal)} | unread=${describeCount(label.messagesUnread)} | threads=${describeCount(label.threadsTotal)} | threadsUnread=${describeCount(label.threadsUnread)}`
      );
    });

    return textResult(lines.join('\n'));
  }


export async function handleMarkAsRead(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: MessageIdsArgs = {
      account: valueToString(rawArgs.account),
      message_ids: valueToStringArray(rawArgs.message_ids),
    };

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);
    const result = await client.markAsRead(args.message_ids);

    return textResult(
      formatModifyResult({
        verb: 'Marked as read',
        accountId: account.id,
        result,
      })
    );
  }


export async function handleAddLabels(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: AddLabelsArgs = {
      account: valueToString(rawArgs.account),
      message_ids: valueToStringArray(rawArgs.message_ids),
      label_ids: valueToStringArray(rawArgs.label_ids),
    };

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);
    const result = await client.addLabels(args.message_ids, args.label_ids);

    return textResult(
      formatModifyResult({
        verb: 'Added label(s)',
        accountId: account.id,
        result,
        extra: [`Labels: ${args.label_ids.join(', ')}`],
        threadHint: 'Use label_thread to label every message in the conversation.',
      })
    );
  }


export async function handleRemoveLabels(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: AddLabelsArgs = {
      account: valueToString(rawArgs.account),
      message_ids: valueToStringArray(rawArgs.message_ids),
      label_ids: valueToStringArray(rawArgs.label_ids),
    };

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);
    const result = await client.removeLabels(args.message_ids, args.label_ids);

    return textResult(
      formatModifyResult({
        verb: 'Removed label(s)',
        accountId: account.id,
        result,
        extra: [`Labels: ${args.label_ids.join(', ')}`],
        threadHint: 'Use unlabel_thread to unlabel every message in the conversation.',
      })
    );
  }


export async function handleArchiveEmails(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: MessageIdsArgs = {
      account: valueToString(rawArgs.account),
      message_ids: valueToStringArray(rawArgs.message_ids),
    };

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);
    const result = await client.archiveEmails(args.message_ids);

    return textResult(
      formatModifyResult({
        verb: 'Archived (INBOX removed)',
        accountId: account.id,
        result,
        threadHint: 'Use unlabel_thread with label_ids=["INBOX"] to archive the whole conversation.',
      })
    );
  }


export async function handleTrashEmails(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: MessageIdsArgs = {
      account: valueToString(rawArgs.account),
      message_ids: valueToStringArray(rawArgs.message_ids),
    };

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);
    const result = await client.trashEmails(args.message_ids);

    return textResult(
      formatModifyResult({
        verb: 'Trashed',
        accountId: account.id,
        result,
      })
    );
  }


async function handleLabelThread(
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
  mode: 'add' | 'remove',
): Promise<CallToolResult> {
    const accountArg = valueToString(rawArgs.account);
    const threadId = valueToString(rawArgs.thread_id).trim();
    const labelIds = valueToStringArray(rawArgs.label_ids);

    if (!threadId) throw new Error('thread_id is required.');
    if (labelIds.length === 0) throw new Error('label_ids must include at least one value.');

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, accountArg);
    const client = await ctx.getClientForAccount(account);

    const result = await client.modifyThreadLabels(
      threadId,
      mode === 'add' ? { addLabelIds: labelIds } : { removeLabelIds: labelIds }
    );

    const verb = mode === 'add' ? 'Added' : 'Removed';
    const preposition = mode === 'add' ? 'to' : 'from';
    const allGood = result.unverified.length === 0 && result.modified.length === result.messageIds.length;

    const lines = [
      `${allGood ? '✅' : '⚠️'} ${verb} label(s) ${preposition} ${result.modified.length} of ${result.messageIds.length} message(s) in thread ${result.threadId} (account ${account.id}).`,
      `- Labels: ${labelIds.join(', ')}`,
      `- Scope: EVERY message in the conversation (thread-level, via users.threads.modify).`,
      `- Message ids in thread: ${result.messageIds.join(', ') || '(none)'}`,
    ];
    if (result.unverified.length > 0) {
      lines.push(
        `- ❓ Not confirmed in the expected state: ${result.unverified.join(', ')}`
      );
    }

    return textResult(lines.join('\n'));
  }


export async function handleCreateLabel(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: CreateLabelArgs = {
      account: valueToString(rawArgs.account),
      name: valueToString(rawArgs.name),
      label_list_visibility: valueToString(rawArgs.label_list_visibility, 'labelShow'),
      message_list_visibility: valueToString(rawArgs.message_list_visibility, 'show'),
    };

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);

    const { label, createdParents } = await client.createLabel(
      args.name,
      args.label_list_visibility,
      args.message_list_visibility
    );

    const lines = [
      `✅ Created label in account ${account.id}: ${label.name} (id=${label.id}, type=${label.type ?? 'unknown'})`,
    ];
    if (createdParents.length > 0) {
      lines.push(`- Also created missing parent label(s): ${createdParents.join(', ')}`);
    }
    lines.push(
      `- Use id=${label.id} with label_messages / label_thread; use \`label:${label.name.includes(' ') ? `"${label.name}"` : label.name}\` in a search query.`
    );

    return textResult(lines.join('\n'));
  }


export async function handleDeleteLabel(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: DeleteLabelArgs = {
      account: valueToString(rawArgs.account),
      label_id: valueToString(rawArgs.label_id),
    };

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);

    await client.deleteLabel(args.label_id);

    return textResult(`✅ Deleted label ${args.label_id} in account ${account.id}.`);
  }


export async function handleBlockSender(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const rawAction = valueToString(rawArgs.action, 'trash').trim().toLowerCase();
    const action: BlockAction =
      rawAction === 'archive' || rawAction === 'spam' ? rawAction : 'trash';

    const args: BlockSenderArgs = {
      account: valueToString(rawArgs.account),
      sender: valueToString(rawArgs.sender).trim(),
      action,
      // Defaults to false on purpose: "block" should mean "stop future mail",
      // not "retroactively trash up to 100 messages" as a silent side effect.
      also_trash_existing: valueToBoolean(rawArgs.also_trash_existing, false),
    };

    if (!args.sender) throw new Error('sender is required.');

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);

    const filter = await client.createBlockFilter(args.sender, action);

    let sweptCount = 0;
    let sweptRequested = 0;
    let sweepError: string | null = null;
    if (args.also_trash_existing && action !== 'archive') {
      try {
        const existing = await client.searchEmails(`from:${args.sender}`, 100);
        if (existing.messages.length > 0) {
          const trashed = await client.trashEmails(existing.messages.map((email) => email.id));
          sweptRequested = trashed.requested.length;
          sweptCount = trashed.modified.length;
        }
      } catch (error) {
        sweepError = (error as Error).message;
      }
    }

    const actionEffect =
      action === 'trash'
        ? 'future mail from this sender is auto-trashed and never reaches the inbox'
        : action === 'spam'
          ? 'future mail from this sender is marked as spam'
          : 'future mail from this sender skips the inbox (archived), but stays in All Mail';

    const lines = [
      `✅ Blocked \`${args.sender}\` in account ${account.id}.`,
      `- What this does: a Gmail filter now matches \`from: ${args.sender}\` — ${actionEffect}.`,
      `- Scope: only account ${account.id} (${account.email}). Other accounts are unaffected.`,
      `- Action: ${action}`,
      `- Filter id: ${filter.id ?? '(unknown)'}`,
      `- Reversible with: unblock_sender(account="${account.id}", filter_id="${filter.id ?? '(unknown)'}")`,
    ];
    if (args.also_trash_existing && action !== 'archive') {
      lines.push(
        `- Existing messages trashed: ${sweptCount} of ${sweptRequested} matched (capped at 100). Trash is recoverable for 30 days.`
      );
      if (sweepError) {
        lines.push(`- Sweep warning: ${sweepError}`);
      }
    } else if (!args.also_trash_existing) {
      lines.push(
        '- Existing messages: left untouched (also_trash_existing defaults to false). Pass also_trash_existing=true to retroactively trash up to 100 past messages.'
      );
    }
    if (action === 'archive' && args.also_trash_existing) {
      lines.push('- Note: `also_trash_existing` ignored for `archive` action (would be destructive).');
    }

    return textResult(lines.join('\n'));
  }


export async function handleListBlockedSenders(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args = { account: valueToString(rawArgs.account) };

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);

    const filters = await client.listFilters();

    if (filters.length === 0) {
      return textResult(`# Filters for account ${account.id}\n\nNo filters configured.`);
    }

    const lines: string[] = [`# Filters for account ${account.id}`, '', `**Total**: ${filters.length}`, ''];

    filters.forEach((filter, index) => {
      const c = filter.criteria ?? {};
      const a = filter.action ?? {};
      const criteriaParts: string[] = [];
      if (c.from) criteriaParts.push(`from: ${c.from}`);
      if (c.to) criteriaParts.push(`to: ${c.to}`);
      if (c.subject) criteriaParts.push(`subject: ${c.subject}`);
      if (c.query) criteriaParts.push(`query: ${c.query}`);
      if (c.hasAttachment) criteriaParts.push('hasAttachment: true');

      const actionParts: string[] = [];
      if (a.addLabelIds?.length) actionParts.push(`add: ${a.addLabelIds.join(', ')}`);
      if (a.removeLabelIds?.length) actionParts.push(`remove: ${a.removeLabelIds.join(', ')}`);
      if (a.forward) actionParts.push(`forward: ${a.forward}`);

      lines.push(`## ${index + 1}. Filter \`${filter.id ?? '(no id)'}\``);
      lines.push(`- Criteria: ${criteriaParts.length > 0 ? criteriaParts.join(' | ') : '(none)'}`);
      lines.push(`- Action: ${actionParts.length > 0 ? actionParts.join(' | ') : '(none)'}`);
      lines.push('');
    });

    return textResult(lines.join('\n'));
  }


export async function handleUnblockSender(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: UnblockSenderArgs = {
      account: valueToString(rawArgs.account),
      filter_id: valueToString(rawArgs.filter_id, '').trim() || undefined,
      sender: valueToString(rawArgs.sender, '').trim() || undefined,
    };

    if (!args.filter_id && !args.sender) {
      throw new Error('Provide either filter_id or sender.');
    }

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);

    if (args.filter_id) {
      await client.deleteFilter(args.filter_id);
      return textResult(`✅ Deleted filter ${args.filter_id} in account ${account.id}.`);
    }

    const senderNeedle = args.sender!;
    const filters = await client.listFilters();
    const matches = filters.filter((f) => (f.criteria?.from ?? '').trim() === senderNeedle);

    if (matches.length === 0) {
      return textResult(
        `No filters in account ${account.id} matched sender \`${senderNeedle}\`. Use list_blocked_senders to inspect.`
      );
    }

    const deletedIds: string[] = [];
    for (const match of matches) {
      if (!match.id) continue;
      await client.deleteFilter(match.id);
      deletedIds.push(match.id);
    }

    return textResult(
      `✅ Deleted ${deletedIds.length} filter(s) matching \`${senderNeedle}\` in account ${account.id}: ${deletedIds.join(', ')}.`
    );
  }

  /**
   * Tries a real Gmail mute first (the reserved `MUTE` label via
   * users.threads.modify). Gmail's API does not document that label and
   * users.messages.batchModify rejects it outright, so the fallback path must
   * never claim a mute it did not perform — it says "archived" and spells out
   * that future replies will come back to the inbox.
   *
   * The old behaviour — silently creating a SUBJECT-matching filter that
   * catches that subject from ANY sender, forever — is now opt-in only, and
   * its collateral scope is stated in the response.
   */


export async function handleMuteThread(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const threadId = valueToString(rawArgs.thread_id).trim();
    if (!threadId) throw new Error('thread_id is required.');

    // Back-compat: the old `scope` parameter meant "also install a subject filter".
    const legacyScope = valueToString(rawArgs.scope, '').trim().toLowerCase();
    const alsoFilterSubject =
      valueToBoolean(rawArgs.also_filter_subject, false) || legacyScope === 'subject';

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, valueToString(rawArgs.account));
    const client = await ctx.getClientForAccount(account);

    const native = await client.tryNativeMuteThread(threadId);

    // Archive regardless — muting in Gmail also removes the thread from the inbox.
    let archived = true;
    let archiveError: string | null = null;
    try {
      await client.modifyThreadLabels(threadId, { removeLabelIds: ['INBOX'] });
    } catch (error) {
      archived = false;
      archiveError = (error as Error).message;
    }

    const lines: string[] = [];

    if (native.muted) {
      lines.push(`✅ Muted thread ${threadId} in account ${account.id}.`);
      lines.push('- Gmail\'s native MUTE label was applied — future replies skip the inbox automatically.');
      lines.push('- Reversible: remove the MUTE label with unlabel_thread, or "Unmute" in Gmail.');
    } else {
      lines.push(`⚠️ NOT muted — Gmail's API does not expose a real mute for thread ${threadId} (account ${account.id}).`);
      lines.push(`- Native mute attempt failed: ${native.error ?? 'unknown error'}`);
      lines.push(
        archived
          ? '- What actually happened: the thread was ARCHIVED (INBOX label removed from every message).'
          : `- What actually happened: nothing — the archive also failed: ${archiveError}`
      );
      lines.push(
        '- Important: archiving is not muting. New replies to this thread WILL reappear in the inbox.'
      );
    }

    if (!archived && native.muted) {
      lines.push(`- Warning: MUTE applied but archiving failed: ${archiveError}`);
    }

    if (alsoFilterSubject) {
      const subject = (await client.getThreadSubject(threadId)).trim();
      if (isGenericSubject(subject)) {
        lines.push(
          `- Subject filter: SKIPPED. Subject "${subject}" is too generic and the filter would have swallowed unrelated mail.`
        );
      } else {
        const filter = await client.createFilter({ subject }, { removeLabelIds: ['INBOX'] });
        lines.push(`- Subject filter: CREATED (id ${filter.id ?? 'unknown'}).`);
        lines.push(
          `  ⚠️ Collateral scope: this is a persistent Gmail settings change that auto-archives EVERY future message whose subject matches "${subject}" — from ANY sender, in any thread, indefinitely. It is broader than a mute.`
        );
        lines.push(
          `  Remove it with unblock_sender(account="${account.id}", filter_id="${filter.id ?? 'unknown'}").`
        );
      }
    } else if (!native.muted) {
      lines.push(
        '- No filter was created. Pass also_filter_subject=true to auto-archive future same-subject mail (read the collateral-scope warning first).'
      );
    }

    return textResult(lines.join('\n'));
  }


export async function handleCreateDraft(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: OutgoingEmailArgs = {
      account: valueToString(rawArgs.account),
      to: valueToString(rawArgs.to),
      subject: valueToString(rawArgs.subject),
      body: valueToString(rawArgs.body),
      cc: valueToString(rawArgs.cc, '') || undefined,
      bcc: valueToString(rawArgs.bcc, '') || undefined,
      attachments: valueToAttachmentArray(rawArgs.attachments),
    };

    // Gmail signature reuse is DISABLED (owner decision, 2026-08-17 — see
    // docs/adr/005-disable-gmail-signature-reuse.md). Hard-wired false rather
    // than read from args: this server does not validate tool arguments against
    // the declared inputSchema, so dropping the parameter from the schema alone
    // would only hide it, not disable it. The signature code below stays intact
    // and dormant so the decision is cheap to reverse.
    const includeSignature = false;

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);

    // Resolved before the draft is created so the report can say whether a
    // signature was actually appended rather than whether one was requested.
    const signatureNote = includeSignature ? await describeSignatureUse(client) : '';

    const result = await client.createDraft({
      to: args.to,
      subject: args.subject,
      body: args.body,
      from: formatAccountFrom(account),
      cc: args.cc,
      bcc: args.bcc,
      attachments: args.attachments?.map((attachment) => ({
        path: attachment.path,
        filename: attachment.filename,
        contentType: attachment.content_type,
      })),
      threadId: valueToString(rawArgs.thread_id, '') || undefined,
      inReplyTo: valueToString(rawArgs.in_reply_to, '') || undefined,
      references: valueToString(rawArgs.references, '') || undefined,
      includeSignature,
    });

    return textResult(
      [
        '✅ Draft created.',
        `Account: ${account.id} (${account.email})`,
        `Draft ID: ${result.draftId || '(unknown)'}`,
        `Thread ID: ${result.threadId || '(unknown)'}`,
        `Attachments: ${args.attachments?.length ?? 0}`,
        ...(includeSignature ? [signatureNote] : []),
      ].join('\n')
    );
  }

  /**
   * Describe what include_signature actually did, so the caller never assumes a
   * signature was appended when the account has none configured.
   */


export async function describeSignatureUse(client: GmailAccountClient): Promise<string> {
    try {
      const signature = await client.getSignature();
      if (!signature.matchedAccountEmail) {
        return `Signature: none appended — Gmail has no sendAs entry for ${client.account.email} (found: ${signature.availableSendAs.join(', ') || 'none'}).`;
      }
      if (signature.signatureHtml === '') {
        return `Signature: none appended — no signature is configured in ${client.account.email}'s Gmail settings.`;
      }
      return `Signature: appended from ${signature.sendAsEmail}'s Gmail settings.`;
    } catch (error) {
      return `Signature: status unknown — reading Gmail settings failed (${(error as Error).message}).`;
    }
  }


export async function handleGetSignature(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, valueToString(rawArgs.account));
    const client = await ctx.getClientForAccount(account);

    const signature = await client.getSignature();

    if (!signature.matchedAccountEmail) {
      return textResult(
        [
          `# Signature — ${account.id} (${account.email})`,
          ``,
          `No \`sendAs\` entry in this account's Gmail settings matches ${account.email}.`,
          `Addresses Gmail does list: ${signature.availableSendAs.join(', ') || '(none)'}`,
          ``,
          `Nothing was substituted from another address or another account.`,
        ].join('\n')
      );
    }

    if (signature.signatureHtml === '') {
      return textResult(
        [
          `# Signature — ${account.id} (${account.email})`,
          ``,
          `No signature configured. This is a valid state, not an error: Gmail's settings for ${signature.sendAsEmail} have an empty signature, so \`include_signature\` appends nothing.`,
        ].join('\n')
      );
    }

    return textResult(
      [
        `# Signature — ${account.id} (${account.email})`,
        ``,
        `- Read from: ${signature.sendAsEmail}${signature.isDefault ? ' (default sendAs)' : ''}`,
        `- Stored by this server: nothing. Gmail is the only copy.`,
        ``,
        `## Plain text`,
        '```',
        htmlToPlainText(signature.signatureHtml),
        '```',
        ``,
        `## HTML (as Gmail stores it)`,
        '```html',
        signature.signatureHtml,
        '```',
      ].join('\n')
    );
  }


export async function handleDeleteDrafts(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: DeleteDraftsArgs = {
      account: valueToString(rawArgs.account),
      draft_ids: valueToStringArray(rawArgs.draft_ids),
    };

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);
    const deleted = await client.deleteDrafts(args.draft_ids);

    return textResult(`✅ Deleted ${deleted} draft(s) in account ${account.id}.`);
  }

  /**
   * `send_draft`. Nothing here inspects the draft: the client re-fetches its
   * raw bytes and gates on those, because what the draft says NOW is the only
   * thing that matters and this handler has no way to know it.
   */


export async function handleSendDraft(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const accountId = valueToString(rawArgs.account);
    const draftId = valueToString(rawArgs.draft_id).trim();
    if (!draftId) throw new Error('draft_id is required.');

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, accountId);
    const client = await ctx.getClientForAccount(account);
    const result = await client.sendDraft(draftId);

    return textResult(
      [
        '✅ Draft sent.',
        `Account: ${account.id} (${account.email})`,
        `Draft ID: ${draftId}`,
        `Message ID: ${result.messageId || '(unknown)'}`,
        `Thread ID: ${result.threadId || '(unknown)'}`,
      ].join('\n')
    );
  }


export async function handleListDrafts(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const accountId = valueToString(rawArgs.account);
    const maxResults = typeof rawArgs.max_results === 'number' ? rawArgs.max_results : 20;

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, accountId);
    const client = await ctx.getClientForAccount(account);
    const drafts = await client.listDrafts(maxResults);

    if (drafts.length === 0) {
      return textResult(`No drafts found in account ${account.id}.`);
    }

    const lines = drafts.map((d, i) =>
      `${i + 1}. draft_id=${d.draftId} to="${d.to}" subject="${d.subject}" thread_id=${d.threadId ?? '(none)'} internalDate=${d.internalDate}`
    );

    return textResult(
      [`✅ ${drafts.length} draft(s) in account ${account.id} (sorted oldest-first):`, ...lines].join('\n')
    );
  }


export async function handleSearchDrafts(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const accountId = valueToString(rawArgs.account);
    const query = valueToString(rawArgs.query);
    const maxResults = typeof rawArgs.max_results === 'number' ? rawArgs.max_results : 20;

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, accountId);
    const client = await ctx.getClientForAccount(account);
    const drafts = await client.searchDrafts(query, maxResults);

    if (drafts.length === 0) {
      return textResult(`No drafts matching "${query}" in account ${account.id}.`);
    }

    const lines = drafts.map((d, i) =>
      `${i + 1}. draft_id=${d.draftId} to="${d.to}" subject="${d.subject}" thread_id=${d.threadId ?? '(none)'} snippet="${d.snippet}"`
    );

    return textResult(
      [`✅ ${drafts.length} draft(s) matching "${query}" in account ${account.id}:`, ...lines].join('\n')
    );
  }

  /**
   * `send_message`. The allowlist is NOT consulted here — deliberately.
   *
   * A check in this handler would be a check on the caller's arguments, and the
   * bytes that leave are built later, from a parser that need not agree with
   * this one. The gate lives in GmailAccountClient.deliver, on the final MIME,
   * immediately before the API call. See src/allowlist.ts for the demonstrated
   * attack that makes the distinction matter.
   */


export async function handleSendEmail(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const args: OutgoingEmailArgs = {
      account: valueToString(rawArgs.account),
      to: valueToString(rawArgs.to),
      subject: valueToString(rawArgs.subject),
      body: valueToString(rawArgs.body),
      cc: valueToString(rawArgs.cc, '') || undefined,
      bcc: valueToString(rawArgs.bcc, '') || undefined,
      attachments: valueToAttachmentArray(rawArgs.attachments),
    };
    // Gmail signature reuse is DISABLED (owner decision, 2026-08-17 — see
    // docs/adr/005-disable-gmail-signature-reuse.md). Hard-wired false rather
    // than read from args: this server does not validate tool arguments against
    // the declared inputSchema, so dropping the parameter from the schema alone
    // would only hide it, not disable it. The signature code below stays intact
    // and dormant so the decision is cheap to reverse.
    const includeSignature = false;

    const config = await ctx.loadConfig();
    const account = resolveWriteAccount(config, args.account);
    const client = await ctx.getClientForAccount(account);

    const signatureNote = includeSignature ? await describeSignatureUse(client) : '';

    const result = await client.sendEmail({
      to: args.to,
      subject: args.subject,
      body: args.body,
      from: formatAccountFrom(account),
      cc: args.cc,
      bcc: args.bcc,
      attachments: args.attachments?.map((attachment) => ({
        path: attachment.path,
        filename: attachment.filename,
        contentType: attachment.content_type,
      })),
      threadId: valueToString(rawArgs.thread_id, '') || undefined,
      inReplyTo: valueToString(rawArgs.in_reply_to, '') || undefined,
      references: valueToString(rawArgs.references, '') || undefined,
      includeSignature,
    });

    return textResult(
      [
        '✅ Email sent.',
        `Account: ${account.id} (${account.email})`,
        `To: ${args.to}`,
        `Message ID: ${result.messageId || '(unknown)'}`,
        `Thread ID: ${result.threadId || '(unknown)'}`,
        `Attachments: ${args.attachments?.length ?? 0}`,
        ...(includeSignature ? [signatureNote] : []),
      ].join('\n')
    );
  }

const labelThread: ToolHandler = (rawArgs, ctx) => handleLabelThread(rawArgs, ctx, 'add');
const unlabelThread: ToolHandler = (rawArgs, ctx) => handleLabelThread(rawArgs, ctx, 'remove');

export const definitions: ToolDefinition[] = [
  readEmailsTool,
  searchEmailsTool,
  getEmailThreadTool,
  getLabelsTool,
  markAsReadTool,
  labelMessagesTool,
  unlabelMessagesTool,
  labelThreadTool,
  unlabelThreadTool,
  archiveEmailsTool,
  trashEmailsTool,
  createLabelTool,
  deleteLabelTool,
  blockSenderTool,
  listBlockedSendersTool,
  unblockSenderTool,
  muteThreadTool,
  createDraftTool,
  sendMessageTool,
  sendDraftTool,
  getSignatureTool,
  deleteDraftsTool,
  listDraftsTool,
  searchDraftsTool,
];

export const handlers: Record<string, ToolHandler> = {
  read_emails: handleReadEmails,
  search_emails: handleSearchEmails,
  get_email_thread: handleGetThread,
  get_labels: handleGetLabels,
  mark_as_read: handleMarkAsRead,
  label_messages: handleAddLabels,
  unlabel_messages: handleRemoveLabels,
  label_thread: labelThread,
  unlabel_thread: unlabelThread,
  archive_emails: handleArchiveEmails,
  trash_emails: handleTrashEmails,
  create_label: handleCreateLabel,
  delete_label: handleDeleteLabel,
  block_sender: handleBlockSender,
  list_blocked_senders: handleListBlockedSenders,
  unblock_sender: handleUnblockSender,
  mute_thread: handleMuteThread,
  create_draft: handleCreateDraft,
  send_message: handleSendEmail,
  send_draft: handleSendDraft,
  get_signature: handleGetSignature,
  delete_drafts: handleDeleteDrafts,
  list_drafts: handleListDrafts,
  search_drafts: handleSearchDrafts,
};

const mailModule: ToolModule = { definitions, handlers };
export default mailModule;
