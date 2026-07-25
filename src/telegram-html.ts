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

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const ENTITY_RE = /&(?!(?:amp|lt|gt|quot|#\d+|#x[\da-fA-F]+);)/g;

/**
 * Rewrites arbitrary HTML into the subset Telegram accepts: unknown tags are
 * dropped, `<br>` becomes a newline, bare `&` is escaped, and unbalanced tags
 * are closed. Used as the first fallback when a raw send is rejected.
 */
export function sanitizeTelegramHtml(html: string): string {
  const stack: string[] = [];
  const out: string[] = [];
  let cursor = 0;
  // matchAll iterates a clone, so the shared TAG_RE keeps lastIndex 0 and no
  // manual reset is needed between calls.
  for (const match of html.matchAll(TAG_RE)) {
    const [full, slash, rawName, rawAttrs] = match;
    const start = match.index;
    if (start > cursor) {
      out.push(escapeTextSegment(html.slice(cursor, start)));
    }
    cursor = start + full.length;
    const name = rawName.toLowerCase();
    const isClose = slash === '/';

    if (!isClose && name === 'br') {
      out.push('\n');
      continue;
    }
    if (!TELEGRAM_HTML_TAGS.has(name)) {
      continue;
    }
    if (isClose) {
      const idx = stack.lastIndexOf(name);
      if (idx === -1) continue;
      while (stack.length > idx) {
        out.push(`</${stack.pop()}>`);
      }
      continue;
    }
    const attrs = renderSanitizedAttrs(name, rawAttrs);
    if (attrs === null) continue;
    stack.push(name);
    out.push(`<${name}${attrs}>`);
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

function matchQuotedAttr(raw: string, attr: string): string | null {
  const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = raw.match(re);
  if (!m) return null;
  return (m[2] ?? m[3] ?? '').trim();
}

/** Returns the attribute string to emit, or null to drop the tag entirely. */
function renderSanitizedAttrs(tag: string, raw: string): string | null {
  if (tag === 'a') {
    const href = matchQuotedAttr(raw, 'href');
    if (!href) return null;
    return ` href="${escapeAttrValue(href)}"`;
  }
  if (tag === 'code') {
    const cls = matchQuotedAttr(raw, 'class');
    if (cls) return ` class="${escapeAttrValue(cls)}"`;
    return '';
  }
  if (tag === 'span') {
    const cls = matchQuotedAttr(raw, 'class');
    if (cls !== 'tg-spoiler') return null;
    return ' class="tg-spoiler"';
  }
  if (tag === 'tg-emoji') {
    const id = matchQuotedAttr(raw, 'emoji-id');
    if (!id) return null;
    return ` emoji-id="${escapeAttrValue(id)}"`;
  }
  if (tag === 'blockquote') {
    if (/\bexpandable\b/i.test(raw)) return ' expandable';
    return '';
  }
  return '';
}

type SplitAtom =
  | { kind: 'text'; text: string }
  | { kind: 'open'; text: string; name: string }
  | { kind: 'close'; text: string; name: string }
  | { kind: 'void'; text: string };

const SPLIT_TOKEN_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|&(?:[a-zA-Z]+|#\d+|#x[\da-fA-F]+);/g;

function tokenizeForSplit(html: string): SplitAtom[] {
  const atoms: SplitAtom[] = [];
  let cursor = 0;
  for (const m of html.matchAll(SPLIT_TOKEN_RE)) {
    if (m.index > cursor) {
      atoms.push({ kind: 'text', text: html.slice(cursor, m.index) });
    }
    const matched = m[0];
    if (matched.startsWith('<')) {
      const name = m[1].toLowerCase();
      const isClose = matched[1] === '/';
      if (isClose) atoms.push({ kind: 'close', text: matched, name });
      else if (name === 'br') atoms.push({ kind: 'void', text: matched });
      else atoms.push({ kind: 'open', text: matched, name });
    } else {
      atoms.push({ kind: 'void', text: matched });
    }
    cursor = m.index + matched.length;
  }
  if (cursor < html.length) {
    atoms.push({ kind: 'text', text: html.slice(cursor) });
  }
  return atoms;
}

interface SplitFrame {
  name: string;
  openText: string;
}

/**
 * Splits HTML into chunks that each fit TELEGRAM_MAX_MESSAGE, closing open tags
 * at every boundary and reopening them at the start of the next chunk so no
 * chunk is independently malformed. Never splits inside a tag or entity.
 */
export function splitTelegramMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE) return [text];

  const atoms = tokenizeForSplit(text);
  const chunks: string[] = [];
  let current = '';
  let stack: SplitFrame[] = [];

  const closesFor = (frames: SplitFrame[]) =>
    frames
      .slice()
      .reverse()
      .map((f) => `</${f.name}>`)
      .join('');
  const reopensFor = (frames: SplitFrame[]) => frames.map((f) => f.openText).join('');

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current + closesFor(stack));
    current = reopensFor(stack);
  };

  const flushIfNeeded = (nextLength: number, nextStack: SplitFrame[]) => {
    const projected = current.length + nextLength + closesFor(nextStack).length;
    if (projected > TELEGRAM_MAX_MESSAGE && current.length > reopensFor(stack).length) {
      flush();
    }
  };

  for (const atom of atoms) {
    if (atom.kind === 'open') {
      const nextStack = [...stack, { name: atom.name, openText: atom.text }];
      flushIfNeeded(atom.text.length, nextStack);
      current += atom.text;
      stack = nextStack;
    } else if (atom.kind === 'close') {
      const idx = stack.map((f) => f.name).lastIndexOf(atom.name);
      if (idx === -1) continue;
      const closeStr = stack
        .slice(idx)
        .reverse()
        .map((f) => `</${f.name}>`)
        .join('');
      const nextStack = stack.slice(0, idx);
      flushIfNeeded(closeStr.length, nextStack);
      current += closeStr;
      stack = nextStack;
    } else if (atom.kind === 'void') {
      flushIfNeeded(atom.text.length, stack);
      current += atom.text;
    } else {
      let remaining = atom.text;
      while (remaining.length > 0) {
        const room = TELEGRAM_MAX_MESSAGE - closesFor(stack).length - current.length;
        if (room <= 0) {
          flush();
          continue;
        }
        if (remaining.length <= room) {
          current += remaining;
          break;
        }
        let splitAt = remaining.lastIndexOf('\n', room);
        if (splitAt < 0 || splitAt < room / 2) splitAt = room;
        current += remaining.slice(0, splitAt);
        remaining = remaining.slice(splitAt).replace(/^\n/, '');
        flush();
      }
    }
  }

  if (current.length > 0) {
    chunks.push(current + closesFor(stack));
  }

  return chunks.filter((c) => c.length > 0);
}
