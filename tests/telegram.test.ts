import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { TELEGRAM_MAX_MESSAGE } from '../src/config.ts';
import { sendTelegramHtmlMessage, sendTelegramMessage } from '../src/telegram.ts';

const PARSE_ERROR = "Bad Request: can't parse entities: Unsupported start tag";

/** Fakes the Bot API: rejects candidates matching `rejectWhen` with a parse error. */
function fakeTelegram(t: TestContext, rejectWhen: RegExp) {
  const sent: string[] = [];
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
  return sent;
}

test('an escaped fallback that outgrows the limit is split rather than rejected', async (t) => {
  // Fits raw, but every `<` becomes `&lt;` once escaped, so the escaped form is
  // well over the limit. The fake refuses the raw and sanitized rungs, which
  // both still carry the <b> tags the sanitizer keeps.
  const sent = fakeTelegram(t, /<b>/);
  const html = '<b>x</b>'.repeat(Math.floor((TELEGRAM_MAX_MESSAGE - 10) / 8));

  const lastId = await sendTelegramHtmlMessage(html);

  assert.ok(sent.length > 1, 'expected the escaped fallback to be split');
  assert.equal(lastId, sent.length);
  for (const piece of sent) assert.ok(piece.length <= TELEGRAM_MAX_MESSAGE);
  assert.equal(sent.join(''), html.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
});

test('a chunk that Telegram accepts as written is sent once, unsplit', async (t) => {
  const sent = fakeTelegram(t, /never/);
  await sendTelegramMessage('<b>fine</b> text');
  assert.deepEqual(sent, ['<b>fine</b> text']);
});
