import { TELEGRAM_MAX_MESSAGE } from './config.ts';

/**
 * Telegram HTML correctness machinery: escaping, sanitizing, and tag-aware
 * message splitting.
 *
 * Telegram's HTML parse mode accepts only a small tag whitelist and rejects the
 * whole message on any malformed entity, so these are the functions that decide
 * whether a send succeeds. They are pure and dependency-free on purpose: no
 * network, no config beyond the size limit, so they can be exercised directly.
 *
 * Transport (which of these to apply, and the fallback ladder when Telegram
 * still refuses a message) lives in src/telegram.ts. Small presentational
 * helpers live in src/telegram-format.ts.
 */

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `text` escaped, and cut with an ellipsis so the escaped form stays within
 * maxChars. Measured after escaping, since every `<` grows to four characters:
 * a cap on the raw text does not bound the message. Never splits an entity or a
 * surrogate pair.
 */
export function clipEscapedTelegramHtml(text: string, maxChars: number): string {
  const escaped = escapeTelegramHtml(text);
  if (escaped.length <= maxChars) return escaped;
  let clipped = '';
  for (const char of text) {
    const piece = escapeTelegramHtml(char);
    if (clipped.length + piece.length > maxChars - 1) break;
    clipped += piece;
  }
  return `${clipped.trimEnd()}…`;
}

/**
 * The tags Telegram renders. Names match in lowercase only: model HTML is
 * lowercase, while code generics such as `Option<U>` or `impl<S>` are the
 * uppercase text that would otherwise turn into underline or strikethrough.
 */
const TELEGRAM_HTML_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'a',
  'code',
  'pre',
  'blockquote',
  'tg-spoiler',
  'tg-emoji',
  'span',
]);

/**
 * Real HTML elements Telegram does not render. The sanitizer drops these and
 * keeps the text inside them. Any other tag-shaped text, such as `Vec<T>` or
 * `#include <stdio.h>`, is escaped so it shows as written.
 */
const DROPPED_HTML_TAGS = new Set([
  'p',
  'div',
  'hr',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'sup',
  'sub',
  'small',
  'big',
  'mark',
  'kbd',
  'samp',
  'tt',
  'cite',
  'abbr',
  'center',
  'font',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'aside',
  'main',
  'figure',
  'figcaption',
  'details',
  'summary',
  'img',
  'html',
  'head',
  'body',
  'meta',
  'title',
  'link',
  'script',
  'style',
  'noscript',
  'iframe',
]);

/**
 * Anything shaped like a tag. Attribute text is quoted strings or characters
 * other than quotes and angle brackets, so in `a<b <i>c</i>` only `<i>` and
 * `</i>` match, and a `>` inside a quoted value does not end the tag.
 */
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'<>])*)>/g;
const ENTITY_RE = /&(?!(?:amp|lt|gt|quot|#\d+|#x[\da-fA-F]+);)/g;
const ATTR_RE = /\s+([a-zA-Z][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/y;

interface TagAttr {
  name: string;
  /** Null for a bare attribute such as `expandable`. */
  value: string | null;
}

/**
 * What a tag-shaped match is: a tag Telegram renders (`open`, `close`), a
 * `<br>`, an HTML element to drop, or text to show as written.
 */
type TagToken =
  | { kind: 'open'; name: string; html: string }
  | { kind: 'close'; name: string }
  | { kind: 'newline' }
  | { kind: 'drop' }
  | { kind: 'text' };

const TEXT: TagToken = { kind: 'text' };
const DROP: TagToken = { kind: 'drop' };

/**
 * Classifies one tag-shaped match, given the names of the tags open around it.
 * The sanitizer and the splitter share this, so the splitter only closes and
 * reopens tags the sanitizer keeps.
 *
 * Telegram entities cannot nest inside `code`, and `pre` holds only the `code`
 * that carries a language, so inside them every other tag is literal text.
 * Outside them a whitelisted name is a tag only when its attributes are
 * well-formed and quoted: `a<b and c>d` is a comparison, not bold.
 */
function classifyTag(
  isClose: boolean,
  name: string,
  rawAttrs: string,
  open: readonly string[],
): TagToken {
  const inCode = open.includes('code');
  const inPre = open.includes('pre');
  if (isClose) {
    if (rawAttrs.trim() !== '') return TEXT;
    if (inCode || inPre) {
      return (name === 'code' || name === 'pre') && open.includes(name)
        ? { kind: 'close', name }
        : TEXT;
    }
    if (TELEGRAM_HTML_TAGS.has(name)) return open.includes(name) ? { kind: 'close', name } : DROP;
    return name === 'br' || DROPPED_HTML_TAGS.has(name) ? DROP : TEXT;
  }

  if (inCode || (inPre && name !== 'code')) return TEXT;
  const attrs = parseAttrs(rawAttrs);
  const bareAllowed = (attr: TagAttr) => name === 'blockquote' && attr.name === 'expandable';
  if (!attrs || attrs.some((attr) => attr.value === null && !bareAllowed(attr))) return TEXT;
  if (name === 'br') return { kind: 'newline' };
  if (TELEGRAM_HTML_TAGS.has(name)) {
    const rendered = renderSanitizedAttrs(name, attrs);
    if (rendered === null) return DROP;
    return { kind: 'open', name, html: `<${name}${rendered}>` };
  }
  return DROPPED_HTML_TAGS.has(name) ? DROP : TEXT;
}

/** Parses a tag's attribute text, or returns null when it is not a well-formed attribute list. */
function parseAttrs(raw: string): TagAttr[] | null {
  const attrs: TagAttr[] = [];
  let cursor = 0;
  for (;;) {
    ATTR_RE.lastIndex = cursor;
    const match = ATTR_RE.exec(raw);
    if (!match) break;
    attrs.push({ name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? null });
    cursor = ATTR_RE.lastIndex;
  }
  return /^\s*\/?$/.test(raw.slice(cursor)) ? attrs : null;
}

/**
 * Rewrites arbitrary HTML into the subset Telegram accepts: real HTML elements
 * Telegram lacks are dropped, `<br>` becomes a newline, other tag-shaped text
 * and bare `&` are escaped, and unbalanced tags are closed. Used as the first
 * fallback when a raw send is rejected.
 */
export function sanitizeTelegramHtml(html: string): string {
  const stack: string[] = [];
  const out: string[] = [];
  let cursor = 0;
  // matchAll iterates a clone, so the shared TAG_RE keeps lastIndex 0 and no
  // manual reset is needed between calls.
  for (const match of html.matchAll(TAG_RE)) {
    const [full, slash, name, rawAttrs] = match;
    const start = match.index;
    if (start > cursor) {
      out.push(escapeTextSegment(html.slice(cursor, start)));
    }
    cursor = start + full.length;

    const tag = classifyTag(slash === '/', name, rawAttrs, stack);
    if (tag.kind === 'text') {
      out.push(escapeTextSegment(full));
    } else if (tag.kind === 'newline') {
      out.push('\n');
    } else if (tag.kind === 'open') {
      stack.push(tag.name);
      out.push(tag.html);
    } else if (tag.kind === 'close') {
      const idx = stack.lastIndexOf(tag.name);
      while (stack.length > idx) {
        out.push(`</${stack.pop()}>`);
      }
    }
  }
  if (cursor < html.length) {
    out.push(escapeTextSegment(html.slice(cursor)));
  }
  while (stack.length) {
    out.push(`</${stack.pop()}>`);
  }
  return out.join('');
}

function escapeTextSegment(text: string): string {
  return text.replace(ENTITY_RE, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttrValue(value: string): string {
  return value.replace(ENTITY_RE, '&amp;').replace(/"/g, '&quot;');
}

/** Returns the attribute string to emit, or null to drop the tag entirely. */
function renderSanitizedAttrs(tag: string, attrs: TagAttr[]): string | null {
  const value = (attr: string) => attrs.find((a) => a.name === attr)?.value?.trim();
  if (tag === 'a') {
    const href = value('href');
    if (!href) return null;
    return ` href="${escapeAttrValue(href)}"`;
  }
  if (tag === 'code') {
    const cls = value('class');
    if (cls) return ` class="${escapeAttrValue(cls)}"`;
    return '';
  }
  if (tag === 'span') {
    if (value('class') !== 'tg-spoiler') return null;
    return ' class="tg-spoiler"';
  }
  if (tag === 'tg-emoji') {
    const id = value('emoji-id');
    if (!id) return null;
    return ` emoji-id="${escapeAttrValue(id)}"`;
  }
  if (tag === 'blockquote') {
    if (attrs.some((a) => a.name === 'expandable')) return ' expandable';
    return '';
  }
  return '';
}

const SPLIT_TOKEN_RE = new RegExp(`${TAG_RE.source}|&(?:[a-zA-Z]+|#\\d+|#x[\\da-fA-F]+);`, 'g');

/**
 * The most markup a chunk may spend on tags carried over from the previous one
 * (their reopens plus closes), and the longest piece kept whole. Half a message
 * each, so a chunk that starts with carried tags always has room for the next
 * piece, and every flush makes progress.
 */
const MAX_CARRIED_MARKUP = Math.floor(TELEGRAM_MAX_MESSAGE / 2);

interface SplitFrame {
  name: string;
  openText: string;
  /** Length of the closes this frame and every frame outside it need. */
  closeLength: number;
  /** closeLength plus the length of reopening this frame and those outside it. */
  carryCost: number;
}

/**
 * Splits HTML into chunks that each fit TELEGRAM_MAX_MESSAGE, closing open tags
 * at every boundary and reopening them at the start of the next chunk so no
 * chunk is independently malformed. Never splits inside a tag, an entity or a
 * surrogate pair.
 *
 * Tags are recognised exactly as the sanitizer does, so tag-shaped text such as
 * `vector<int>` is kept whole but never carried across a boundary. Tags the
 * sanitizer drops are dropped here too, as is a tag that would take the carried
 * markup past MAX_CARRIED_MARKUP (the text it wraps stays).
 */
export function splitTelegramMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE) return [text];

  const chunks: string[] = [];
  const stack: SplitFrame[] = [];
  const openNames: string[] = [];
  let current = '';
  // How much of `current` is tags reopened from the previous chunk.
  let carried = 0;

  const closeLength = () => stack.at(-1)?.closeLength ?? 0;
  const closesFor = (frames: SplitFrame[]) =>
    frames
      .map((f) => `</${f.name}>`)
      .reverse()
      .join('');
  const truncateStack = (length: number) => {
    stack.length = length;
    openNames.length = length;
  };

  const flush = () => {
    if (current.length === carried) return;
    chunks.push(current + closesFor(stack));
    current = stack.map((f) => f.openText).join('');
    carried = current.length;
  };

  /** Appends a piece that must not be cut, first flushing if it would not fit. */
  const appendWhole = (piece: string, closeLengthAfter: number) => {
    if (current.length + piece.length + closeLengthAfter > TELEGRAM_MAX_MESSAGE) flush();
    current += piece;
  };

  const appendText = (segment: string) => {
    let remaining = segment;
    while (remaining.length > 0) {
      const room = TELEGRAM_MAX_MESSAGE - closeLength() - current.length;
      if (remaining.length <= room) {
        current += remaining;
        return;
      }
      // Only reachable with content in the chunk: the carry cap leaves an
      // otherwise empty chunk half a message of room.
      if (room <= 0) {
        flush();
        continue;
      }
      let splitAt = remaining.lastIndexOf('\n', room);
      if (splitAt < room / 2) {
        splitAt = room;
        if (isHighSurrogate(remaining.charCodeAt(splitAt - 1))) splitAt -= 1;
      }
      current += remaining.slice(0, splitAt);
      remaining = remaining.slice(splitAt).replace(/^\n/, '');
      flush();
    }
  };

  let cursor = 0;
  for (const match of text.matchAll(SPLIT_TOKEN_RE)) {
    const [token, slash, name, rawAttrs] = match;
    if (match.index > cursor) appendText(text.slice(cursor, match.index));
    cursor = match.index + token.length;

    // Entities match without a tag name; they are always short.
    const tag = name === undefined ? TEXT : classifyTag(slash === '/', name, rawAttrs, openNames);
    if (tag.kind === 'open') {
      const outer = stack.at(-1);
      const tagClose = tag.name.length + 3;
      const frame: SplitFrame = {
        name: tag.name,
        openText: token,
        closeLength: (outer?.closeLength ?? 0) + tagClose,
        carryCost: (outer?.carryCost ?? 0) + token.length + tagClose,
      };
      if (frame.carryCost > MAX_CARRIED_MARKUP) continue;
      appendWhole(token, frame.closeLength);
      stack.push(frame);
      openNames.push(frame.name);
    } else if (tag.kind === 'close') {
      const idx = openNames.lastIndexOf(tag.name);
      if (current.length === carried) {
        // Nothing followed the reopened tags yet, so stop reopening the ones this
        // closes rather than leave a chunk of empty tags at the end.
        truncateStack(idx);
        current = stack.map((f) => f.openText).join('');
        carried = current.length;
      } else {
        // Always fits: the chunk already had room for these closes.
        current += closesFor(stack.slice(idx));
        truncateStack(idx);
      }
    } else if (tag.kind !== 'drop') {
      // An entity, a <br> or tag-shaped text: kept whole unless it is too long to fit.
      if (token.length > MAX_CARRIED_MARKUP) appendText(token);
      else appendWhole(token, closeLength());
    }
  }
  if (cursor < text.length) appendText(text.slice(cursor));

  if (current.length > carried) {
    chunks.push(current + closesFor(stack));
  }
  return chunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
