import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { markdownToTelegramHtml } from '../src/channels/telegram/markdown.ts';
import { splitTelegramMessage } from '../src/channels/telegram/telegram-html.ts';
import { TELEGRAM_MAX_MESSAGE } from '../src/config.ts';
import { escapeMarkdown, markdownCode, markdownCodeBlock } from '../src/markdown.ts';

/**
 * The Markdown → Telegram HTML converter. Invariants first — only Telegram's
 * tags, balanced, content kept, and every chunk sendable after splitting —
 * then a few exact renderings for the shapes the bot writes.
 */

const TAG_RE = /<(\/?)([a-z-]+)((?:\s+[\w-]+="[^"]*")*)\s*>/g;
const ALLOWED = new Set(['b', 'i', 's', 'code', 'pre', 'a', 'blockquote']);

function tagsOf(html: string): Array<{ close: boolean; name: string }> {
  return [...html.matchAll(TAG_RE)].map(([, slash, name]) => ({ close: slash === '/', name }));
}

function isBalanced(html: string): boolean {
  const stack: string[] = [];
  for (const { close, name } of tagsOf(html)) {
    if (!close) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
}

/** Visible text: tags dropped and the three entities decoded. */
function textOf(html: string): string {
  return html
    .replace(TAG_RE, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

const SAMPLES: Record<string, string> = {
  status: [
    '📊 **Pi Bot · Status**',
    '',
    '💬 **Chat** · 🟢 idle',
    '> 🤖 `openai-codex/gpt-6-luna`',
    '> 💡 Reasoning **high**',
    '',
    '💰 **Session usage**',
    '```',
    'Input   12k',
    'Cached  8k (66%)',
    '```',
  ].join('\n'),
  document: [
    '# Plan',
    '',
    'Some *emphasis*, **bold**, ~~gone~~ and `code <T>`.',
    '',
    '- first',
    '- second with [a link](https://example.com/?a=1&b=2)',
    '  - nested',
    '',
    '1. one',
    '2. two',
    '',
    '| Name | Value |',
    '|------|-------|',
    '| a    | 1 & 2 |',
    '',
    '```ts',
    'const x: Array<number> = [];',
    '```',
    '',
    '> quoted',
    '> > nested quote',
    '',
    '---',
    'after <b>raw html</b> & more',
  ].join('\n'),
  escaped: escapeMarkdown('*not bold* _not italic_ `not code` <not a tag> [x](y) # no heading'),
  unclosed: '**bold never closed and `code never closed\n\n- list\n> quote',
  long: Array.from({ length: 400 }, (_, i) => `- item **${i}** with \`code ${i}\` and text`).join(
    '\n',
  ),
};

describe('markdownToTelegramHtml invariants', () => {
  for (const [name, markdown] of Object.entries(SAMPLES)) {
    const html = markdownToTelegramHtml(markdown);

    test(`${name}: only Telegram's tags`, () => {
      for (const { name: tag } of tagsOf(html)) assert.ok(ALLOWED.has(tag), `unexpected <${tag}>`);
    });

    test(`${name}: tags are balanced`, () => {
      assert.ok(isBalanced(html), html.slice(0, 200));
    });

    test(`${name}: every word of the source is still shown`, () => {
      // A link's address and a code block's language are in the tag, but still there.
      const attributes = [...html.matchAll(/="([^"]*)"/g)].map(([, value]) => value);
      const shown = textOf([html, ...attributes].join(' '));
      const words = markdown.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
      for (const word of words) assert.ok(shown.includes(word), `lost "${word}"`);
    });

    test(`${name}: every chunk fits and is balanced after splitting`, () => {
      for (const chunk of splitTelegramMessage(html)) {
        assert.ok(chunk.length <= TELEGRAM_MAX_MESSAGE);
        assert.ok(isBalanced(chunk));
      }
    });
  }
});

describe('markdownToTelegramHtml renderings', () => {
  test('inline markup maps to Telegram tags, and text is escaped', () => {
    assert.equal(
      markdownToTelegramHtml('**b** *i* ~~s~~ `a < b` [l](https://x.y/?a=1&b=2) 1 < 2 & 3'),
      '<b>b</b> <i>i</i> <s>s</s> <code>a &lt; b</code> <a href="https://x.y/?a=1&amp;b=2">l</a> 1 &lt; 2 &amp; 3',
    );
  });

  test('line breaks and blank lines are kept as written', () => {
    assert.equal(markdownToTelegramHtml('one\ntwo\n\nthree'), 'one\ntwo\n\nthree');
  });

  test('a quote right under a line stays right under it', () => {
    assert.equal(
      markdownToTelegramHtml('**Chat** · idle\n> model\n> queue 0\n\nnext'),
      '<b>Chat</b> · idle\n<blockquote>model\nqueue 0</blockquote>\n\nnext',
    );
  });

  test('headings are bold, lists are bullet lines, rules are a line', () => {
    assert.equal(
      markdownToTelegramHtml('## Title\n\n- a\n- b\n  - c\n\n3. x\n4. y\n\n---'),
      '<b>Title</b>\n\n• a\n• b\n  • c\n\n3. x\n4. y\n\n──────────',
    );
  });

  test('task lists show their boxes', () => {
    assert.equal(markdownToTelegramHtml('- [x] done\n- [ ] todo'), '• ☑ done\n• ☐ todo');
  });

  test('code blocks keep their language and escape their body', () => {
    assert.equal(
      markdownToTelegramHtml('```ts\nlet a: Array<T> = [];\n```'),
      '<pre><code class="language-ts">let a: Array&lt;T&gt; = [];</code></pre>',
    );
    assert.equal(
      markdownToTelegramHtml('```\nplain & simple\n```'),
      '<pre>plain &amp; simple</pre>',
    );
  });

  test('tables become aligned monospaced columns', () => {
    assert.equal(
      markdownToTelegramHtml('| a | long |\n|---|---|\n| **xx** | 1 |'),
      '<pre>a   long\n──  ────\nxx  1</pre>',
    );
  });

  test('a nested quote shows as its content; Telegram cannot nest quotes', () => {
    assert.equal(markdownToTelegramHtml('> a\n> > b'), '<blockquote>a\nb</blockquote>');
  });

  test('raw HTML and links to other schemes are shown as text', () => {
    assert.equal(markdownToTelegramHtml('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
    assert.equal(markdownToTelegramHtml('[run](javascript:alert(1))'), 'run');
  });
});

describe('Markdown helpers', () => {
  test('escaped text shows exactly as written', () => {
    const text = '*a* _b_ `c` <d> [e](f) # g | h ~i~ 1. j & k\\l';
    assert.equal(textOf(markdownToTelegramHtml(escapeMarkdown(text))), text);
  });

  test('a code span holds backticks and edge spaces', () => {
    for (const text of ['a`b', '`edge', 'double `` run', ' spaced ']) {
      assert.equal(markdownToTelegramHtml(markdownCode(text)), `<code>${text}</code>`);
    }
  });

  test('a code block cannot be closed early by a fence inside it', () => {
    const body = 'before\n```\ninside\n```\nafter';
    assert.equal(markdownToTelegramHtml(markdownCodeBlock(body)), `<pre>${body}</pre>`);
  });
});
