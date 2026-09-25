import { Lexer, type Token, type Tokens } from 'marked';
import { escapeTelegramHtml } from './telegram-html.ts';

/**
 * Markdown to Telegram HTML, for text the core hands over as Markdown.
 *
 * Telegram's HTML parse mode has no headings, lists or tables, so those become
 * what a chat can show: a heading is bold, a list item a bullet line, a table
 * a monospaced block. Code, links, quotes and emphasis map to Telegram's own
 * tags. Everything else is escaped text, never passed through, so the output
 * only ever holds tags Telegram accepts; the send path still splits it and
 * falls back on the rare rejection.
 *
 * Line breaks are kept as written (a single newline is a line break, as in a
 * chat), and blocks are separated the way the source separates them: a blank
 * line stays a blank line, and a quote right under a line stays right under it.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const tokens = new Lexer({ gfm: true, breaks: true }).lex(markdown);
  return renderBlocks(tokens, { inQuote: false, indent: '' }).replace(/\s+$/, '');
}

interface BlockContext {
  /** Telegram cannot nest quotes, so a quote inside one is shown as its content. */
  inQuote: boolean;
  /** Prefix for the lines of a nested list. */
  indent: string;
}

const LINK_SCHEMES = /^(https?:|tg:|mailto:)/i;
const RULE = '──────────';

function renderBlocks(tokens: Token[], context: BlockContext): string {
  // A blank line in the source is a `space` token, which renders empty: joined
  // with newlines, it becomes the blank line again.
  return tokens.map((token) => renderBlock(token, context)).join('\n');
}

function renderBlock(token: Token, context: BlockContext): string {
  switch (token.type) {
    case 'space':
    case 'def':
      return '';
    case 'paragraph':
      return renderInline((token as Tokens.Paragraph).tokens);
    case 'text': {
      const text = token as Tokens.Text;
      return text.tokens ? renderInline(text.tokens) : escapeTelegramHtml(text.text);
    }
    case 'heading':
      return `<b>${renderInline((token as Tokens.Heading).tokens)}</b>`;
    case 'code':
      return renderCode(token as Tokens.Code);
    case 'blockquote': {
      const inner = renderBlocks((token as Tokens.Blockquote).tokens, {
        ...context,
        inQuote: true,
      });
      return context.inQuote ? inner : `<blockquote>${inner}</blockquote>`;
    }
    case 'list':
      return renderList(token as Tokens.List, context);
    case 'table':
      return renderTable(token as Tokens.Table);
    case 'hr':
      return RULE;
    default:
      // Raw HTML and anything unrecognised is shown as the text it was written as.
      return escapeTelegramHtml(token.raw.replace(/\n+$/, ''));
  }
}

function renderCode(token: Tokens.Code): string {
  const body = escapeTelegramHtml(token.text);
  const language = token.lang
    ?.trim()
    .split(/\s+/)[0]
    ?.replace(/[^\w+#.-]/g, '');
  return language
    ? `<pre><code class="language-${language}">${body}</code></pre>`
    : `<pre>${body}</pre>`;
}

function renderList(token: Tokens.List, context: BlockContext): string {
  const start = typeof token.start === 'number' ? token.start : 1;
  const nested: BlockContext = { ...context, indent: `${context.indent}  ` };
  return token.items
    .map((item, index) => {
      const marker = token.ordered ? `${start + index}. ` : '• ';
      const box = item.task ? (item.checked ? '☑ ' : '☐ ') : '';
      const body = item.tokens
        .filter((child) => child.type !== 'checkbox')
        .map((child) =>
          child.type === 'list'
            ? renderList(child as Tokens.List, nested)
            : renderBlock(child, context),
        )
        .filter((part) => part !== '')
        .join('\n');
      return `${context.indent}${marker}${box}${body}`;
    })
    .join('\n');
}

/** A table as aligned columns of plain text in a monospaced block. */
function renderTable(token: Tokens.Table): string {
  const rows = [token.header, ...token.rows].map((row) =>
    row.map((cell) => plainText(cell.tokens)),
  );
  const widths = token.header.map((_, column) =>
    Math.max(...rows.map((row) => [...(row[column] ?? '')].length)),
  );
  const line = (row: string[]): string =>
    row
      .map((cell, column) => cell + ' '.repeat((widths[column] ?? 0) - [...cell].length))
      .join('  ')
      .trimEnd();
  const [header, ...body] = rows;
  const separator = widths.map((width) => '─'.repeat(width)).join('  ');
  return `<pre>${escapeTelegramHtml([line(header ?? []), separator, ...body.map(line)].join('\n'))}</pre>`;
}

function renderInline(tokens: Token[]): string {
  return tokens.map(renderInlineToken).join('');
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case 'text': {
      const text = token as Tokens.Text;
      return text.tokens ? renderInline(text.tokens) : escapeTelegramHtml(text.text);
    }
    case 'escape':
      return escapeTelegramHtml((token as Tokens.Escape).text);
    case 'strong':
      return `<b>${renderInline((token as Tokens.Strong).tokens)}</b>`;
    case 'em':
      return `<i>${renderInline((token as Tokens.Em).tokens)}</i>`;
    case 'del':
      return `<s>${renderInline((token as Tokens.Del).tokens)}</s>`;
    case 'codespan':
      return `<code>${escapeTelegramHtml((token as Tokens.Codespan).text)}</code>`;
    case 'br':
      return '\n';
    case 'link': {
      const link = token as Tokens.Link;
      const text = renderInline(link.tokens);
      return LINK_SCHEMES.test(link.href)
        ? `<a href="${escapeAttribute(link.href)}">${text}</a>`
        : text;
    }
    case 'image': {
      const image = token as Tokens.Image;
      const alt = escapeTelegramHtml(image.text || image.href);
      return LINK_SCHEMES.test(image.href)
        ? `<a href="${escapeAttribute(image.href)}">${alt}</a>`
        : alt;
    }
    default:
      return escapeTelegramHtml(token.raw);
  }
}

/** The text of inline tokens with their markup dropped, for a table cell. */
function plainText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if ('tokens' in token && Array.isArray(token.tokens)) return plainText(token.tokens);
      if (token.type === 'br') return ' ';
      return 'text' in token && typeof token.text === 'string' ? token.text : token.raw;
    })
    .join('');
}

function escapeAttribute(value: string): string {
  return escapeTelegramHtml(value).replace(/"/g, '&quot;');
}
