import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Markdown, type MarkdownTheme, stripTerminalSequences } from '@earendil-works/pi-tui';
import { telegramHtmlToMarkdown } from '../src/tui/telegram-html.ts';

/**
 * The terminal shows the model's Telegram HTML through Pi's Markdown renderer,
 * so the converter's job is that the terminal shows what Telegram would: the
 * same text, line for line, with the formatting Markdown can carry. Checked by
 * invariant, rendering through the terminal's own renderer: every character
 * Telegram shows is shown, nothing Markdown would read as syntax leaks in or
 * goes missing, over hand-picked cases and seeded random ones.
 */

const identity = (text: string): string => text;
/** Styles as plain brackets, so a test can see which text was formatted how. */
const THEME: MarkdownTheme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: (text) => `⟦${text}⟧`,
  italic: (text) => `⟨${text}⟩`,
  strikethrough: (text) => `⟪${text}⟫`,
  underline: identity,
};

function render(markdown: string): string {
  return new Markdown(markdown, 0, 0, THEME)
    .render(200)
    .map((line) =>
      stripTerminalSequences(line)
        .replace(/\u00a0/g, ' ')
        .replace(/\s+$/, ''),
    )
    .join('\n');
}

/** What Telegram shows of some HTML, whitespace aside: its text, entities decoded. */
function telegramText(html: string): string {
  return html
    .replace(/<\/?(?:pre|blockquote)(?:\s[^<>]*)?>/g, '\n')
    .replace(
      /<\/?(?:b|strong|i|em|u|ins|s|strike|del|a|code|pre|blockquote|tg-spoiler|tg-emoji|span)(?:\s[^<>]*)?>/g,
      '',
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** The terminal's text with the renderer's own decoration (quote bars, code fences, style brackets) taken out. */
function shownText(rendered: string): string {
  return rendered
    .split('\n')
    .filter((line) => !/^\s*```/.test(line))
    .map((line) => line.replace(/^(\s*│ ?)+/, ''))
    .join('\n')
    .replace(/[⟦⟧⟨⟩⟪⟫\u2060]/g, '');
}

const squash = (text: string): string => text.replace(/[\s ]+/g, ' ').trim();

function assertSameText(html: string): void {
  const markdown = telegramHtmlToMarkdown(html);
  assert.equal(
    squash(shownText(render(markdown))),
    squash(telegramText(html)),
    `html: ${JSON.stringify(html)}\nmarkdown: ${JSON.stringify(markdown)}`,
  );
}

describe('exact conversions', () => {
  const cases: Array<[string, string, string]> = [
    ['bold, italic and strikethrough', '<b>a</b> <i>b</i> <s>c</s>', '⟦a⟧ ⟨b⟩ ⟪c⟫'],
    ['lines keep their breaks', 'one\ntwo\n\nthree', 'one\ntwo\n\nthree'],
    ['formatting across a blank line', '<b>one\n\ntwo</b>', '⟦one⟧\n\n⟦two⟧'],
    ['whitespace stays outside the markers', 'x<b> spaced </b>y', 'x ⟦spaced⟧ y'],
    [
      'a heading, list or quote is only text',
      '# h\n- d\n1. n\n> q\n+ p',
      '# h\n- d\n1. n\n> q\n+ p',
    ],
    ['an indent is kept but is no code block', 'x\n\n    code?', 'x\n\n    code?'],
    [
      'Markdown syntax in text is text',
      'a*b*c _d_ `e` [f](g) ![h](i) ~~j~~ $k$ \\(l\\) <m>',
      'a*b*c _d_ `e` [f]\u2060(g) ![h]\u2060(i) ~~j~~ $k$ \\\u2060(l\\) <m>',
    ],
    ['a link definition is only text', '[x]: https://y', '\u2060[x]: https://y'],
    ['entities are decoded once', '&lt;b&gt; &amp;amp; &#128512; &#x41;', '<b> &amp; 😀 A'],
    ['uppercase tags are text, as in Telegram', 'Option<U> and Vec<T>', 'Option<U> and Vec<T>'],
    ['underline and spoilers show as their text', '<u>u</u> <tg-spoiler>s</tg-spoiler>', 'u s'],
    ['a closing marker after punctuation still closes', '<b>Note:</b>text', 'Note:text'],
    ['back to back spans read as one', '<b>a</b><b>b</b>', '⟦ab⟧'],
    ['an unclosed tag ends with the text', '<b>open to the end', '⟦open to the end⟧'],
    ['a stray closing tag is dropped', 'a</b>b', 'ab'],
  ];
  for (const [name, html, shown] of cases) {
    test(name, () => assert.equal(render(telegramHtmlToMarkdown(html)), shown));
  }

  test('a code block keeps its language and its text exactly', () => {
    const markdown = telegramHtmlToMarkdown(
      'before<pre><code class="language-ts">const a = `x` * 2;\n  if (a &lt; 3) {}</code></pre>after',
    );
    assert.equal(markdown, 'before\n```ts\nconst a = `x` * 2;\n  if (a < 3) {}\n```\nafter');
  });

  test('a code block fence outgrows the backticks inside it', () => {
    assert.equal(telegramHtmlToMarkdown('<pre>```\nx</pre>'), '````\n```\nx\n````');
  });

  test('italic inside a word stays text, since Markdown cannot say it', () => {
    assert.equal(render(telegramHtmlToMarkdown('a<i>b</i>c <i>d</i>')), 'abc ⟨d⟩');
  });

  test('a quote is quoted line by line and set apart from what follows', () => {
    assert.equal(
      telegramHtmlToMarkdown('<blockquote>one <b>two</b>\n\nthree</blockquote>next'),
      '> one **two**\n>\n> three\n\nnext',
    );
  });

  test('a link keeps its address, even one with parentheses', () => {
    assert.equal(
      telegramHtmlToMarkdown('<a href="https://x.dev/a_(b)?q=1&amp;r=2">see</a>'),
      '[see](<https://x.dev/a_(b)?q=1&r=2>)',
    );
  });

  test('while streaming, a tag still arriving is left out', () => {
    assert.equal(telegramHtmlToMarkdown('done <b>bo', { streaming: true }), 'done **bo**');
    assert.equal(telegramHtmlToMarkdown('done <b', { streaming: true }), 'done ');
    assert.equal(telegramHtmlToMarkdown('a < b', { streaming: true }), 'a \\< b');
  });
});

describe('invariants', () => {
  const HAND_PICKED = [
    '<b>Summary</b>\n\n1. first\n2) second\n- dash\n* star\n# hash\n=== \n---\n***',
    'Costs $5 and $10, a_b_c, *stars*, x < y & z > w, a\\b, <b>|table|</b>',
    '<b>(1)</b>x <i>"q"</i>y z<b>!</b>w <s>~</s>~',
    '<b><i>both</i></b> <b>a</b><i>b</i> <i>a</i><b>b</b>',
    '<blockquote>q <b>b</b>\n<code>c</code></blockquote>\n<pre>p\n  q</pre>tail',
    '  lead\n\ttab\n\n     five',
    '<code>`tick`</code> <code>``double``</code> <code> padded </code>',
    'line with trailing spaces  \nnext',
  ];
  for (const html of HAND_PICKED) {
    test(`shows the text Telegram shows: ${JSON.stringify(html).slice(0, 60)}`, () => {
      assertSameText(html);
    });
  }

  const TEXTS = [
    '[',
    '](',
    '[x]: y',
    '\\(',
    '\\[',
    'a',
    'word',
    'two words',
    '1.',
    '2)',
    '# x',
    '- y',
    '+ z',
    '> q',
    '=',
    '---',
    '***',
    '*',
    '_',
    '__',
    '`',
    '~',
    '~~',
    '$',
    '|',
    '\\',
    '&amp;',
    '&lt;',
    '&gt;',
    '(',
    ')',
    '[',
    ']',
    '!',
    ':',
    '.',
    ',',
    '"',
    "'",
    '  ',
    '\n',
    '\n\n',
    '    x',
    'é',
    '😀',
  ];
  const INLINE = ['b', 'i', 's', 'u', 'code', 'tg-spoiler'];

  /** A small deterministic generator, so a failure names a case that can be rerun. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
      return state / 2 ** 31;
    };
  }

  /** Random HTML of the kind Telegram accepts: quotes and code blocks only outside inline tags. */
  function generate(next: () => number, depth: number, blocks = true): string {
    const count = 1 + Math.floor(next() * 4);
    let out = '';
    const text = (): string => TEXTS[Math.floor(next() * TEXTS.length)] ?? 'x';
    for (let i = 0; i < count; i++) {
      const roll = next();
      if (depth > 0 && roll < 0.35) {
        const tag = INLINE[Math.floor(next() * INLINE.length)] ?? 'b';
        const inner = tag === 'code' ? text() : generate(next, depth - 1, false);
        out += `<${tag}>${inner}</${tag}>`;
      } else if (blocks && depth > 1 && roll < 0.42) {
        out += `<blockquote>${generate(next, 1, false)}</blockquote>`;
      } else if (blocks && depth > 1 && roll < 0.47) {
        out += `<pre>${text()}</pre>`;
      } else {
        out += text();
      }
    }
    return out;
  }

  test('random HTML shows the text Telegram shows', () => {
    for (let seed = 1; seed <= 1_000; seed++) {
      assertSameText(generate(random(seed), 3));
    }
  });
});
