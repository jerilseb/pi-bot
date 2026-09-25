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
import { sanitizeTelegramHtml } from '../src/channels/telegram/telegram-html.ts';

/**
 * /status is one Telegram HTML message. Telegram rejects the whole message on
 * malformed markup, so every shape the snapshot can take must render balanced,
 * within one message, and with user-controlled values escaped.
 */

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
      toolCalls: 'Collapsed',
      transcripts: true,
      subagentToolCalls: false,
    },
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
      const html = renderStatus(shape);
      assert.deepEqual(tagStack(html), []);
      assert.ok(html.length <= TELEGRAM_MAX_MESSAGE);
      assert.equal(sanitizeTelegramHtml(html), html);
    });
  }

  test('shows background messages held for the chat cooldown, only when there are some', () => {
    const background = { loaded: true, processing: false, queue: 0, model: 'per-prompt' };
    assert.match(
      renderStatus(snapshot({ background: { ...background, held: 2 } })),
      /📬 Held <b>2<\/b>/,
    );
    assert.doesNotMatch(renderStatus(snapshot({ background: { ...background, held: 0 } })), /Held/);
  });

  test('says whether sub-agent progress shows tool calls', () => {
    const features = snapshot().features;
    assert.match(renderStatus(snapshot()), /\n⛔ Sub-agent tool calls\n/);
    assert.match(
      renderStatus(snapshot({ features: { ...features, subagentToolCalls: true } })),
      /\n✅ Sub-agent tool calls\n/,
    );
  });

  test('escapes values it did not write', () => {
    const html = renderStatus(SHAPES[5][1]);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt; &amp; "y"/);
  });

  test('shows context as used and free against the window', () => {
    const html = renderStatus(snapshot());
    assert.match(html, /🟢 31% used/);
    assert.match(html, /84k of 272k · 188k free/);
  });

  test('explains an unknown reading after compaction instead of showing 0%', () => {
    const html = renderStatus(SHAPES[3][1]);
    assert.match(html, /\? \/ 272k/);
    assert.doesNotMatch(html, /% used/);
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
