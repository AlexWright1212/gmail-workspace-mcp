*This spec defines WHAT this tool does. The plan defines HOW.*

# Google Workspace MCP Server — Behavioral Spec

**Supersedes spec 001.** Everything 001 says about mail remains true and is restated here in condensed form; 001 is kept for the reasoning and history behind those sections. Where the two disagree, this spec wins.

## Objective & Scope

This tool is a personally-owned, self-hosted MCP server, reachable over the public internet at one hostname, that lets any modern MCP client authenticate as the owner and act on the owner's two Google accounts — `personal` (ownerpersonal@gmail.com) and `tamu` (owner_school@tamu.edu) — across Gmail, Drive, Docs, Sheets and Calendar.

It presents as **two MCP endpoints on that one hostname**, each connected and authorized separately by a client:

- **Mail** — the Gmail assistant that exists today: search and cross-thread reasoning, inbox organization, drafts that survive Gmail's send pipeline unchanged, and sending gated by a hard allowlist. Its address does not change; clients already connected keep working.
- **Google Workspace** — everything else: finding and reading files in Drive, reading and editing Docs across all their tabs, reading and editing Sheets, and reading and managing the owner's own Calendar events.

Two endpoints rather than one because a client connects to whichever set it needs. Some clients degrade or silently drop tools past a ceiling of roughly forty; splitting keeps each endpoint under it and lets the owner hand a client mail, files, or both. Both endpoints are one codebase, one process, one deployment, one login.

**Clients.** Claude Code and Codex are the primary clients and must pass every acceptance flow. Cursor must connect and complete a call on each endpoint. claude.ai and the Claude mobile apps are expected to work as they do for mail today. ChatGPT's regular chat still cannot reach either endpoint, for the plan-tier reason recorded in 001.

**In scope:**
- Everything 001 put in scope for mail, unchanged in behavior.
- Drive: find files by name or text, filtered by type; browse a folder; read metadata; read content — Google Docs as Markdown, PDFs and Office files as extracted text, using the same extraction the mail attachments already have; create folders; rename, move and trash files; upload a file staged on the server.
- Docs: read a document whole, every tab including nested tabs, as Markdown that preserves headings, lists, links and tables; append to a tab; find and replace within a tab; insert or replace text anchored to a heading or a unique passage; create a document.
- Sheets: find a spreadsheet by name; list its tabs; read a range as a grid or as header-keyed records; find the rows where a column holds a value and get their row numbers; write a range; append rows; update cells in a specific row; add, rename and delete tabs; insert and delete rows and columns; basic cell formatting; a simple chart; create a spreadsheet; read a cell's dropdown rule.
- Calendar: list calendars; list and search events in a time window; read an event; create, update and delete events on any calendar the owner owns.
- Every Workspace capability works on both accounts, chosen the same way mail is chosen today.
- A read-only grant for a client that must be able to look but never change anything, on either endpoint.

**Explicitly out of scope (this version):**
- Everything 001 excluded, on the same terms: sending to non-allowlisted addresses, non-Gmail providers, non-MCP integration paths, Gmail signature reuse, unsubscribing, paid third-party SaaS.
- Sharing a file or folder with anyone, and inviting anyone but the owner to a calendar event. The send allowlist already governs both, and in practice that means the owner's own addresses only. The owner shares and invites by hand.
- Responding to calendar invitations and finding free time.
- Rebuilding a document wholesale from Markdown. Reading produces Markdown; writing is small, targeted edits. Long-form document authoring is not a goal.
- Editing a dropdown rule. Reading one is in, so the agent writes valid values; changing the allowed options is not.
- Images, comments and suggestions in Docs; conditional formatting, pivot tables and formula authoring beyond writing a formula string into a cell.
- Slides, Chat, Tasks, Contacts, Forms, Meet.
- One tool that hides many operations behind an `operation` parameter. Tools are one per operation, named so a model that sees only the name can tell what it does.

**Future direction:** a third Google account should be addable without redesign, as 001 required. If Google's own hosted Workspace MCP endpoints leave preview and gain sending and multi-account support, the Workspace endpoint here is the part most likely to become redundant; the mail endpoint's allowlist boundary is not something Google offers.

## Feature Details

### Two Endpoints, One Login

**What it does:** a client is pointed at either the mail address or the Google Workspace address and goes through the same login for each: a real Google sign-in restricted to the owner's two addresses, then a consent screen naming the client, the endpoint being authorized and the access it is asking for. Each client holds its own token per endpoint, revocable independently.

**How it works (conceptually):** there is one authorization server, one Google login, one owner. What differs per endpoint is which tools exist, what the server tells the model about them, and which token is accepted. A token issued for the mail endpoint does not work on the Workspace endpoint and vice versa; a client that wants both connects twice.

**Scopes:** two, named `read` and `write`, the same on both endpoints. `read` permits anything that lists or fetches state and forbids every change — no draft created, no label applied, no document or spreadsheet or tab or folder created, no cell written, no event created. `write` permits everything the endpoint offers, still subject to the send allowlist. A client that asks for no particular scope is granted both, as today. The previous mail-specific scope names are retired outright: on the day of the change already-connected clients were carried across transparently (their existing tokens read under the new names), and on 2026-09-20 the stored tokens were rewritten to the new names once and the translation removed — the owner did nothing either time. A token or refresh token that still carries a retired name is refused so that the client re-authorizes; it is never translated.

**Edge cases:** a login from any Google account other than the owner's two fails, on both endpoints. Revoking a client on one endpoint does not affect its access to the other. A client whose token carries only `read` gets a plain refusal naming the scope it lacks when it attempts a change, not a generic error.

### Mail Endpoint (unchanged from 001)

Everything in 001's Feature Details holds: search and cross-thread reasoning over both inboxes and sent mail, informal account references resolved to `personal` or `tamu`, reads across both accounts when scope is ambiguous and explicit accounts for every write, inbox organization with `mute_thread` archiving and saying so, drafts that render the same after the owner's own Send, attachments from local files or the server's drop box, and sending only to the allowlist, checked against the final message bytes. The only changes are the scope names above and the endpoint now sharing its hostname with a second one.

The mail endpoint's guidance to the model may mention that files and calendar live on the Workspace endpoint, and the Workspace endpoint's guidance may mention that mail and attachments live on the mail endpoint, so an agent connected to both knows where to look.

### Google Workspace Endpoint — Account Model

**What it does:** the same two accounts, the same informal references, the same asymmetry as mail. Finding things defaults to both accounts, and every result names the account it came from. Acting on a specific file, document, spreadsheet or calendar requires naming the account, because an id belongs to one account's view of Drive.

**How it works (conceptually):** the agent searches, sees which account holds the file, and passes that account on every later call for that file. A file visible from both accounts, such as one shared between them, is listed under each account it is visible from; the agent may use either.

**Edge cases:** an account whose Google authorization has lapsed, or that has been refused access to a Workspace service by its administrator, is reported by name at the point of use while the other account keeps working — the mail precedent of an `INCOMPLETE` banner, never a silent empty result. An id the named account cannot see produces "not found in this account", which invites trying the other, rather than a generic failure.

### Drive

**What it does:** the way into everything else. "Find my internship spreadsheet" resolves to a file, its type, its account and its id, and from there the Sheets or Docs tools take over. The agent can also browse a folder, read what a file is, and read what a file contains.

**How it works (conceptually):** search by name or by text inside the file, optionally restricted to a type — spreadsheet, document, folder, PDF — ordered so the most recently modified match comes first. Reading content returns text an agent can reason over: a Google Doc arrives as Markdown, a PDF or Word or Excel file arrives as extracted text with OCR where the file is a scan, a Google Sheet is directed to the Sheets tools. Files with no useful text form are described, not dumped.

**Writes:** create a folder; rename or move a file; trash a file (Google keeps it recoverable). Upload places a file that has first been staged in the server's drop box, the same mechanism the mail endpoint uses for attachments — a client cannot push bytes from its own machine directly.

**Edge cases:** a search that matches several plausible files surfaces them with type and modification date rather than guessing. Trashing is reversible from Google's UI; permanent deletion is not offered. Shared drives are included when the account can see them.

### Sheets

**What it does:** the everyday collaboration the owner described: open a tracker, see its tabs, read a tab, find the row for a company, change its status, add a new opportunity with a link, add a tab for a career fair with headers, cross-reference a second spreadsheet of contacts. Not: building elaborate models. Google's own in-product assistant is the tool for work that lives entirely inside one sheet.

**How it works (conceptually):** the server exposes precise primitives and the model does the reasoning. A spreadsheet is addressed by id and account; a tab by its name; cells by A1 notation, with tab names containing spaces or punctuation quoted correctly by the tool rather than by the model. Reads come back two ways: as a raw grid for arbitrary ranges, or as records keyed by the header row so the agent works with column names rather than counting columns. Finding rows takes a column name and a value and returns each match with its row number, so a follow-up write can target exactly that row. Appending finds the end of the existing data itself; the agent does not need to know the row count. Values are interpreted the way typing them into the sheet would be, so dates, numbers and formulas behave as expected, with a raw mode available when text must be preserved byte for byte.

**Writes report what they changed.** A write names the range it touched and how many cells changed, read back from Google, not echoed from the request. A write to a range overwrites exactly that range and nothing else, and the tool description says so.

**Dropdowns:** the rule on a cell — its allowed values — is readable, so the agent sets a Status to a value the sheet accepts. Changing the rule is out of scope.

**Edge cases:** a tab name that does not exist is reported as such, with the tabs that do. Finding rows with no match says so rather than returning the header row. Formatting and charts are visual and can only be confirmed by eye; the spec requires they apply without error and land on the requested range, and leaves appearance to the owner.

### Docs

**What it does:** read a document the way a person sees it — every tab, in order, with structure — and make small, targeted edits: add a paragraph at the end of a tab, replace a phrase throughout a tab, insert or replace text at a named place. The owner's stated need is "read Google Docs and make small edits", not author them.

**How it works (conceptually):** a read returns Markdown with headings, lists, links, bold and italic and tables preserved, one section per tab with the tab's title and id, nested tabs included. Nothing is truncated; a very long document instead returns a tab index with sizes and the agent reads tabs one at a time. Every edit names the tab it applies to. Anchored edits name a heading or a unique passage; the server resolves that to a position at the moment of the edit, so the agent never handles character offsets and a stale position cannot land an edit in the wrong place.

**Boundary:** the model never sees or supplies character indices. The Docs API is index-based and indices shift after every edit; that complexity stays inside the server.

**Edge cases:** an anchor that matches nothing, or more than one place, is refused with the candidates listed, never applied to a guess. A request that names no tab on a multi-tab document is refused with the tab list, never silently applied to the first tab. A document with a single tab behaves exactly as it always did. Tables read as Markdown tables; content the Markdown form cannot carry, such as images and footnotes, is noted in place rather than dropped without trace.

### Calendar

**What it does:** see what is on the owner's calendars, find events, and create, change or remove the owner's own events, including on secondary calendars.

**How it works (conceptually):** calendars are listed by account; events are listed in a time window or searched by text across every calendar the owner shows in the Google Calendar sidebar — classes, school, social and shared calendars are separate calendars, so "what's on my calendar" must cover all of them, not the primary alone (owner decision, 2026-09-19); a hidden calendar such as the testing one is left out unless named; each event names its calendar; times are explicit about time zone. Creating and updating events take a calendar id, so a secondary calendar such as a testing calendar is addressed the same way as the primary one.

**Boundary:** attendees are subject to the send allowlist, exactly as sharing is, so an event can name the owner's own addresses and nobody else. Google would email any other attendee on the owner's behalf, and that is the send boundary in another costume.

**Edge cases:** an attendee outside the allowlist is refused before the event is created, with the same "the tool will not allow this" framing as mail. Deleting an event is offered; it is reversible in Google's trash for a limited time.

### Tool Surface and Guidance

**What it does:** the model finds the right tool from its name alone, because some clients show nothing else until a tool is chosen, and reads a short description that leads with what the tool does and what it must not be used for.

**Constraints:** one tool per operation; names of two to four words in the shape verb-noun; each endpoint stays under forty tools; each endpoint carries its own server-level guidance holding what the model needs to choose a tool — the account map, the read-both-write-explicit asymmetry, the boundaries — and that guidance stays under the size at which clients silently truncate it. Anything a client will not reliably forward is repeated where it matters instead of assumed.

## Verification Fixtures

Acceptance is checked against real Google state, never against a rendered preview, per the standing rule of this project. The owner has provided:

- Folder **Google Testing** in the personal account, shared with the tamu account, so every flow can run from either.
- Spreadsheet **Internship Copy** inside it: a multi-tab tracker with real content and a Status dropdown.
- Document **Musings Copy** inside it: a multi-tab document with real content.
- A secondary calendar named **Google Testing** in the personal account, for calendar writes.

These are templates. Automated checks work on fresh copies made inside the folder for each run and trash the copies afterwards; the templates are never modified. The owner's real internship tracker, real documents and primary calendar are never touched by any check. A contacts spreadsheet for the cross-reference flow is created by the check itself inside the folder.

## Acceptance Criteria

Each criterion is an outcome observable in Google or in the client afterwards. Where a criterion says "an agent", it means an agent driving the deployed endpoint through a real client with no help beyond the tool names, descriptions and server guidance.

**Connection and authorization**
- Claude Code and Codex each connect to the mail endpoint and to the Workspace endpoint as two separate connections, each through the Google login and a consent screen naming the client.
- A client granted only `read` on the Workspace endpoint can find and read files, documents, spreadsheets and events but is refused, by name of the missing scope, on every attempt to create, change, trash or delete. The same holds on the mail endpoint for drafts, labels, archive, trash, block and send.
- Revoking a client on one endpoint stops it immediately there and leaves its other connection working.
- Every existing mail client keeps working at its current address after the change, with no action from the owner and no re-login.

**Drive**
- Given "find my internship spreadsheet", an agent locates Internship Copy without an id, and the result states which account it came from. Searched from the tamu account, the shared copy is found there too.
- Reading Musings Copy through Drive returns Markdown containing text from every tab.
- Reading a PDF placed in the folder returns its text.
- On a copy: a folder is created, a file is renamed, moved into it, and trashed, and each change is visible in Drive afterwards.
- A file staged in the server's drop box is uploaded into the folder and appears there.

**Sheets**, on a fresh copy of Internship Copy
- An agent lists the tabs and reads one as records keyed by its header row.
- Asked to mark a named company's status, an agent finds that row by the company name and changes only the Status cell of that row, to a value the dropdown allows, and the sheet shows it.
- Asked to add an opportunity with a company, role and application link, an agent appends one row after the existing data with the link intact.
- An agent adds a "Career Fair" tab with a header row, inserts a row in the middle of an existing tab, and deletes a row, each visible in the sheet afterwards.
- Given a second spreadsheet of contacts in the folder, an agent finds a contact whose company matches a row in the tracker and records that connection in the tracker row.
- Formatting applied to a header row and a chart added from a range both complete without error; their appearance is confirmed by the owner's eye, and this is the only Sheets check that needs it.
- A write to a range reports the range and cell count Google confirms, not what was requested.

**Docs**, on a fresh copy of Musings Copy
- An agent reads the document and reports the correct number of tabs and their titles, and the Markdown contains a heading and a list from a tab that is not the first.
- An agent appends a paragraph to the end of a named tab that is not the first, and only that tab changes.
- An agent replaces a phrase throughout one tab, and the same phrase in another tab is untouched.
- An agent inserts a sentence directly under a named heading.
- An anchor that appears twice in a tab is refused with both locations listed and the document is unchanged.
- An edit that names no tab is refused with the tab list and the document is unchanged.

**Calendar**
- An agent lists calendars for the personal account and the list includes Google Testing.
- An agent lists the coming week's events across every sidebar-shown calendar, the total matching Google's per-calendar union, and reads one.
- On the Google Testing calendar only: an agent creates an event, changes its time, and deletes it, each visible in Google Calendar afterwards. No check ever writes to the primary calendar.
- Creating an event with an attendee outside the allowlist is refused before anything is created.

**Both accounts**
- The Drive, Sheets and Docs criteria above hold when run from the tamu account against the shared folder.
- With one account's authorization deliberately broken, a search names that account as incomplete and returns the other account's results.

**Mail**
- Every acceptance criterion in 001 still holds, with the scope names replaced.

**Tool surface**
- Each endpoint lists fewer than forty tools. Cursor connects to each and completes one call.
- In the agent-driven flows above, the transcript shows the agent choosing the correct tool on the first attempt for the ordinary operations — find, read, find row, update, append, add tab, read doc, replace — without exploratory calls to unrelated tools.

## Known Symptoms To Avoid (observed facts, not diagnosis)

- **First-tab blindness.** The Docs reader inherited from upstream asks Google for a document without requesting tab content, and Google then returns only the first tab with no indication that others exist. The same defect is open in the most popular community Workspace server. Any solution must request every tab and must never answer a question about one tab with the content of another.
- **Silent truncation.** The inherited Docs reader cuts content at two thousand characters with no way to read further. Any solution must return everything or an explicit index, never a silent cut.
- **Stale positions.** Docs positions shift after every edit. Any solution that lets the model hold a position between calls will eventually edit the wrong text. Positions are resolved by the server at edit time.
- **The 001 symptom** — a draft that reflows on Send — remains the reference example of "looks right in one place, differs when delivered", and the discipline it produced applies to every check here: read the result back from Google.

## Error Handling & Edge Cases

- **Lapsed authorization on one account:** named at the point of use; the other account is unaffected; the message says re-consent is needed, on the server, by the owner.
- **A Google service not enabled or not permitted for an account:** reported with the service and account named, and with the activation hint Google provides where it does.
- **Token predates the new consent:** an old Google token lacking Workspace scopes produces "this account has not consented to Drive/Docs/Sheets/Calendar; re-consent needed", not a generic permission error.
- **Rate limiting:** surfaced as a wait-and-retry condition, as for mail.
- **Ambiguous anchor, missing tab, unknown tab name, no matching rows:** refused or reported plainly with the candidates, never guessed.
- **Overwrite:** a write touches exactly the range named and reports what Google confirms changed.
- **Read-only client attempting a change:** refused by scope, with the scope named, before any call to Google.
- **Attendee or share target outside the allowlist:** refused before any call to Google, with the "tool will not allow this" framing, and a suggestion to do it by hand in Google.
- **Client tool ceiling:** a client that cannot hold both endpoints' tools connects to the one it needs; the server does not shrink or hide tools to fit.
