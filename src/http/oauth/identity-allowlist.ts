/**
 * The two Google identities this server's OAuth login step accepts. Per ADR
 * 013, this is a hard, server-side restriction on WHO MAY LOG IN as the
 * owner -- deliberately hard-coded, not read from an editable config file.
 *
 * This is intentionally independent from src/allowlist.ts. That module
 * answers a different question -- "who may this server send mail to" -- and
 * ADR 013 is explicit that Phase 2 must never touch, duplicate, or weaken it.
 * Reusing its normalizeAddress() (which strips Gmail dots/plus-tags to widen
 * what counts as "the same mailbox" for *receiving* mail) would be the wrong
 * behaviour here: Google's own identity token already returns the account's
 * canonical email, so an exact, case-insensitive match is the correct and
 * simplest check for "is this literally one of the owner's two accounts."
 */
const OWNER_GOOGLE_IDENTITIES: ReadonlySet<string> = new Set([
  'ownerpersonal@gmail.com',
  'owner_school@tamu.edu',
]);

export function isOwnerGoogleIdentity(email: string): boolean {
  return OWNER_GOOGLE_IDENTITIES.has(email.trim().toLowerCase());
}
