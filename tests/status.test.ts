import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TELEGRAM_MAX_MESSAGE } from '../src/config.ts';
import {
  compactTokens,
  contextLight,
  formatUptime,
  renderStatus,
  type StatusSnapshot,
} from '../src/status.ts';
import { markdownToTelegramHtml } from '../src/channels/telegram/markdown.ts';
import { sanitizeTelegramHtml } from '../src/channels/telegram/telegram-html.ts';

/**
 * /status is one Markdown message, which Telegram shows as one HTML message.
 * Telegram rejects the whole message on malformed markup, so every shape the
 * snapshot can take must convert to balanced HTML within one message, with the
 * values the bot did not write escaped.
 */

const TELEGRAM_SETTINGS = (subagentToolCalls: boolean) => ({
  title: 'Telegram',
  settings: [
    { label: 'Sub-agent tool calls', on: subagentToolCalls },
    { label: 'Voice transcripts', on: true },
    { label: '🛠 Tool calls', detail: 'Collapsed' },
  ],
});

/** The status as Telegram shows it. */
function html(shape: StatusSnapshot): string {
  return markdownToTelegramHtml(renderStatus(shape));
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    chat: {
      processing: false,
      model: 'openai-codex/gpt-5.6-luna',
      reasoning: 'medium',
      messages: 12,
      queue: 0,
      steering: 0,
      uptimeMs: 3_725_000,
    },
    context: { tokens: 84_000, contextWindow: 272_000, percent: 30.9 },
    tokens: { input: 20_000, cacheRead: 900_000, cacheWrite: 5_000, output: 42_000, cost: 0.1234 },
    background: { loaded: true, processing: false, queue: 0, model: 'per-prompt' },
    features: {
      voice: { on: true, detail: 'ElevenLabs' },
      heartbeat: { on: false, detail: 'off' },
      cron: { on: true, detail: '2 of 3 active' },
      subagents: false,
    },
    channels: [TELEGRAM_SETTINGS(false)],
    ...overrides,
  };
}

function tagStack(html: string): string[] {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    const [, closing, name] = match;
    if (closing) assert.equal(stack.pop(), name, `unbalanced </${name}>`);
    else stack.push(name);
  }
  return stack;
}

const SHAPES: Array<[string, StatusSnapshot]> = [
  ['a loaded, idle chat', snapshot()],
  [
    'a busy chat',
    snapshot({ chat: { ...snapshot().chat, processing: true, queue: 3, steering: 1 } }),
  ],
  [
    'no session loaded',
    (() => {
      const { context: _c, tokens: _t, ...rest } = snapshot();
      return rest;
    })(),
  ],
  [
    'just compacted',
    snapshot({ context: { tokens: null, contextWindow: 272_000, percent: null } }),
  ],
  [
    'background not started',
    snapshot({ background: { loaded: false, processing: false, queue: 0, model: '' } }),
  ],
  ['hostile values', snapshot({ chat: { ...snapshot().chat, model: '<b>x</b> & "y"' } })],
];

describe('renderStatus', () => {
  for (const [name, shape] of SHAPES) {
    test(`renders balanced HTML within one message: ${name}`, () => {
      const shown = html(shape);
      assert.deepEqual(tagStack(shown), []);
      assert.ok(shown.length <= TELEGRAM_MAX_MESSAGE);
      assert.equal(sanitizeTelegramHtml(shown), shown);
    });
  }

  test('shows background messages held for the chat cooldown, only when there are some', () => {
    const background = { loaded: true, processing: false, queue: 0, model: 'per-prompt' };
    assert.match(html(snapshot({ background: { ...background, held: 2 } })), /📬 Held <b>2<\/b>/);
    assert.doesNotMatch(html(snapshot({ background: { ...background, held: 0 } })), /Held/);
  });

  test("shows each interface's own settings under its name", () => {
    assert.match(
      html(snapshot()),
      /📱 <b>Telegram<\/b>\n⛔ Sub-agent tool calls\n✅ Voice transcripts/,
    );
    assert.match(
      html(snapshot({ channels: [TELEGRAM_SETTINGS(true)] })),
      /\n✅ Sub-agent tool calls\n/,
    );
    assert.match(html(snapshot()), /🛠 Tool calls · <i>Collapsed<\/i>$/);
    assert.doesNotMatch(html(snapshot({ channels: [] })), /Telegram/);
  });

  test('escapes values it did not write', () => {
    assert.match(html(SHAPES[5][1]), /<code>&lt;b&gt;x&lt;\/b&gt; &amp; "y"<\/code>/);
  });

  test('shows context as used and free against the window', () => {
    const shown = html(snapshot());
    assert.match(shown, /🟢 31% used/);
    assert.match(shown, /84k of 272k · 188k free/);
  });

  test('explains an unknown reading after compaction instead of showing 0%', () => {
    const shown = html(SHAPES[3][1]);
    assert.match(shown, /\? \/ 272k/);
    assert.doesNotMatch(shown, /% used/);
  });

  test('keeps the chat details quoted right under their heading', () => {
    assert.match(html(snapshot()), /💬 <b>Chat<\/b> · 🟢 idle\n<blockquote>🤖 <code>/);
  });
});

describe('helpers', () => {
  test('contextLight turns amber at half and red at 80%', () => {
    assert.equal(contextLight(49), '🟢');
    assert.equal(contextLight(50), '🟡');
    assert.equal(contextLight(80), '🔴');
  });

  test('compactTokens keeps small counts exact and shortens large ones', () => {
    assert.equal(compactTokens(950), '950');
    assert.equal(compactTokens(84_321), '84k');
    assert.equal(compactTokens(1_000_000), '1m');
    assert.equal(compactTokens(1_250_000), '1.3m');
  });

  test('formatUptime uses the two largest units', () => {
    assert.equal(formatUptime(45_000), '45s');
    assert.equal(formatUptime(12 * 60_000), '12m');
    assert.equal(formatUptime(3_725_000), '1h 2m');
    assert.equal(formatUptime(52 * 3_600_000), '2d 4h');
  });
});
