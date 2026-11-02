/**
 * Server-level instructions for the `workspace` endpoint. Rewritten in plan
 * 002 Phase 3 when the endpoint got its first tools and extended in Phase 4
 * for the writes; to be tuned against real agent transcripts in Phase 5. Written from docs/specs/002-google-workspace-server.md,
 * "Google Workspace Endpoint -- Account Model" and "Tool Surface and Guidance".
 *
 * Keep under 2KB (test/instructions.test.mjs asserts < 2000 bytes; the plan
 * asks for < 1500; Phase 5's tuned text is ~1900): Claude Code truncates
 * server instructions at that size, silently. Lead with what changes tool
 * choice.
 */
export const WORKSPACE_INSTRUCTIONS = `Google Workspace (Drive, Sheets, Docs, Calendar) for one owner's two accounts:

- \`personal\` (ownerpersonal@gmail.com)
- \`tamu\` (owner_school@tamu.edu) -- Texas A&M

FINDING: start with search_drive_files. It searches both accounts unless \`account\` is given, filters by \`type\`, and every result names its account.

IDS NEED AN ACCOUNT: every tool that takes an id REQUIRES \`account\` -- one that can see the file (the one search listed it under). A shared file works under either; "not found" under one means try the other.

SHEETS: get_spreadsheet lists tabs; read_sheet_records reads a tab as header-keyed rows with row numbers; find_sheet_rows locates rows by a column's value; get_sheet_dropdown shows what a cell allows. update_sheet_row changes one row (row number + {header: value}); append_sheet_rows adds rows after the last data row; write_sheet_range overwrites exactly the range named.

DOCS: read_doc returns every tab as Markdown with its tab_id; a very long document returns a tab index instead. Every edit names a tab_id (a multi-tab doc refuses without one): append_doc_text adds a paragraph at the end, replace_doc_text swaps a phrase throughout the tab, insert_doc_text places text at a heading or a unique passage and refuses an ambiguous anchor. Never character positions.

DRIVE: create_drive_folder, update_drive_file (rename/move), trash_drive_file. upload_drive_file uploads only from the server's outbox; call it without path to see what is waiting there.

CALENDAR: list_events sweeps every calendar shown in the sidebar (not just primary) from now unless calendar_id/time_min say otherwise; times carry their zone. Writes take a calendar_id; attendees may only be the owner's own addresses (the send allowlist) -- anyone else is refused.

WRITES report what Google confirms, not what was asked. A lapsed Google authorization is named at the point of use; the other account keeps working. Mail and attachments: the Mail endpoint (/mcp).`;
