import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { TELEGRAM_MAX_MESSAGE } from '../src/config.ts';
import {
  editTelegramMessageHtml,
  sendTelegramHtmlMessage,
  sendTelegramMessage,
} from '../src/telegram.ts';

const PARSE_ERROR = "Bad Request: can't parse entities: Unsupported start tag";

/**
 * Fakes the Bot API: rejects candidates matching `rejectWhen` with a parse error.
 * Also captures the warnings the fallback ladder logs.
 */
function fakeTelegram(t: TestContext, rejectWhen: RegExp) {
  const sent: string[] = [];
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.join(' ')));
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { text: string };
    if (payload.text.length > TELEGRAM_MAX_MESSAGE) {
      return new Response('{"ok":false,"description":"Bad Request: message is too long"}', {
        status: 400,
      });
    }
    if (rejectWhen.test(payload.text)) {
      return new Response(`{"ok":false,"description":"${PARSE_ERROR}"}`, { status: 400 });
    }
    sent.push(payload.text);
    return Response.json({ ok: true, result: { message_id: sent.length } });
  });
  return { sent, warnings };
}

test('an escaped fallback that outgrows the limit is split rather than rejected', async (t) => {
  // Fits raw, but every `<` becomes `&lt;` once escaped, so the escaped form is
  // well over the limit. The fake refuses the raw and sanitized rungs, which
  // both still carry the <b> tags the sanitizer keeps.
  const { sent, warnings } = fakeTelegram(t, /<b>/);
  const html = '<b>x</b>'.repeat(Math.floor((TELEGRAM_MAX_MESSAGE - 10) / 8));

  const lastId = await sendTelegramHtmlMessage(html);

  assert.ok(sent.length > 1, 'expected the escaped fallback to be split');
  assert.equal(lastId, sent.length);
  for (const piece of sent) assert.ok(piece.length <= TELEGRAM_MAX_MESSAGE);
  assert.equal(sent.join(''), html.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  assert.equal(warnings.length, 2, 'each step down the ladder is logged');
  assert.match(warnings[0], /retrying sanitized.*Unsupported start tag/);
  assert.match(warnings[1], /sending it escaped/);
});

test('a chunk that Telegram accepts as written is sent once, unsplit', async (t) => {
  const { sent, warnings } = fakeTelegram(t, /never/);
  await sendTelegramMessage('<b>fine</b> text');
  assert.deepEqual(sent, ['<b>fine</b> text']);
  assert.deepEqual(warnings, []);
});

test('a long code reply with unescaped generics arrives intact and escaped', async (t) => {
  // Telegram refuses <int> as a tag, so each chunk falls back to the sanitizer.
  const { sent } = fakeTelegram(t, /<int>/);
  const line = 'std::vector<int> v;\n';
  await sendTelegramMessage(`<pre>${line.repeat(450)}</pre>`);

  assert.ok(sent.length > 1);
  for (const piece of sent) {
    assert.ok(piece.startsWith('<pre>') && piece.endsWith('</pre>'), piece.slice(0, 40));
  }
  const shown = sent.map((piece) => piece.slice('<pre>'.length, -'</pre>'.length)).join('');
  assert.equal(shown.replace(/\n/g, ''), 'std::vector&lt;int&gt; v;'.repeat(450));
});

const STOP = [[{ text: '⏹ Stop', callback_data: 'stop:bg_1' }]];

/** Records each call's text and buttons. */
function recordMarkup(t: TestContext) {
  const calls: Array<{ method: string; text: string; markup?: unknown }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { text: string; reply_markup?: unknown };
    calls.push({
      method: String(url).split('/').at(-1) ?? '',
      text: payload.text,
      ...(payload.reply_markup ? { markup: payload.reply_markup } : {}),
    });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  });
  return calls;
}

test('a message split into pieces carries its buttons on the last one, the one edited later', async (t) => {
  const calls = recordMarkup(t);
  const html = 'word '.repeat(Math.ceil((TELEGRAM_MAX_MESSAGE * 1.5) / 5));

  const lastId = await sendTelegramHtmlMessage(html, { silent: true, keyboard: STOP });

  assert.ok(calls.length > 1);
  assert.equal(lastId, calls.length);
  assert.deepEqual(
    calls.map((call) => call.markup),
    [...Array(calls.length - 1).fill(undefined), { inline_keyboard: STOP }],
  );
});

test('an edit passes its buttons along, and an empty keyboard clears them', async (t) => {
  const calls = recordMarkup(t);

  await editTelegramMessageHtml(7, 'running', STOP);
  await editTelegramMessageHtml(7, 'done', []);
  await editTelegramMessageHtml(7, 'plain');

  assert.deepEqual(
    calls.map((call) => call.markup),
    [{ inline_keyboard: STOP }, { inline_keyboard: [] }, undefined],
  );
});
