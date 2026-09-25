import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  type CallbackAction,
  type CallbackMenu,
  dispatchCallbackQuery,
} from '../src/channels/telegram/callback-menu.ts';
import { ALLOWED_CHAT_ID } from '../src/config.ts';
import type { TelegramCallbackQuery } from '../src/channels/telegram/types.ts';

interface ApiCall {
  method: string;
  body: Record<string, unknown>;
}

/** Records Bot API calls; `failEdits` makes editMessageText return a 400. */
function fakeTelegram(t: TestContext, failEdits = false): ApiCall[] {
  const calls: ApiCall[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const method = String(url).split('/').at(-1) ?? '';
    calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (failEdits && method === 'editMessageText') {
      return new Response('{"ok":false,"description":"Bad Request: message to edit not found"}', {
        status: 400,
      });
    }
    return Response.json({ ok: true, result: { message_id: 7 } });
  });
  return calls;
}

function tap(data: string, chatId: number | string = ALLOWED_CHAT_ID): TelegramCallbackQuery {
  return {
    id: 'q1',
    from: { id: 1 },
    data,
    message: { message_id: 42, chat: { id: Number(chatId), type: 'private' }, date: 0 },
  };
}

function menu(t: TestContext, overrides: Partial<CallbackMenu> = {}) {
  const select = t.mock.fn(async (value: string) =>
    value === 'ok' ? { toast: 'Applied.', text: `applied ${value}` } : null,
  );
  const definition: CallbackMenu = {
    prefix: 'thing:',
    cancelText: 'Kept the thing.',
    unknownOptionText: 'That thing is gone. Use /thing again.',
    failureToast: 'Thing failed.',
    select,
    ...overrides,
  };
  return { definition, select };
}

function toasts(calls: ApiCall[]): unknown[] {
  return calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text);
}

function edits(calls: ApiCall[]): unknown[] {
  return calls.filter((c) => c.method === 'editMessageText').map((c) => c.body.text);
}

test('routes by prefix and answers taps no menu owns', async (t) => {
  const calls = fakeTelegram(t);
  const first = menu(t, { prefix: 'a:' });
  const second = menu(t, { prefix: 'b:' });

  await dispatchCallbackQuery(tap('b:ok'), [first.definition, second.definition]);
  assert.equal(first.select.mock.callCount(), 0);
  assert.deepEqual(second.select.mock.calls[0]?.arguments, ['ok']);

  await dispatchCallbackQuery(tap('zzz:1'), [first.definition, second.definition]);
  assert.deepEqual(toasts(calls), ['Applied.', 'Unknown action.']);
});

test('a tap from another chat is refused before select runs', async (t) => {
  const calls = fakeTelegram(t);
  const m = menu(t);

  await dispatchCallbackQuery(tap('thing:ok', 999), [m.definition]);

  assert.equal(m.select.mock.callCount(), 0);
  assert.deepEqual(toasts(calls), ['This menu is no longer valid.']);
  assert.deepEqual(edits(calls), []);
});

test('cancel, refusal, unknown option, and success each replace the menu once', async (t) => {
  const calls = fakeTelegram(t);
  let busy = true;
  const m = menu(t, {
    refuse: () => (busy ? { toast: 'Busy.', text: 'Try later.' } : null),
  });

  await dispatchCallbackQuery(tap('thing:cancel'), [m.definition]);
  await dispatchCallbackQuery(tap('thing:ok'), [m.definition]);
  busy = false;
  await dispatchCallbackQuery(tap('thing:stale'), [m.definition]);
  await dispatchCallbackQuery(tap('thing:ok'), [m.definition]);

  assert.equal(m.select.mock.callCount(), 2, 'cancel and refusal never reach select');
  assert.deepEqual(toasts(calls), ['Cancelled', 'Busy.', 'Unknown option.', 'Applied.']);
  assert.deepEqual(edits(calls), [
    'Kept the thing.',
    'Try later.',
    'That thing is gone. Use /thing again.',
    'applied ok',
  ]);
  for (const call of calls.filter((c) => c.method === 'editMessageText')) {
    assert.equal(call.body.message_id, 42);
  }
});

test('without cancelText the cancel value reaches select', async (t) => {
  fakeTelegram(t);
  const m = menu(t, { cancelText: undefined });

  await dispatchCallbackQuery(tap('thing:cancel'), [m.definition]);

  assert.deepEqual(m.select.mock.calls[0]?.arguments, ['cancel']);
});

test('a throwing select reports the error, escaped exactly once', async (t) => {
  const calls = fakeTelegram(t);
  const m = menu(t, {
    select: async () => {
      throw new Error('Model a & b <unknown>\n    at somewhere');
    },
  });

  await dispatchCallbackQuery(tap('thing:ok'), [m.definition]);

  assert.deepEqual(toasts(calls), ['Thing failed.']);
  assert.deepEqual(edits(calls), ['❌ Model a &amp; b &lt;unknown&gt;']);
});

test('a failed edit after a successful select is logged, not reported as a failure', async (t) => {
  const calls = fakeTelegram(t, true);
  const m = menu(t);
  const errors = t.mock.method(console, 'error', () => {});

  await dispatchCallbackQuery(tap('thing:ok'), [m.definition]);

  assert.deepEqual(toasts(calls), ['Applied.']);
  assert.equal(errors.mock.callCount(), 1);
});

test('an action answers the tap with its toast and leaves the message alone', async (t) => {
  const calls = fakeTelegram(t);
  const answer = t.mock.fn((value: string) => `Stopping ${value}…`);
  const action: CallbackAction = { prefix: 'stop:', answer };
  const m = menu(t);

  await dispatchCallbackQuery(tap('stop:bg_1'), [m.definition], [action]);

  assert.deepEqual(answer.mock.calls[0]?.arguments, ['bg_1']);
  assert.deepEqual(toasts(calls), ['Stopping bg_1…']);
  assert.deepEqual(edits(calls), [], 'the live message is the bot’s to edit, not the tap’s');
  assert.equal(m.select.mock.callCount(), 0);
});

test('an action refuses a tap from another chat before it runs', async (t) => {
  const calls = fakeTelegram(t);
  const answer = t.mock.fn(() => 'Stopping…');

  await dispatchCallbackQuery(tap('stop:bg_1', 999), [], [{ prefix: 'stop:', answer }]);

  assert.equal(answer.mock.callCount(), 0);
  assert.deepEqual(toasts(calls), ['This button is no longer valid.']);
});

test('an action that throws still has its tap answered', async (t) => {
  const calls = fakeTelegram(t);
  t.mock.method(console, 'error', () => {});
  const action: CallbackAction = {
    prefix: 'stop:',
    answer() {
      throw new Error('x'.repeat(1_000));
    },
  };

  await dispatchCallbackQuery(tap('stop:bg_1'), [], [action]);

  assert.deepEqual(toasts(calls), ['Something went wrong; see the bot log.']);
});
