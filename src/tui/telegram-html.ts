/**
 * Telegram HTML → Markdown, so the terminal can show the model's replies with
 * Pi's Markdown renderer. The system prompt asks the model for Telegram HTML
 * until replies switch to Markdown, and this converter lasts as long as that.
 *
 * Telegram shows HTML's text as it is, line breaks and all, so the Markdown
 * must too: every character Markdown would read as syntax is escaped, a line
 * starting with what would make a heading, a list item or an indented code
 * block is defused, and formatting is applied line by line, since emphasis
 * cannot span a blank line. Telegram's tags become their Markdown: bold,
 * italic and strikethrough, where Markdown would pair their markers (the text
 * shows either way); code spans and fenced blocks; links; quotes.
 * Underline and spoilers have none, and show as their text. Anything that is
 * not one of Telegram's tags is text, as Telegram would show it; an unclosed
 * tag ends with the text, and a tag still arriving while a reply streams is
 * left out until it is complete.
 */

type Node = string | { tag: string; attrs: string; children: Node[] };

/** Telegram's tags, lowercase only, as its sanitizer reads them: `Option<U>` stays text. */
const TAGS = new Set([
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
  'br',
]);

const TAG_RE = /<(\/?)([a-z][a-z-]*)((?:\s[^<>]*)?)\s*(\/?)>/g;

/** Non-breaking spaces keep an indent from reading as a code block. */
const NBSP = '\u00a0';
/** Invisible, and no whitespace: it keeps `](` from reading as a link. */
const WORD_JOINER = '\u2060';

export function telegramHtmlToMarkdown(
  html: string,
  options: { streaming?: boolean } = {},
): string {
  const source = options.streaming ? html.replace(/<\/?[a-z][^<>]*$/, '') : html;
  return blocks(parse(source)).replace(/\n+$/, '');
}

/** The tag tree. Stray closing tags are dropped; unclosed ones close at the end. */
function parse(html: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ tag: string; children: Node[] }> = [];
  const into = (): Node[] => stack.at(-1)?.children ?? root;
  let last = 0;
  for (const match of html.matchAll(TAG_RE)) {
    const [whole, closing, name = '', attrs = '', selfClosing] = match;
    if (!TAGS.has(name)) continue;
    if (match.index > last) into().push(decodeEntities(html.slice(last, match.index)));
    last = match.index + whole.length;
    if (name === 'br') {
      into().push('\n');
    } else if (closing) {
      const open = stack.map((entry) => entry.tag).lastIndexOf(name);
      if (open !== -1) stack.length = open;
    } else if (!selfClosing) {
      const element = { tag: name, attrs, children: [] as Node[] };
      into().push(element);
      stack.push(element);
    }
  }
  if (last < html.length) into().push(decodeEntities(html.slice(last)));
  return root;
}

/** Nodes that may hold quotes and code blocks: the reply itself, or a quote. */
function blocks(nodes: Node[]): string {
  let out = '';
  let pending: Node[] = [];
  /** What a block needs before the text that follows it: a line break, or a blank line after a quote. */
  let after = '';
  const flush = (): void => {
    let text = inline(pending);
    pending = [];
    if (!text) return;
    if (after) {
      text = after + text.replace(/^\n/, '');
      after = '';
    }
    out += text;
  };
  for (const node of nodes) {
    if (typeof node !== 'string' && (node.tag === 'pre' || node.tag === 'blockquote')) {
      flush();
      if (out && !out.endsWith('\n')) out += '\n';
      out += node.tag === 'pre' ? codeBlock(node) : quote(node);
      after = node.tag === 'pre' ? '\n' : '\n\n';
      continue;
    }
    pending.push(node);
  }
  flush();
  return out;
}

/**
 * Inline content: text and formatting, with its line breaks. Formatting is
 * built as markers first, and only those that Markdown will pair up are
 * written (see resolveMarks), so text never gains a stray `**`.
 */
function inline(nodes: Node[]): string {
  return defuseLineStarts(serialize(nodes.flatMap((node) => inlinePieces(node, new Set()))));
}

/** An emphasis marker, open or close, linked to its other half. */
interface Mark {
  marker: string;
  open: boolean;
  other: Mark | null;
  on: boolean;
}

/** A code span, kept apart from text: two side by side must not merge their backticks. */
interface Code {
  code: string;
}

type Piece = string | Mark | Code;

const isMark = (piece: Piece | undefined): piece is Mark =>
  typeof piece === 'object' && 'marker' in piece;

/** `within` holds the markers of the spans around this one: a span inside its own kind adds none. */
function inlinePieces(node: Node, within: ReadonlySet<string>): Piece[] {
  if (typeof node === 'string') return [escapeText(node)];
  const content = (inner = within): Piece[] =>
    node.children.flatMap((child) => inlinePieces(child, inner));
  const span = (marker: string): Piece[] =>
    within.has(marker) ? content() : wrapLines(content(new Set([...within, marker])), marker);
  switch (node.tag) {
    case 'b':
    case 'strong':
      return span('**');
    case 'i':
    case 'em':
      // Not `*`: a run like `***` where bold meets italic is one the parser reads its own way.
      return span('_');
    case 's':
    case 'strike':
    case 'del':
      return span('~~');
    case 'code':
      return textOf(node.children)
        .split('\n')
        .flatMap((line, index): Piece[] => [...(index > 0 ? ['\n'] : []), codeSpan(line)]);
    case 'a':
      return [link(serialize(content()), attribute(node.attrs, 'href'))];
    default:
      // Underline, spoilers, custom emoji, and a block nested where it cannot be: their text.
      return content();
  }
}

/** Each line wrapped on its own, whitespace outside: emphasis cannot span a line break. */
function wrapLines(pieces: Piece[], marker: string): Piece[] {
  const lines: Piece[][] = [[]];
  for (const piece of pieces) {
    if (typeof piece !== 'string') {
      lines.at(-1)?.push(piece);
      continue;
    }
    piece.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)?.push(part);
    });
  }
  return lines.flatMap((line, index) => {
    const { lead, core, trail } = trimPieces(line);
    const wrapped: Piece[] = core.length ? [lead, ...pair(marker, core), trail] : line;
    return index > 0 ? ['\n', ...wrapped] : wrapped;
  });
}

function pair(marker: string, core: Piece[]): Piece[] {
  const open: Mark = { marker, open: true, other: null, on: true };
  const close: Mark = { marker, open: false, other: open, on: true };
  open.other = close;
  return [open, ...core, close];
}

/** A line's leading and trailing whitespace, split from what is between. */
function trimPieces(line: Piece[]): { lead: string; core: Piece[]; trail: string } {
  const core = [...line];
  let lead = '';
  let trail = '';
  while (typeof core[0] === 'string') {
    const text = core[0];
    const rest = text.replace(/^\s+/, '');
    lead += text.slice(0, text.length - rest.length);
    if (rest) {
      core[0] = rest;
      break;
    }
    core.shift();
  }
  while (typeof core.at(-1) === 'string') {
    const text = core.at(-1) as string;
    const rest = text.replace(/\s+$/, '');
    trail = text.slice(rest.length) + trail;
    if (rest) {
      core[core.length - 1] = rest;
      break;
    }
    core.pop();
  }
  return { lead, core, trail };
}

/** The pieces as Markdown, with only the markers Markdown will pair. */
function serialize(pieces: Piece[]): string {
  resolveMarks(pieces);
  let out = '';
  let lastWasCode = false;
  for (const piece of pieces) {
    if (typeof piece === 'string') {
      out += piece;
      if (piece) lastWasCode = false;
    } else if (isMark(piece)) {
      if (piece.on) {
        out += piece.marker;
        lastWasCode = false;
      }
    } else {
      out += `${lastWasCode ? WORD_JOINER : ''}${piece.code}`;
      lastWasCode = piece.code !== '';
    }
  }
  return out;
}

/**
 * Turns off each pair of markers Markdown would not read as emphasis, and the
 * two halves where one span ends right as another like it begins (the two
 * read as one). CommonMark pairs `**` only when the opening one is left-
 * flanking and the closing one right-flanking: `**Note:**text` does not close,
 * since a closing marker after punctuation must be followed by whitespace or
 * punctuation; and `_` never inside a word. Such text is shown without its formatting rather than with
 * the markers. Repeated until nothing changes, since turning one pair off
 * changes what its neighbours touch.
 */
function resolveMarks(pieces: Piece[]): void {
  const neighbour = (index: number, step: 1 | -1, unit = false): string | undefined => {
    for (let at = index + step; at >= 0 && at < pieces.length; at += step) {
      const piece = pieces[at];
      if (piece === undefined) return undefined;
      if (isMark(piece)) {
        if (piece.on) return piece.marker[0];
        continue;
      }
      const text = typeof piece === 'string' ? piece : piece.code;
      if (text) return unit ? text.at(-1) : edge(text, step === 1 ? 'start' : 'end');
    }
    return undefined;
  };
  let changed = true;
  while (changed) {
    changed = false;
    pieces.forEach((piece, index) => {
      if (!isMark(piece) || !piece.on) return;
      const next = nextShown(pieces, index);
      if (!piece.open && next?.open && next.marker === piece.marker) {
        // Two spans of one kind back to back, `**a****b**`, are written as one.
        piece.on = false;
        next.on = false;
        const [first, last] = [piece.other, next.other];
        if (first) first.other = last;
        if (last) last.other = first;
        changed = true;
        return;
      }
      // Before an opening marker marked looks at one UTF-16 unit, half of an emoji: so do we.
      const before = neighbour(index, -1, piece.open);
      const after = neighbour(index, 1);
      const pairs = piece.open
        ? canOpen(piece.marker, before, after) && !cutShort(pieces, piece)
        : canClose(piece.marker, before, after);
      if (pairs) return;
      piece.on = false;
      if (piece.other) piece.other.on = false;
      changed = true;
    });
  }
}

/**
 * The character at one end of some Markdown, as marked sees it when it pairs
 * markers: it reads an escaped character, whatever it is, as punctuation.
 * Every backslash in the text is an escape's, so an odd run of them before the
 * last character makes it one.
 */
function edge(text: string, end: 'start' | 'end'): string | undefined {
  // Whole code points: an emoji is one character, and a symbol.
  const chars = [...text];
  if (end === 'start') return chars[0] === '\\' ? '+' : chars[0];
  let backslashes = 0;
  for (let at = chars.length - 2; at >= 0 && chars[at] === '\\'; at--) backslashes++;
  return backslashes % 2 === 1 ? '+' : chars.at(-1);
}

/**
 * Pi's renderer ends a strikethrough at the first `~~` after it, even one
 * inside a code span, which would cut the span in two.
 */
function cutShort(pieces: Piece[], open: Mark): boolean {
  if (open.marker !== '~~' || !open.other) return false;
  const from = pieces.indexOf(open);
  const to = pieces.indexOf(open.other);
  return pieces
    .slice(from + 1, to)
    .some((piece) => typeof piece === 'object' && 'code' in piece && piece.code.includes('~~'));
}

/** The marker written right after pieces[index], with no text between; null when text comes first. */
function nextShown(pieces: Piece[], index: number): Mark | null {
  for (const piece of pieces.slice(index + 1)) {
    if (isMark(piece)) {
      if (piece.on) return piece;
    } else if ((typeof piece === 'string' ? piece : piece.code) !== '') {
      return null;
    }
  }
  return null;
}

const isWhitespace = (char: string | undefined): boolean => char === undefined || /\s/.test(char);
/** As marked reads it for emphasis in GFM, where a tilde is not punctuation. */
const isPunctuation = (char: string | undefined): boolean =>
  char !== undefined && char !== '~' && /[\p{P}\p{S}]/u.test(char);

/**
 * Whether a marker opens, as the parser reads it. Emphasis follows CommonMark
 * (with `_` also never inside a word); a strikethrough, Pi's own rule: its
 * text may not start or end with whitespace or a tilde.
 */
function canOpen(marker: string, before: string | undefined, after: string | undefined): boolean {
  if (marker === '~~') return !isWhitespace(after) && after !== '~';
  if (!leftFlanking(before, after)) return false;
  return marker !== '_' || !rightFlanking(before, after) || isPunctuation(before);
}

function canClose(marker: string, before: string | undefined, after: string | undefined): boolean {
  if (marker === '~~')
    return !isWhitespace(before) && before !== '~' && before !== '\\' && after !== '~';
  if (!rightFlanking(before, after)) return false;
  return marker !== '_' || !leftFlanking(before, after) || isPunctuation(after);
}

function leftFlanking(before: string | undefined, after: string | undefined): boolean {
  return (
    !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before))
  );
}

function rightFlanking(before: string | undefined, after: string | undefined): boolean {
  return (
    !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after))
  );
}

/**
 * A code span. At the start of a block Pi's renderer would read `\\[` or `$$`
 * in it as the start of a formula, so a word joiner goes between.
 */
function codeSpan(raw: string): Piece {
  if (!raw) return '';
  const text = raw.replace(/\\(?=\[)|\$(?=\$)/g, `$&${WORD_JOINER}`);
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  // Three backticks at a line's start would open a code block instead.
  if (longestRun >= 2) return escapeText(text);
  const fence = '`'.repeat(longestRun + 1);
  const padded = /^[` ]|[` ]$/.test(text) ? ` ${text} ` : text;
  return { code: `${fence}${padded}${fence}` };
}

/** A link, or its text and address in plain words when its text has brackets of its own. */
function link(text: string, href: string | null): string {
  const label = text.replace(/\n/g, ' ');
  if (!href || !label.trim()) return label;
  if (/[[\]]/.test(label)) return `${label} (${escapeText(href)})`;
  return `[${label}](<${href.replace(/[<>\s]/g, encodeURIComponent)}>)`;
}

function codeBlock(pre: Extract<Node, object>): string {
  const code = pre.children.find(
    (child): child is Extract<Node, object> => typeof child !== 'string' && child.tag === 'code',
  );
  const language = /language-([\w+#.-]+)/.exec(code?.attrs ?? '')?.[1] ?? '';
  const text = textOf(pre.children).replace(/\n$/, '');
  const longestRun = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

function quote(node: Extract<Node, object>): string {
  const body = blocks(node.children).replace(/^\n+|\n+$/g, '');
  return body
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** The raw text of some nodes, tags and all dropped: what a code block shows. */
function textOf(nodes: Node[]): string {
  return nodes.map((node) => (typeof node === 'string' ? node : textOf(node.children))).join('');
}

/**
 * The characters Markdown reads as syntax wherever they are, escaped: `$` too,
 * which Pi's renderer reads as a formula. Those that matter only at a line's
 * start are left to defuseLineStarts, since every needless escape is one more
 * punctuation mark that can keep emphasis around it from pairing up.
 *
 * Brackets cannot be escaped: Pi's renderer reads `\[…\]` and `\(…\)` as
 * formulas too. They only make a link as `](`, which an invisible word joiner
 * breaks, or a link definition at a line's start, below.
 */
function escapeText(text: string): string {
  return (
    text
      .replace(/[\\`*_<>|~&$]/g, '\\$&')
      .replace(/\](?=\()/g, `]${WORD_JOINER}`)
      // An escaped backslash before `[` or `(` still starts a formula at a block's start.
      .replace(/\\\\(?=[[(])/g, `\\\\${WORD_JOINER}`)
  );
}

/**
 * What would make a line more than text: an indent, which after a blank line
 * is a code block, keeps its width as non-breaking spaces; a leading `#`,
 * `-`, `+` or `=` (a heading, a list item, a rule, an underline for the line
 * above) and the `.` or `)` of a leading number (a numbered item) are escaped;
 * and a `[label]:`, which would vanish as a link definition, gets a word joiner.
 */
function defuseLineStarts(text: string): string {
  return text
    .replace(/^[ \t]+/gm, (indent) => indent.replace(/\t/g, '    ').replace(/ /g, NBSP))
    .replace(/^[#+=-]/gm, '\\$&')
    .replace(/^(\d+)([.)])/gm, '$1\\$2')
    .replace(/^(?=\[[^\]\n]*\]:)/gm, WORD_JOINER);
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`).exec(attrs);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? null : decodeEntities(value);
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: NBSP,
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}
