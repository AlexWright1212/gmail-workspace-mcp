/**
 * Single source of truth for outgoing MIME construction.
 *
 * Every outgoing message this server produces (drafts and sends alike) is built
 * here, by nodemailer's MailComposer. Nothing else in the codebase is allowed to
 * concatenate MIME by hand.
 *
 * Why this module exists
 * ----------------------
 * The previous hand-rolled builder emitted a single-part `text/plain` body with
 * no `Content-Transfer-Encoding` header. A paragraph longer than ~78 characters
 * therefore had no legal way to survive SMTP's line-length limit, so Gmail's
 * backend hard-wrapped it during delivery: the draft looked like one paragraph,
 * the delivered mail arrived chopped into ~70-80 char lines. Gmail also
 * synthesizes whichever alternative part is missing, which is a second source of
 * draft-vs-delivered divergence.
 *
 * The fix, structurally:
 *   - ALWAYS emit `multipart/alternative` carrying BOTH a text/plain and a
 *     text/html part. Never a single-part body, even if the caller only ever
 *     thinks in terms of one of them.
 *   - Force `Content-Transfer-Encoding: quoted-printable` on both parts, so long
 *     logical lines are carried by QP *soft* line breaks (`=\r\n`) and are
 *     reassembled by the receiving client as a single unbroken paragraph.
 *
 * Input contract (deliberate, documented):
 *   `body` is the ONE source of truth and is plain text with a small,
 *   predictable markdown-ish subset:
 *     - blocks separated by blank lines become paragraphs (`<p>` in HTML)
 *     - a single newline inside a block is a line break (`<br>` in HTML)
 *     - a run of lines starting with `-`, `*` or `+` becomes `<ul>`; indented
 *       runs nest. A run of `1.` / `1)` lines becomes `<ol>` — but only when the
 *       run has two or more entries, so prose like "1984. It was cold." stays
 *       prose. The first number is carried through as `<ol start="…">`.
 *     - `[text](url)` becomes a link (http/https/mailto only), `**bold**` and
 *       `*italic*` / `_italic_` become `<strong>` / `<em>`, and bare http(s)
 *       URLs are auto-linked. The plain part keeps the markdown source verbatim,
 *       which is what every markdown-based mailer does.
 *     - nothing else is interpreted: `<`, `>`, `&`, `"` and `'` are escaped and
 *       render as literal text
 *   Callers do NOT supply raw HTML. That is intentional: a model-authored HTML
 *   blob would force us to guess the plain-text part, which is exactly how the
 *   two parts drift apart.
 *
 * The ONE exception: `signatureHtml` (a trusted channel, not a general one)
 * ------------------------------------------------------------------------
 *   Gmail stores signatures as HTML, in the owner's own account settings. There
 *   is no plain-text version of a Gmail signature to read — Gmail does not store
 *   one — so "derive both parts from one authored source" cannot be satisfied by
 *   asking for the signature in our markdown-ish dialect.
 *
 *   `signatureHtml` is therefore accepted as literal HTML and inserted verbatim
 *   into the html part, with a DERIVED plain-text rendering (`htmlToPlainText`
 *   below) appended to the text part. That keeps the invariant that matters —
 *   both parts still say the same thing, and neither is synthesized by Gmail.
 *
 *   Why this does not reopen the divergence bug:
 *     - it is one narrow, separately-named field, not a general `html` escape
 *       hatch. `body` still has exactly one authored source.
 *     - the plain-text side is DERIVED here, not supplied. A caller cannot hand
 *       us an html signature and a contradicting text signature, because there
 *       is nowhere to put the second one.
 *     - the ONLY production caller sources it from `users.settings.sendAs`
 *       (see GmailAccountClient.getSignature). `OutgoingMessageInput` — the type
 *       every MCP tool argument is funnelled through — has no `signatureHtml`
 *       field at all, only a boolean `includeSignature`. There is no path from a
 *       tool argument to this parameter, by construction rather than by review.
 *
 *   Trust boundary: this is the owner's own markup out of the owner's own Gmail
 *   settings, so it is not escaped. Do NOT widen this door to anything a model
 *   authored or anything derived from incoming mail.
 *
 * What deriving both parts from one string does and does NOT buy us:
 *   It guarantees there is exactly one authored source of truth — no caller can
 *   hand us an HTML part that says something the text part does not, and no part
 *   is ever synthesized by Gmail from the other. It does NOT guarantee the two
 *   parts agree: they agree only insofar as the renderer below is correct. The
 *   renderer has already been wrong in both directions (an ordered-list rule that
 *   deleted a leading "1984." from the HTML part only; a list terminated by a
 *   sentence that rendered as literal hyphens). Treat any renderer change as a
 *   change that can silently desynchronize the two parts, and test both.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { cleanupIfInOutbox } from './outbox.js';

export interface ComposeAttachmentInput {
  /** Local filesystem path to the file to attach. */
  path: string;
  /** Optional override for the filename shown to the recipient. */
  filename?: string;
  /** Optional MIME type override; otherwise inferred from the filename. */
  contentType?: string;
}

export interface ComposeInput {
  /** Recipient address(es), comma separated. Required. */
  to: string;
  /** Subject line. Pass it raw — RFC 2047 encoding is applied here, once. */
  subject: string;
  /** Plain-text, markdown-ish body. Single source of truth for both MIME parts. */
  body: string;
  /** Optional From header. Also used to derive the Message-ID domain. */
  from?: string;
  cc?: string;
  bcc?: string;
  attachments?: ComposeAttachmentInput[];
  /** RFC 2822 Message-ID of the parent message, verbatim (angle brackets included). */
  inReplyTo?: string;
  /** RFC 2822 References chain, verbatim. */
  references?: string;
  /**
   * TRUSTED HTML, and the only HTML this module accepts.
   *
   * Must come from `users.settings.sendAs` — the owner's own Gmail signature —
   * and from nowhere else. It is inserted verbatim into the html part; a derived
   * plain-text rendering is appended to the text part. See the module docblock
   * for why this is not a general `html` parameter.
   */
  signatureHtml?: string;
}

/** Escape the five characters that would otherwise be read as markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Content handed to the quoted-printable encoder must already use CRLF.
 *
 * Not for line-length reasons: nodemailer's QP wrapper (`lib/qp/index.js`,
 * `wrap()`) handles a bare LF perfectly well. Measured on a multi-paragraph
 * body, the longest raw line is 76 bytes with this call and 76 bytes without it.
 *
 * The reason is line endings. The encoder passes a lone LF straight through, so
 * without this call every newline in the body arrives in the built message as a
 * bare LF line ending (4 of them in that same measurement) instead of CRLF. A
 * bare LF is not a legal RFC 5322 line ending, and it is exactly the sort of
 * detail an intermediate agent "helpfully" normalizes — i.e. rewrites our body,
 * which is the entire failure class this module exists to prevent.
 */
function toCrlf(value: string): string {
  return normalizeNewlines(value).replace(/\n/g, '\r\n');
}

/**
 * The text/plain part: the caller's body, essentially verbatim.
 *
 * Only trailing whitespace per line is stripped (it is invisible, and it turns
 * into noisy `=20` sequences under quoted-printable). Nothing is re-wrapped —
 * re-wrapping here is precisely the bug this module exists to prevent.
 */
export function renderPlainText(body: string): string {
  return normalizeNewlines(body)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Inline rendering: links and emphasis.
//
// The single most dangerous thing this module does is turn caller text into an
// `href`, so the order of operations is fixed and deliberate:
//
//   1. the source is scanned ONCE, left to right, into literal runs and
//      recognized constructs. Nothing is ever re-scanned after being turned into
//      markup, so generated tags can never be re-parsed as source.
//   2. a URL is admitted only if it starts with http:, https: or mailto:.
//      Anything else (javascript:, data:, a bare path) is not a link — the whole
//      `[text](url)` source is emitted as escaped literal text instead.
//   3. every literal run AND every admitted URL goes through escapeHtml before
//      it reaches the output, so `&` becomes `&amp;` and `"` becomes `&quot;`
//      inside the attribute. Breaking out of the attribute would require an
//      unescaped quote, and there is no path that produces one.
//
// Anything unmatched (`**bold`, `[text](`) simply falls through as literal text.
// ---------------------------------------------------------------------------

/** `[text](url)`. The URL may contain one balanced pair of parentheses. */
const LINK = /\[([^[\]]*)\]\(([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/y;
/** A bare URL, minus any trailing punctuation that is obviously sentence-final. */
const AUTOLINK = /https?:\/\/[^\s<>"'`]+/y;
const BOLD = /\*\*(?=\S)([^\n]*?[^\s*])\*\*/y;
const ITALIC_STAR = /\*(?=[^\s*])([^*\n]*?[^\s*]|[^\s*])\*/y;
const ITALIC_UNDERSCORE = /_(?=[^\s_])([^_\n]*?[^\s_]|[^\s_])_/y;
const SAFE_URL_SCHEME = /^(?:https?|mailto):/i;

/** Is `url` safe to place in an href? Scheme allowlist, nothing clever. */
function isSafeUrl(url: string): boolean {
  // Control characters can smuggle a scheme past a naive reader ("java\tscript:").
  if (/[\u0000-\u0020\u007f]/.test(url)) return false;
  return SAFE_URL_SCHEME.test(url);
}

function matchAt(pattern: RegExp, source: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(source);
}

/**
 * Render one line of source text as inline HTML.
 * `allowLinks` is false inside a link's own text so links cannot nest.
 */
function renderInline(source: string, allowLinks = true): string {
  let out = '';
  let literal = '';
  let i = 0;

  const flush = () => {
    if (literal !== '') {
      out += escapeHtml(literal);
      literal = '';
    }
  };

  while (i < source.length) {
    const char = source[i];

    if (allowLinks && char === '[') {
      const match = matchAt(LINK, source, i);
      if (match) {
        const [whole, text, url] = match;
        if (isSafeUrl(url)) {
          flush();
          out += `<a href="${escapeHtml(url)}">${renderInline(text, false)}</a>`;
        } else {
          // Not a link: emit the source verbatim (escaped) and move past it, so
          // a rejected scheme can never be partially re-interpreted.
          literal += whole;
        }
        i += whole.length;
        continue;
      }
    }

    if (allowLinks && (char === 'h' || char === 'H')) {
      // A URL sitting inside what is obviously quoted or attribute-like text
      // (a literal `<a href="https://…">` the author typed out) stays literal:
      // the surrounding tag is escaped, so linking its innards is just noise.
      const quoted = i > 0 && /["'=<\/]/.test(source[i - 1]);
      const match = quoted ? null : matchAt(AUTOLINK, source, i);
      if (match) {
        // Trailing sentence punctuation belongs to the prose, not the URL.
        const url = match[0].replace(/[.,;:!?)\]]+$/, '');
        if (url !== '' && isSafeUrl(url)) {
          flush();
          out += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
          i += url.length;
          continue;
        }
      }
    }

    if (char === '*' && source[i + 1] === '*') {
      const match = matchAt(BOLD, source, i);
      if (match) {
        flush();
        out += `<strong>${renderInline(match[1], allowLinks)}</strong>`;
        i += match[0].length;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      // `snake_case` must not turn into emphasis, so an underscore only opens
      // emphasis when the character before it is not part of a word.
      const previous = i === 0 ? '' : source[i - 1];
      const wordBefore = /[\p{L}\p{N}]/u.test(previous);
      if (!(char === '_' && wordBefore)) {
        const match = matchAt(char === '*' ? ITALIC_STAR : ITALIC_UNDERSCORE, source, i);
        const after = match ? source[i + match[0].length] ?? '' : '';
        const wordAfter = /[\p{L}\p{N}]/u.test(after);
        if (match && !(char === '_' && wordAfter)) {
          flush();
          out += `<em>${renderInline(match[1], allowLinks)}</em>`;
          i += match[0].length;
          continue;
        }
      }
    }

    literal += char;
    i += 1;
  }

  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Block rendering: paragraphs and (possibly nested) lists.
// ---------------------------------------------------------------------------

const UNORDERED = /^([ \t]*)[-*+][ \t]+(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;

interface ListLine {
  indent: number;
  kind: 'ul' | 'ol';
  start: number;
  content: string;
}

/** Width of a leading indent, tabs counted as four columns. */
function indentWidth(prefix: string): number {
  let width = 0;
  for (const char of prefix) width += char === '\t' ? 4 : 1;
  return width;
}

function matchListLine(line: string): ListLine | null {
  const unordered = UNORDERED.exec(line);
  if (unordered) {
    return { indent: indentWidth(unordered[1]), kind: 'ul', start: 1, content: unordered[2] };
  }
  const ordered = ORDERED.exec(line);
  if (ordered) {
    return {
      indent: indentWidth(ordered[1]),
      kind: 'ol',
      start: Number(ordered[2]),
      content: ordered[3],
    };
  }
  return null;
}

interface ListItemNode {
  text: string;
  children: ListNode[];
}
interface ListNode {
  kind: 'ul' | 'ol';
  start: number;
  items: ListItemNode[];
}
type Block = { kind: 'p'; lines: string[] } | { kind: 'list'; nodes: ListNode[] };

/**
 * Build one indentation level of a list, recursing for deeper indents.
 * Returns the sibling lists found at `indent` and the index it stopped at.
 */
function buildLevel(
  items: ListLine[],
  start: number,
  indent: number
): { nodes: ListNode[]; next: number } {
  const nodes: ListNode[] = [];
  let current: ListNode | null = null;
  let i = start;

  while (i < items.length) {
    const item = items[i];
    if (item.indent < indent) break;

    if (item.indent > indent) {
      const nested = buildLevel(items, i, item.indent);
      const parent = current?.items[current.items.length - 1];
      // A deeper line with no item to hang off of becomes a sibling list rather
      // than being dropped: nesting may degrade, content never disappears.
      if (parent) parent.children.push(...nested.nodes);
      else nodes.push(...nested.nodes);
      i = nested.next;
      continue;
    }

    if (!current || current.kind !== item.kind) {
      current = { kind: item.kind, start: item.start, items: [] };
      nodes.push(current);
    }
    current.items.push({ text: item.content, children: [] });
    i += 1;
  }

  return { nodes, next: i };
}

/**
 * Decide, line by line, what is a list item and what is prose.
 *
 * A `-`/`*`/`+` line is always a bullet. A `1.` / `1)` line is only an ordered
 * item when it sits in a run of two or more consecutive ordered lines: a lone
 * one is prose that happens to start with a number ("1984. It was cold."), and
 * treating it as a list silently deletes the number from the HTML part.
 */
function classify(lines: string[]): (ListLine | null)[] {
  const matches = lines.map(matchListLine);
  for (let i = 0; i < matches.length; i += 1) {
    if (matches[i]?.kind !== 'ol') continue;
    let end = i;
    while (end + 1 < matches.length && matches[end + 1]?.kind === 'ol') end += 1;
    if (end === i) matches[i] = null;
    i = end;
  }
  return matches;
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const lines = current;
    current = [];

    const matches = classify(lines);
    let i = 0;
    while (i < lines.length) {
      if (matches[i]) {
        const run: ListLine[] = [];
        while (i < lines.length && matches[i]) {
          run.push(matches[i] as ListLine);
          i += 1;
        }
        // Start at the run's SHALLOWEST indent, and keep going until every line
        // has been placed. buildLevel stops at anything less indented than the
        // level it was asked for, and an unconsumed item here is a dropped line.
        const base = Math.min(...run.map((item) => item.indent));
        const nodes: ListNode[] = [];
        let position = 0;
        while (position < run.length) {
          const level = buildLevel(run, position, base);
          nodes.push(...level.nodes);
          if (level.next === position) break; // cannot happen; never loop forever
          position = level.next;
        }
        blocks.push({ kind: 'list', nodes });
        continue;
      }
      const prose: string[] = [];
      while (i < lines.length && !matches[i]) {
        prose.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: 'p', lines: prose });
    }
  };

  for (const line of text.split('\n')) {
    if (line.trim() === '') flush();
    else current.push(line);
  }
  flush();

  return blocks;
}

function renderList(node: ListNode): string {
  // Keep the author's numbering: "5. five" must not silently become "1. five".
  const attribute = node.kind === 'ol' && node.start !== 1 ? ` start="${node.start}"` : '';
  const items = node.items
    .map((item) => `<li>${renderInline(item.text.trim())}${item.children.map(renderList).join('')}</li>`)
    .join('');
  return `<${node.kind}${attribute}>${items}</${node.kind}>`;
}

/**
 * Render a prose line. Leading indentation is turned into non-breaking spaces
 * instead of being trimmed away — HTML collapses runs of spaces, and trimming
 * silently destroyed indented blocks (pasted code, hanging indents).
 */
function renderProseLine(line: string): string {
  const indent = /^[ \t]*/.exec(line)![0];
  const spaces = indent.replace(/\t/g, '    ').replace(/ /g, '&nbsp;');
  return spaces + renderInline(line.slice(indent.length).replace(/[ \t]+$/, ''));
}

/**
 * The text/html part, derived from the same body string as the text part.
 * Wrapped in `<div dir="ltr">` to match what Gmail itself emits.
 */
export function renderHtml(body: string): string {
  const blocks = splitBlocks(renderPlainText(body));

  const rendered = blocks.map((block) => {
    if (block.kind === 'p') {
      return `<p>${block.lines.map(renderProseLine).join('<br>')}</p>`;
    }
    return block.nodes.map(renderList).join('');
  });

  return `<div dir="ltr">${rendered.join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Signature: the one trusted-HTML path.
//
// The html part gets the owner's markup verbatim. The text part gets the
// rendering below, so the two parts still carry the same words and the same
// link targets. Nothing here is a security control — the input is the owner's
// own Gmail settings — it exists so the alternative parts do not diverge.
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** Decode the entity forms a Gmail signature can realistically contain. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** Read one attribute out of a start tag, entity-decoded. */
function tagAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = pattern.exec(tag);
  if (!match) return null;
  return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '').trim();
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'tr', 'li', 'ul', 'ol', 'table', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer',
]);

/**
 * Render trusted signature HTML as the plain text that means the same thing.
 *
 * Link URLs are preserved — a signature whose text part silently dropped the
 * "book a call" link would be a divergence between the two parts, which is the
 * whole failure class this module exists to prevent. A link whose text already
 * IS its URL is emitted once rather than as "url (url)".
 */
export function htmlToPlainText(html: string): string {
  // <style>/<script> content is markup, not words: drop it whole.
  let source = html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

  let out = '';
  let index = 0;
  // Set while inside <a href="...">, so the closer can append the URL.
  let linkHref: string | null = null;
  let linkTextStart = 0;

  const TAG = /<\/?([a-z][a-z0-9]*)\b[^>]*>|<!--[\s\S]*?-->/gi;
  let match: RegExpExecArray | null;

  while ((match = TAG.exec(source)) !== null) {
    out += source.slice(index, match.index);
    index = TAG.lastIndex;

    const whole = match[0];
    if (whole.startsWith('<!--')) continue;

    const name = (match[1] ?? '').toLowerCase();
    const closing = whole.startsWith('</');

    // A <br> ALWAYS emits. Gmail's own signature editor writes a blank line as
    // `<div><br></div>`, so swallowing a <br> that follows a block boundary
    // would delete deliberate spacing from the text part.
    if (name === 'br' || name === 'hr') {
      out += '\n';
      continue;
    }
    if (name === 'img' && !closing) {
      const alt = tagAttribute(whole, 'alt');
      if (alt) out += alt;
      continue;
    }
    if (name === 'a') {
      if (closing) {
        if (linkHref) {
          const text = decodeHtmlEntities(out.slice(linkTextStart)).trim();
          // mailto:alex@x.com shown as "alex@x.com" is the same information.
          const bare = linkHref.replace(/^mailto:/i, '');
          if (text !== '' && text !== linkHref && text !== bare) {
            out += ` (${linkHref})`;
          } else if (text === '') {
            out += linkHref;
          }
        }
        linkHref = null;
      } else {
        const href = tagAttribute(whole, 'href');
        linkHref = href && href !== '' && !href.startsWith('#') ? href : null;
        linkTextStart = out.length;
      }
      continue;
    }
    if (BLOCK_TAGS.has(name)) {
      // One line break per boundary, not one per tag. `</div><div>` is a single
      // transition between two lines; emitting a newline for the closer AND the
      // opener double-spaces every line of a Gmail signature (which is written
      // as one <div> per line), so the text part would not match the html part.
      if (out !== '' && !out.endsWith('\n')) out += '\n';
      continue;
    }
    // Everything else (span, strong, em, font, b, i, u, td, ...) contributes no
    // text of its own; its children are already being emitted.
  }
  out += source.slice(index);

  return decodeHtmlEntities(out)
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Wrap the signature the way Gmail's own compose wraps it.
 *
 * The `gmail_signature` class and `data-smartmail` attribute are what Gmail
 * emits around a signature it inserted itself. Reproducing them is the closest
 * thing available to telling Gmail's compose UI "this draft already has a
 * signature" — see the duplication risk noted in the README/verification list.
 * It is a best effort, not a guarantee: verify against a real delivered message.
 */
function signatureHtmlBlock(signatureHtml: string): string {
  return (
    `<br><div class="gmail_signature" data-smartmail="gmail_signature">` +
    `${signatureHtml}</div>`
  );
}

/** Strip CR/LF from a header value so a body string can never inject headers. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Address validation.
//
// Folding CR/LF to a space is NOT enough for an address field. The colon
// survives, and RFC 5322 group syntax (`display-name: mailbox-list;`) then reads
// "alex@gmail.com\r\nBcc: evil@attacker.com" as a group named "alex@gmail.com
// Bcc" containing the single mailbox evil@attacker.com. The real recipient is
// demoted to a display name and the attacker becomes the only recipient — and
// because Gmail's `raw` upload derives the envelope from these headers, that is
// a genuine recipient swap, not a cosmetic one.
//
// So: every address field is parsed and every mailbox must look like a real
// `local@domain`. Group syntax is rejected outright, and anything that does not
// parse is a loud error rather than a silently missing header.
// ---------------------------------------------------------------------------

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}$/u;

export interface ParsedAddress {
  name: string;
  address: string;
}

function reject(field: string, value: string, reason: string): never {
  throw new Error(
    `Invalid "${field}" address: ${JSON.stringify(value)} — ${reason}. ` +
      'No message was created. Supply addresses as "name@example.com" or ' +
      '"Name <name@example.com>", separated by commas.'
  );
}

/** True if `value` has a `:` or `;` that is not inside a `<...>` addr-spec. */
function hasStructuralPunctuation(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === '<') depth += 1;
    else if (char === '>') depth = Math.max(0, depth - 1);
    else if ((char === ':' || char === ';') && depth === 0) return true;
  }
  return false;
}

function isPlausibleMailbox(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || address.length > 254) return false;
  return LOCAL_PART.test(local) && DOMAIN.test(domain);
}

/**
 * Parse and validate one address-list field. Throws — loudly, naming the field
 * and the offending value — rather than letting a bad address produce a message
 * with a missing or substituted header.
 */
export function parseAddressList(field: string, value: string | undefined): ParsedAddress[] {
  if (value === undefined || value === null) return [];
  const raw = String(value);
  if (raw.trim() === '') return [];

  if (/[\r\n]/.test(raw)) {
    reject(field, raw, 'it contains a line break, which is a header-injection attempt');
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    reject(field, raw, 'it contains a control character');
  }
  if (hasStructuralPunctuation(raw)) {
    reject(
      field,
      raw,
      'it contains ":" or ";" outside an address, which RFC 5322 reads as group ' +
        'syntax and would silently replace the recipient'
    );
  }

  const parsed = addressparser(raw) as Array<{
    name?: string;
    address?: string;
    group?: unknown[];
  }>;
  if (parsed.length === 0) {
    reject(field, raw, 'no address could be parsed from it');
  }

  return parsed.map((entry) => {
    if (Array.isArray(entry.group)) {
      reject(field, raw, 'RFC 5322 group syntax is not accepted in an address field');
    }
    const address = (entry.address ?? '').trim();
    const name = (entry.name ?? '').trim();
    if (address === '') {
      reject(field, raw, `"${name}" is not an email address`);
    }
    if (name.includes('@')) {
      // "victim@example.com attacker@evil.com" parses as one mailbox with the
      // victim as a display name. Ambiguous by construction; refuse it.
      reject(field, raw, `"${name}" looks like a second address but is being used as a display name`);
    }
    if (!isPlausibleMailbox(address)) {
      reject(field, raw, `"${address}" is not a valid local@domain mailbox`);
    }
    return { name, address };
  });
}

function addressField(field: string, value: string | undefined): ParsedAddress[] | undefined {
  const parsed = parseAddressList(field, value);
  return parsed.length === 0 ? undefined : parsed;
}

interface ResolvedAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

async function readAttachment(input: ComposeAttachmentInput): Promise<ResolvedAttachment> {
  const filePath = input.path.trim();
  if (filePath === '') {
    throw new Error('Attachment path is empty. Provide a readable local file path.');
  }

  let content: Buffer;
  try {
    content = await fs.readFile(filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    throw new Error(
      `Attachment could not be read: "${filePath}" (${err.code ?? 'error'}: ${err.message}). ` +
        'No message was created — fix the path or drop the attachment.'
    );
  }

  await cleanupIfInOutbox(filePath);

  const filename = sanitizeHeaderValue(input.filename?.trim() || path.basename(filePath));
  if (filename === '') {
    throw new Error(`Attachment "${filePath}" resolved to an empty filename.`);
  }

  return {
    filename,
    content,
    contentType: input.contentType?.trim() || undefined,
  };
}

/**
 * Build the full RFC 5322 message. Returns raw MIME bytes.
 */
export async function buildMimeMessage(input: ComposeInput): Promise<Buffer> {
  // Validate every address field up front. A field that does not parse must be
  // an error here: nodemailer answers an unparseable address by emitting no
  // header at all, which produced drafts with no `To:` and no complaint.
  const to = addressField('to', input.to);
  if (!to) {
    throw new Error('Recipient "to" is required.');
  }
  const cc = addressField('cc', input.cc);
  const bcc = addressField('bcc', input.bcc);
  const from = addressField('from', input.from);
  if (from && from.length > 1) {
    // A second From is not a formatting quirk: it decides the Message-ID domain
    // and is how a smuggled sender would ride along.
    throw new Error(
      `Invalid "from" address: ${JSON.stringify(input.from)} — a message has exactly ` +
        'one sender. No message was created.'
    );
  }

  const attachments = await Promise.all(
    (input.attachments ?? [])
      .filter((attachment) => attachment.path.trim() !== '')
      .map((attachment) => readAttachment(attachment))
  );

  let text = renderPlainText(input.body ?? '');
  let html = renderHtml(input.body ?? '');

  // The signature is appended to BOTH parts or to neither. The html side is the
  // owner's own markup verbatim; the text side is derived from that same markup,
  // so the two parts cannot say different things.
  const signature = (input.signatureHtml ?? '').trim();
  if (signature !== '') {
    const signatureText = htmlToPlainText(signature);
    html += signatureHtmlBlock(signature);
    if (signatureText !== '') {
      text = text === '' ? signatureText : `${text}\n\n${signatureText}`;
    }
  }

  // MailComposer drops a falsy `text`, which would collapse the message to a
  // single part. A newline keeps the alternative structure for an empty body.
  const textContent = text === '' ? '\n' : text;

  const composer = new MailComposer({
    from,
    to,
    cc,
    bcc,
    // Pass the subject raw. nodemailer applies RFC 2047 encoding exactly once;
    // pre-encoding here would double-encode it.
    subject: sanitizeHeaderValue(input.subject ?? ''),
    inReplyTo: input.inReplyTo ? sanitizeHeaderValue(input.inReplyTo) : undefined,
    references: input.references ? sanitizeHeaderValue(input.references) : undefined,
    // Force quoted-printable on both body parts. Without it nodemailer may pick
    // 7bit, and long lines then depend on the transport behaving itself.
    // (`contentTransferEncoding` is supported per-alternative by MailComposer
    // but is missing from @types/nodemailer's narrower AttachmentLike type.)
    text: { content: toCrlf(textContent), contentTransferEncoding: 'quoted-printable' } as never,
    html: { content: toCrlf(html), contentTransferEncoding: 'quoted-printable' } as never,
    textEncoding: 'quoted-printable',
    attachments: attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    })),
    // Attachment bytes are read above so failures are explicit; never let the
    // MIME layer touch the filesystem or network on its own.
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  const node = composer.compile();
  // Gmail's `raw` upload is not SMTP: the Bcc header in the message is what
  // actually produces a blind copy, so it must not be stripped.
  (node as unknown as { keepBcc: boolean }).keepBcc = true;

  return escapeMboxFromLines(await node.build());
}

/**
 * Escape a body line that begins with "From " as `=46rom `.
 *
 * mbox-format stores (Gmail Takeout among them) delimit messages with a line
 * starting "From ", so an unescaped one inside a body can split a message in
 * two when the archive is read back. Standard quoted-printable practice is to
 * encode the leading F; `=46rom` decodes to `From`, so nothing changes for a
 * normal reader. Delivery is unaffected either way — this is archive hygiene.
 *
 * Only bodies whose part declares `quoted-printable` are touched, since `=46`
 * is meaningless in any other encoding. Base64 lines cannot contain a space and
 * header lines start with `From:`, not `From `, so nothing else can collide.
 */
function escapeMboxFromLines(mime: Buffer): Buffer {
  // latin1 is a byte-preserving round trip; utf8 would mangle attachment bytes.
  const lines = mime.toString('latin1').split('\r\n');
  const boundaries = new Set<string>();
  let inHeaders = true;
  let encoding = '';
  let touched = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('--') && boundaries.has(line.replace(/--$/, '').slice(2))) {
      inHeaders = true;
      encoding = '';
      continue;
    }

    if (inHeaders) {
      if (line === '') {
        inHeaders = false;
        continue;
      }
      const boundary = /boundary="?([^";]+)"?/i.exec(line);
      if (boundary) boundaries.add(boundary[1]);
      const cte = /^content-transfer-encoding:\s*(\S+)/i.exec(line);
      if (cte) encoding = cte[1].toLowerCase();
      continue;
    }

    if (encoding !== 'quoted-printable' || !line.startsWith('From ')) continue;

    const rest = line.slice(4); // keeps the space that follows "From"
    // "=46rom" is three characters longer than "From"; if that would push the
    // line past the 76-char quoted-printable limit, take a soft break instead.
    lines[i] = line.length + 3 <= 76 ? `=46rom${rest}` : `=46rom=\r\n${rest}`;
    touched = true;
  }

  return touched ? Buffer.from(lines.join('\r\n'), 'latin1') : mime;
}

/** Base64url-encoded message, ready for the Gmail API `raw` field. */
export async function buildRawMessage(input: ComposeInput): Promise<string> {
  const mime = await buildMimeMessage(input);
  return mime
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
