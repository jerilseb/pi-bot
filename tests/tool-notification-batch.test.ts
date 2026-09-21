import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { TOOL_CALL_BATCH_MAX_ITEMS, TOOL_CALL_BATCH_MS } from '../src/config.ts';
import { createToolNotifications } from '../src/tool-notification-batch.ts';

interface Delivery {
  method: string;
  text: string;
  messageId?: number;
  silent?: boolean;
  complete(status?: number): void;
}

/** All requests are intercepted; no credentials or live Telegram calls are needed. */
function captureDeliveries(t: TestContext, immediate = false): Delivery[] {
  const deliveries: Delivery[] = [];
  t.mock.method(globalThis, 'fetch', (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      text: string;
      message_id?: number;
      disable_notification?: boolean;
    };
    return new Promise<Response>((resolve) => {
      const id = deliveries.length + 1;
      const delivery: Delivery = {
        method: String(url).split('/').at(-1) ?? '',
        text: body.text,
        messageId: body.message_id,
        silent: body.disable_notification,
        complete(status = 200) {
          resolve(
            Response.json(
              status === 200
                ? { ok: true, result: { message_id: id } }
                : { ok: false, description: 'test transport failure' },
              { status },
            ),
          );
        },
      };
      deliveries.push(delivery);
      if (immediate) delivery.complete();
    });
  });
  return deliveries;
}

for (const mode of ['collapsed', 'stream'] as const) {
  test(`${mode}: finish waits for delivery started by another flush waiter`, async (t) => {
    const deliveries = captureDeliveries(t);
    const batch = createToolNotifications({ source: 'telegram' }, mode);
    for (let i = 0; i < TOOL_CALL_BATCH_MAX_ITEMS * 2; i++) batch.notify(`🛠 call ${i}`);

    let finished = false;
    let flushed = false;
    const finishing = batch.finish().then(() => {
      finished = true;
    });
    const flushing = batch.flush().then(() => {
      flushed = true;
    });
    assert.equal(deliveries.length, 1);
    deliveries[0].complete();
    await nextTurn();

    assert.equal(deliveries.length, 2);
    assert.equal(finished, false, 'the second delivery must finish before the answer');
    assert.equal(flushed, false, 'all waiters must await the current delivery');
    assert.equal(deliveries[1].method, mode === 'collapsed' ? 'editMessageText' : 'sendMessage');
    if (mode === 'collapsed') {
      assert.equal(deliveries[1].messageId, 1);
      assert.ok(deliveries[1].text.includes(`${TOOL_CALL_BATCH_MAX_ITEMS * 2} tool calls`));
    }
    deliveries[1].complete();
    await Promise.all([finishing, flushing]);
    assert.equal(finished, true);
    assert.equal(flushed, true);
  });
}

for (const prompt of [
  { source: 'heartbeat' },
  { source: 'cron' },
  // A completion report returning to the background session is just as unattended.
  { source: 'background-bash-report', session: 'background' },
] as const) {
  const label = prompt.session ? `${prompt.source} in ${prompt.session}` : prompt.source;
  test(`${label} lifecycle cannot flush, clear or close foreground notifications`, async (t) => {
    const deliveries = captureDeliveries(t);
    const background = createToolNotifications(prompt, 'collapsed');
    background.notify('background call');
    const foreground = createToolNotifications({ source: 'telegram' }, 'collapsed');
    foreground.notify('🛠 first');
    const first = foreground.flush();
    assert.equal(deliveries.length, 1);

    // Background completion while the foreground send is in flight must not wait on it.
    await background.finish();
    const anotherBackground = createToolNotifications(prompt, 'off');
    await anotherBackground.finish();
    foreground.notify('🛠 second');
    deliveries[0].complete();
    await nextTurn();
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1].method, 'editMessageText');
    assert.equal(deliveries[1].messageId, 1);
    assert.match(deliveries[1].text, /2 tool calls/);
    assert.match(deliveries[1].text, /first\nsecond/);
    deliveries[1].complete();
    await first;
    await foreground.finish();
  });
}

test('different prompts own different messages, even when finishes overlap', async (t) => {
  const deliveries = captureDeliveries(t);
  const first = createToolNotifications({ source: 'telegram' }, 'collapsed');
  first.notify('🛠 first prompt');
  const finishingFirst = first.finish();
  const second = createToolNotifications({ source: 'telegram' }, 'collapsed');
  second.notify('🛠 second prompt');
  const finishingSecond = second.finish();
  assert.deepEqual(
    deliveries.map((d) => d.method),
    ['sendMessage', 'sendMessage'],
  );
  assert.doesNotMatch(deliveries[1].text, /first prompt/);
  deliveries[1].complete();
  await finishingSecond;
  deliveries[0].complete();
  await finishingFirst;
  await first.finish(); // Repeated finish is safe.
  first.notify('late event');
  await first.flush();
  assert.equal(deliveries.length, 2);
});

test('off mode sends nothing and does not affect another prompt mode', async (t) => {
  const deliveries = captureDeliveries(t, true);
  const off = createToolNotifications({ source: 'telegram' }, 'off');
  const collapsed = createToolNotifications({ source: 'telegram' }, 'collapsed');
  for (let i = 0; i < 20; i++) off.notify('ignored');
  await off.finish();
  collapsed.notify('🛠 visible');
  await collapsed.finish();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].silent, true);
  assert.doesNotMatch(deliveries[0].text, /ignored/);
});

test('fixed timer flushes, and finish cancels timers and rejects late notifications', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deliveries = captureDeliveries(t, true);
  const batch = createToolNotifications({ source: 'telegram' }, 'collapsed');
  batch.notify('🛠 first');
  t.mock.timers.tick(TOOL_CALL_BATCH_MS - 1);
  batch.notify('🛠 second');
  assert.equal(deliveries.length, 0);
  t.mock.timers.tick(1);
  await batch.flush();
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].text, /2 tool calls/);
  batch.notify('🛠 third');
  await batch.finish();
  assert.equal(deliveries.length, 2);
  batch.notify('🛠 too late');
  t.mock.timers.tick(TOOL_CALL_BATCH_MS * 2);
  await batch.finish();
  assert.equal(deliveries.length, 2);
});

test('a failed delivery releases the drain and finish still waits for queued work', async (t) => {
  const deliveries = captureDeliveries(t);
  t.mock.method(console, 'error', () => {});
  const batch = createToolNotifications({ source: 'telegram' }, 'collapsed');
  for (let i = 0; i < TOOL_CALL_BATCH_MAX_ITEMS * 2; i++) batch.notify(`🛠 call ${i}`);
  let finished = false;
  const finishing = batch.finish().then(() => {
    finished = true;
  });
  deliveries[0].complete(503);
  await nextTurn();
  assert.equal(finished, false);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].method, 'sendMessage');
  assert.match(deliveries[1].text, /20 tool calls/);
  deliveries[1].complete();
  await finishing;
  assert.equal(finished, true);
});
