import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TELEGRAM_MAX_MESSAGE } from '../src/config.ts';
import {
  clipEscapedTelegramHtml,
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

/**
 * Telegram's own tags, lowercase with an optional quoted attribute list, as the
 * sanitizer recognises them. Other tag-shaped text, such as `vector<int>`, is
 * content.
 */
const TELEGRAM_TAG_RE =
  /<(\/?)(b|strong|i|em|u|ins|s|strike|del|a|code|pre|blockquote|tg-spoiler|tg-emoji|span)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>/g;

/** Half of a surrogate pair, as left behind by cutting an emoji in two. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Text content with Telegram's tags removed, for checking split() loses no content. */
function textContentOf(html: string): string {
  return html.replace(TELEGRAM_TAG_RE, '');
}

/** True when every Telegram tag in `html` is closed, in order, with no stray closes. */
function isBalanced(html: string): boolean {
  const stack: string[] = [];
  for (const match of html.matchAll(TELEGRAM_TAG_RE)) {
    const [, slash, name] = match;
    if (slash === '/') {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
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

  test('treats uppercase tag names as text, since generics like Option<U> are uppercase', () => {
    assert.equal(sanitizeTelegramHtml('<B>x</B>'), '&lt;B&gt;x&lt;/B&gt;');
    assert.equal(
      sanitizeTelegramHtml('fn map<U>(self) -> Option<U>'),
      'fn map&lt;U&gt;(self) -&gt; Option&lt;U&gt;',
    );
  });

  test('output is always balanced for adversarial input', () => {
    for (const html of [
      '<b><i><code>deeply nested',
      '</b></i>',
      '<b>a</i>b</b>',
      '<pre><code>x</pre></code>',
      '<b>',
      '<b></b></b><i>',
      '<code><b>x</code></b>',
      '<pre>a<i>b</pre></i>',
      'if a<b and c>d <b>real</b>',
    ]) {
      assert.ok(isBalanced(sanitizeTelegramHtml(html)), `not balanced for: ${html}`);
    }
  });

  test('sanitizing its own output changes nothing', () => {
    for (const html of [
      '<b>a</b> <div>x</div> 5 < 6 &nbsp;',
      '<a href="https://x.test/?a=1&b=2" target="_blank">q</a>',
      '<pre><code class="language-ts">let v: Vec<u8> = f::<i32>();</code></pre>',
      '<blockquote expandable>Map<K, V> and <i>it</i></blockquote>',
      'a<b <i>c</i>',
    ]) {
      const once = sanitizeTelegramHtml(html);
      assert.equal(sanitizeTelegramHtml(once), once, `not idempotent for: ${html}`);
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

  describe('tag-shaped text', () => {
    test('escapes generics inside code rather than dropping them', () => {
      assert.equal(
        sanitizeTelegramHtml('<code>Promise<void></code>'),
        '<code>Promise&lt;void&gt;</code>',
      );
    });

    test('escapes an include, generics and a comparison in plain text', () => {
      assert.equal(sanitizeTelegramHtml('#include <stdio.h>'), '#include &lt;stdio.h&gt;');
      assert.equal(
        sanitizeTelegramHtml('Map<string, number> and Vec<T>'),
        'Map&lt;string, number&gt; and Vec&lt;T&gt;',
      );
      assert.equal(sanitizeTelegramHtml('if a<b and c>d then'), 'if a&lt;b and c&gt;d then');
    });

    test('shows every tag inside a code block as written', () => {
      assert.equal(
        sanitizeTelegramHtml(
          '<pre><code class="language-html"><div><b>hi</b><br></div></code></pre>',
        ),
        '<pre><code class="language-html">&lt;div&gt;&lt;b&gt;hi&lt;/b&gt;&lt;br&gt;&lt;/div&gt;</code></pre>',
      );
      assert.equal(
        sanitizeTelegramHtml('<pre>x <i>y</i></pre>'),
        '<pre>x &lt;i&gt;y&lt;/i&gt;</pre>',
      );
    });

    test('does not let text with a stray < swallow the tag after it', () => {
      assert.equal(sanitizeTelegramHtml('a<b <i>c</i>'), 'a&lt;b <i>c</i>');
    });

    test('escapes a close tag with junk after its name', () => {
      assert.equal(sanitizeTelegramHtml('<b>x</b y>'), '<b>x&lt;/b y&gt;</b>');
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
      // Once hung the splitter until the heap ran out: every <int> was an open tag.
      ['generics in a pre block', `<pre>${'std::vector<int> v;\n'.repeat(450)}</pre>`],
      ['tag-shaped text', 'Vec<T>, #include <stdio.h> and Map<string, number>\n'.repeat(300)],
      // Also ran out of heap: the reopened tags alone filled every chunk.
      ['thousands of unclosed tags', '<b>x'.repeat(3_000)],
      [
        'a tag longer than a message',
        `<a href="https://x.test/${'p'.repeat(5_000)}">link</a> ${'tail '.repeat(1_000)}`,
      ],
      ['emoji run', `a${'😀'.repeat(2_100)}`],
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

      test(`${name}: no chunk cuts a surrogate pair`, () => {
        for (const chunk of splitTelegramMessage(text)) {
          assert.doesNotMatch(
            chunk,
            LONE_SURROGATE_RE,
            'a chunk starts or ends with half an emoji',
          );
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

  test('keeps tag-shaped text inside code as text, so sanitizing a chunk keeps its own tags', () => {
    // If the splitter carried <b> as a tag here, the sanitizer would escape the
    // </b> it adds at each boundary, since nothing nests inside code.
    const chunks = splitTelegramMessage(
      `<pre><code>${'<b>x</b> vector<int>\n'.repeat(500)}</code></pre>`,
    );
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      const sanitized = sanitizeTelegramHtml(chunk);
      assert.ok(sanitized.startsWith('<pre><code>'), `lost the reopen: ${sanitized.slice(0, 40)}`);
      assert.ok(sanitized.endsWith('</code></pre>'), `lost the close: ${sanitized.slice(-40)}`);
      assert.doesNotMatch(sanitized, /<b>|&lt;\/(?:code|pre)&gt;/);
    }
  });

  test('stops carrying tags once they would crowd out the content', () => {
    const chunks = splitTelegramMessage('<b>x'.repeat(3_000));
    assert.ok(chunks.length > 1);
    for (const chunk of chunks.slice(0, -1)) {
      assert.ok(textContentOf(chunk).length >= TELEGRAM_MAX_MESSAGE / 4, 'chunk is mostly tags');
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

describe('clipEscapedTelegramHtml', () => {
  test('leaves text that fits once escaped alone', () => {
    assert.equal(clipEscapedTelegramHtml('a < b', 10), 'a &lt; b');
  });

  test('measures after escaping and never cuts an entity or a surrogate pair', () => {
    for (let max = 2; max < 40; max++) {
      const clipped = clipEscapedTelegramHtml('<&>😀'.repeat(20), max);
      assert.ok(clipped.length <= max, `${clipped.length} > ${max}`);
      assert.ok(clipped.endsWith('…'));
      assert.equal(sanitizeTelegramHtml(clipped), clipped);
      assert.doesNotMatch(clipped, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no lone high surrogate');
    }
  });
});
