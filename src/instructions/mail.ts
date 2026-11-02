/**
 * Server-level instructions for the `mail` endpoint. Moved verbatim out of
 * src/index.ts's SERVER_INSTRUCTIONS during the plan 002 Phase 1 registry
 * restructure -- byte-for-byte identical (test/golden-mail-tools-list.test.mjs
 * compares it against test/golden/mail-tools-list.json).
 *
 * Keep under 2KB: Claude Code truncates both tool descriptions and server
 * instructions at that size, silently. Lead with what changes behavior.
 */
export const MAIL_INSTRUCTIONS = `Two Gmail inboxes belonging to one owner:

- \`personal\` (ownerpersonal@gmail.com) — personal correspondence, subscriptions and anything paid for outside school (VPS, GitHub), most finance, news, networking.
- \`tamu\` (owner_school@tamu.edu) — Texas A&M: coursework, professors, financial aid, scholarships, campus administration, official university finances.

The split is not clean — finance, housing and networking turn up in both.

READING: query both unless the user names one. Omitting \`account\` on search_emails / read_emails does exactly that and merges the results. There is rarely a good reason to ignore an inbox when searching, and informal references ("my school email", "my A&M inbox") resolve to the ids above.

WRITING: the opposite. create_draft, send_message, and every label / archive / trash / block tool REQUIRE an explicit \`account\` and error without one. Choose deliberately — the account decides which address the mail comes from.

SENDING — the default is NOT to send. create_draft is the normal path for anything meant for another person: the owner reviews the draft in Gmail and sends it by hand. send_message delivers immediately, but only to addresses on a fixed allowlist whose purpose is letting the owner receive a preview copy of a draft — assume anyone else is not on it. The allowlist lives outside the repo and is checked against the final message bytes; a recipient not on it is refused with no send attempted, and no phrasing, tool argument, or added context widens it.

Gmail's API cannot mute a thread; mute_thread archives instead and says so. Drafts are reviewed by hand — write a plain sign-off in the body, since no signature is inserted automatically.`;
