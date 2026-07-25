import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TELEGRAM_MAX_MESSAGE } from '../src/config.ts';
import {
  escapeTelegramHtml,
  sanitizeTelegramHtml,
  splitTelegramMessage,
} from '../src/telegram-html.ts';

/**
 * Tests for the Telegram HTML machinery. These are the functions that decide
 * whether a send succeeds: Telegram rejects an entire message on malformed
 * markup, and a regression here is silent (mangled or dropped chat messages).
 *
 * They live outside src/ because scripts/smoke.ts imports every .ts file in
 * src/ and would otherwise execute them during the smoke check.
 */

/** Text content with all tags removed, for checking split() loses no content. */
function textContentOf(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/** True when every open tag in `html` is closed, in order, with no stray closes. */
function isBalanced(html: string): boolean {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g)) {
    const [, slash, name] = match;
    const lower = name.toLowerCase();
    if (lower === 'br') continue;
    if (slash === '/') {
      if (stack.pop() !== lower) return false;
    } else {
      stack.push(lower);
    }
  }
  return stack.length === 0;
}

describe('escapeTelegramHtml', () => {
  test('escapes the three characters Telegram parses', () => {
    assert.equal(escapeTelegramHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  });

  test('escapes ampersands before angle brackets, so no output is half-escaped', () => {
    // If < were escaped first, the & it introduces would be escaped again.
    assert.equal(escapeTelegramHtml('<b>'), '&lt;b&gt;');
  });

  test('double-escapes existing entities, since full escaping means literal text', () => {
    assert.equal(escapeTelegramHtml('&amp;'), '&amp;amp;');
  });

  test('leaves quotes and other characters alone', () => {
    assert.equal(escapeTelegramHtml(`he said "hi" — it's 5`), `he said "hi" — it's 5`);
  });

  test('returns empty string unchanged', () => {
    assert.equal(escapeTelegramHtml(''), '');
  });
});

describe('sanitizeTelegramHtml', () => {
  test('preserves whitelisted formatting tags', () => {
    const html = '<b>bold</b> <i>italic</i> <u>under</u> <s>strike</s> <code>code</code>';
    assert.equal(sanitizeTelegramHtml(html), html);
  });

  test('drops non-whitelisted tags but keeps their text', () => {
    assert.equal(sanitizeTelegramHtml('<div>hello <em>there</em></div>'), 'hello <em>there</em>');
  });

  test('drops script tags while keeping the inert text, so nothing is sent as markup', () => {
    assert.equal(sanitizeTelegramHtml('<script>alert(1)</script>'), 'alert(1)');
  });

  test('converts <br> and <br/> to newlines', () => {
    assert.equal(sanitizeTelegramHtml('a<br>b<br/>c'), 'a\nb\nc');
  });

  test('drops </br>, which is not a real close tag', () => {
    assert.equal(sanitizeTelegramHtml('a</br>b'), 'ab');
  });

  test('closes tags left open at the end of input', () => {
    assert.equal(sanitizeTelegramHtml('<b>unterminated'), '<b>unterminated</b>');
  });

  test('drops a close tag with no matching open', () => {
    assert.equal(sanitizeTelegramHtml('hello</b>'), 'hello');
  });

  test('closes inner tags when an outer tag closes first', () => {
    // The </i> that follows has nothing left to close and is dropped.
    assert.equal(
      sanitizeTelegramHtml('<b>bold <i>both</b> italic</i>'),
      '<b>bold <i>both</i></b> italic',
    );
  });

  test('lowercases tag names', () => {
    assert.equal(sanitizeTelegramHtml('<B>x</B>'), '<b>x</b>');
  });

  test('output is always balanced for adversarial input', () => {
    for (const html of [
      '<b><i><code>deeply nested',
      '</b></i>',
      '<b>a</i>b</b>',
      '<pre><code>x</pre></code>',
      '<b>',
      '<b></b></b><i>',
    ]) {
      assert.ok(isBalanced(sanitizeTelegramHtml(html)), `not balanced for: ${html}`);
    }
  });

  test('repeated calls return identical output', () => {
    // The tag regexes are module-level and carry /g, so any future refactor that
    // exits the scan early (a break, a return) would leave lastIndex mid-string
    // and corrupt the next call. Today's loops run to completion, so this only
    // guards against that change.
    const html = '<b>a</b> <div>x</div> 5 < 6';
    const first = sanitizeTelegramHtml(html);
    assert.equal(sanitizeTelegramHtml(html), first);
    assert.equal(sanitizeTelegramHtml(html), first);
  });

  describe('text escaping', () => {
    test('escapes bare angle brackets and ampersands in text', () => {
      assert.equal(sanitizeTelegramHtml('5 < 10 & 3 > 1'), '5 &lt; 10 &amp; 3 &gt; 1');
    });

    test('preserves entities Telegram already understands', () => {
      const html = '&amp; &lt; &gt; &quot; &#65; &#x41;';
      assert.equal(sanitizeTelegramHtml(html), html);
    });

    test('escapes unknown entities so Telegram does not reject the message', () => {
      assert.equal(sanitizeTelegramHtml('&nbsp;'), '&amp;nbsp;');
    });
  });

  describe('attributes', () => {
    test('keeps href on <a> and drops every other attribute', () => {
      assert.equal(
        sanitizeTelegramHtml('<a href="https://x.test" onclick="evil()">link</a>'),
        '<a href="https://x.test">link</a>',
      );
    });

    test('drops <a> without href, keeping the link text', () => {
      assert.equal(sanitizeTelegramHtml('<a>link</a>'), 'link');
    });

    test('accepts single-quoted attribute values', () => {
      assert.equal(
        sanitizeTelegramHtml("<a href='https://x.test'>link</a>"),
        '<a href="https://x.test">link</a>',
      );
    });

    test('escapes ampersands inside href', () => {
      assert.equal(
        sanitizeTelegramHtml('<a href="https://x.test/?a=1&b=2">q</a>'),
        '<a href="https://x.test/?a=1&amp;b=2">q</a>',
      );
    });

    test('keeps the language class on <code>', () => {
      assert.equal(
        sanitizeTelegramHtml('<code class="language-python">x</code>'),
        '<code class="language-python">x</code>',
      );
    });

    test('keeps <span> only as a spoiler', () => {
      assert.equal(
        sanitizeTelegramHtml('<span class="tg-spoiler">secret</span>'),
        '<span class="tg-spoiler">secret</span>',
      );
      assert.equal(sanitizeTelegramHtml('<span class="other">plain</span>'), 'plain');
      assert.equal(sanitizeTelegramHtml('<span>plain</span>'), 'plain');
    });

    test('keeps <tg-emoji> only with an emoji-id', () => {
      assert.equal(
        sanitizeTelegramHtml('<tg-emoji emoji-id="5368324170671202286">🙂</tg-emoji>'),
        '<tg-emoji emoji-id="5368324170671202286">🙂</tg-emoji>',
      );
      assert.equal(sanitizeTelegramHtml('<tg-emoji>🙂</tg-emoji>'), '🙂');
    });

    test('keeps the bare expandable flag on <blockquote>', () => {
      assert.equal(
        sanitizeTelegramHtml('<blockquote expandable>q</blockquote>'),
        '<blockquote expandable>q</blockquote>',
      );
      assert.equal(
        sanitizeTelegramHtml('<blockquote>q</blockquote>'),
        '<blockquote>q</blockquote>',
      );
    });
  });
});

describe('splitTelegramMessage', () => {
  test('returns short text as a single untouched chunk', () => {
    assert.deepEqual(splitTelegramMessage('hello'), ['hello']);
  });

  test('does not split text exactly at the limit', () => {
    const text = 'a'.repeat(TELEGRAM_MAX_MESSAGE);
    assert.deepEqual(splitTelegramMessage(text), [text]);
  });

  test('splits text one character over the limit', () => {
    const chunks = splitTelegramMessage('a'.repeat(TELEGRAM_MAX_MESSAGE + 1));
    assert.equal(chunks.length, 2);
  });

  test('repeated calls return identical output', () => {
    const text = `<b>${'bold '.repeat(2_000)}</b>`;
    const first = splitTelegramMessage(text);
    assert.deepEqual(splitTelegramMessage(text), first);
    assert.deepEqual(splitTelegramMessage(text), first);
  });

  describe('invariants across many shapes of long input', () => {
    const cases: Array<[name: string, text: string]> = [
      ['unbroken run', 'a'.repeat(20_000)],
      ['many lines', 'line of text\n'.repeat(2_000)],
      ['long paragraphs', `${'word '.repeat(900)}\n\n`.repeat(6)],
      ['wrapped in bold', `<b>${'bold '.repeat(2_000)}</b>`],
      ['nested tags', `<b><i>${'x'.repeat(9_000)}</i></b>`],
      ['pre block', `<pre><code class="language-ts">${'const x = 1;\n'.repeat(800)}</code></pre>`],
      ['entity run', '&amp;'.repeat(2_000)],
      ['mixed markup', '<b>a</b> plain <code>c</code> &amp; more\n'.repeat(300)],
      ['tags at boundary', `${'x'.repeat(TELEGRAM_MAX_MESSAGE - 2)}<b>y</b>${'z'.repeat(100)}`],
    ];

    for (const [name, text] of cases) {
      test(`${name}: every chunk fits Telegram's limit`, () => {
        for (const chunk of splitTelegramMessage(text)) {
          assert.ok(
            chunk.length <= TELEGRAM_MAX_MESSAGE,
            `chunk of ${chunk.length} exceeds ${TELEGRAM_MAX_MESSAGE}`,
          );
        }
      });

      test(`${name}: every chunk is independently balanced`, () => {
        for (const chunk of splitTelegramMessage(text)) {
          assert.ok(isBalanced(chunk), `unbalanced chunk: ${chunk.slice(0, 80)}…`);
        }
      });

      test(`${name}: no chunk is empty`, () => {
        for (const chunk of splitTelegramMessage(text)) {
          assert.notEqual(chunk.length, 0);
        }
      });

      test(`${name}: no chunk ends mid-tag`, () => {
        for (const chunk of splitTelegramMessage(text)) {
          assert.equal(
            (chunk.match(/</g) ?? []).length,
            (chunk.match(/>/g) ?? []).length,
            'unbalanced angle brackets imply a tag was cut',
          );
          assert.doesNotMatch(chunk, /<[^>]*$/);
        }
      });

      test(`${name}: content survives, apart from newlines consumed at boundaries`, () => {
        const joined = splitTelegramMessage(text).map(textContentOf).join('');
        assert.equal(joined.replace(/\n/g, ''), textContentOf(text).replace(/\n/g, ''));
      });
    }
  });

  test('reopens an enclosing tag in each chunk and closes it at each boundary', () => {
    const chunks = splitTelegramMessage(`<b>${'bold '.repeat(2_000)}</b>`);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.startsWith('<b>'), `chunk does not reopen <b>: ${chunk.slice(0, 40)}`);
      assert.ok(chunk.endsWith('</b>'), `chunk does not close <b>: ${chunk.slice(-40)}`);
    }
  });

  test('reopens nested tags in the original order', () => {
    const chunks = splitTelegramMessage(`<b><i>${'x'.repeat(9_000)}</i></b>`);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.startsWith('<b><i>'), `wrong reopen order: ${chunk.slice(0, 40)}`);
      assert.ok(chunk.endsWith('</i></b>'), `wrong close order: ${chunk.slice(-40)}`);
    }
  });

  test('carries the code language across a boundary', () => {
    const chunks = splitTelegramMessage(
      `<pre><code class="language-ts">${'const x = 1;\n'.repeat(800)}</code></pre>`,
    );
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.startsWith('<pre><code class="language-ts">'));
    }
  });

  test('never splits an entity in half', () => {
    // Each chunk must be a whole number of entities, or Telegram rejects it.
    for (const chunk of splitTelegramMessage('&amp;'.repeat(2_000))) {
      assert.match(chunk, /^(?:&amp;)+$/);
    }
  });

  test('prefers a newline boundary when one is reasonably close', () => {
    const chunks = splitTelegramMessage('line of text\n'.repeat(2_000));
    assert.ok(chunks.length > 1);
    // A newline split means no chunk ends mid-word.
    for (const chunk of chunks.slice(0, -1)) {
      assert.match(chunk, /(?:text|\n)$/);
    }
  });
});
