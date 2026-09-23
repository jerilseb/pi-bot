import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { BackgroundOutbox, deliverToChat, setBackgroundOutbox } from '../src/background-outbox.ts';

const COOLDOWN = 5 * 60_000;
const POLL = 15_000;

/** An outbox on mocked timers, with a switchable chat-busy flag and a delivery log. */
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const state = { busy: false };
  const outbox = new BackgroundOutbox({
    isChatBusy: () => state.busy,
    cooldownMs: COOLDOWN,
    pollMs: POLL,
  });
  t.after(() => outbox.stop());
  const delivered: string[] = [];
  const send = (label: string) =>
    outbox.send(label, async () => {
      delivered.push(label);
    });
  /** Advances time and lets the flush's promise chain settle. */
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { outbox, state, delivered, send, advance };
}

test('a delivery goes out at once when the chat has been idle for the cooldown', async (t) => {
  const f = fixture(t);
  await f.advance(COOLDOWN);
  assert.equal(await f.send('report'), 'delivered');
  assert.deepEqual(f.delivered, ['report']);
});

test('a delivery is held until the chat has been idle for the whole cooldown', async (t) => {
  const f = fixture(t);
  f.outbox.noteChatActivity();
  assert.equal(await f.send('report'), 'held');
  assert.equal(f.outbox.heldCount, 1);

  await f.advance(COOLDOWN - 1_000);
  assert.deepEqual(f.delivered, []);
  await f.advance(1_000);
  assert.deepEqual(f.delivered, ['report']);
  assert.equal(f.outbox.heldCount, 0);
});

test('nothing goes out while the chat is busy, and the cooldown counts from its last activity', async (t) => {
  const f = fixture(t);
  f.state.busy = true;
  f.outbox.noteChatActivity();
  await f.send('report');

  // Long past the cooldown, but the chat is still busy.
  await f.advance(COOLDOWN * 3);
  assert.deepEqual(f.delivered, []);

  // The turn ends: a full cooldown must pass from there.
  f.state.busy = false;
  f.outbox.noteChatActivity();
  await f.advance(COOLDOWN - POLL);
  assert.deepEqual(f.delivered, []);
  await f.advance(POLL);
  assert.deepEqual(f.delivered, ['report']);
});

test('a message during the hold restarts the cooldown', async (t) => {
  const f = fixture(t);
  f.outbox.noteChatActivity();
  await f.send('report');

  await f.advance(COOLDOWN - 60_000);
  f.outbox.noteChatActivity();
  await f.advance(60_000);
  assert.deepEqual(f.delivered, [], 'the earlier deadline no longer counts');
  await f.advance(COOLDOWN - 60_000);
  assert.deepEqual(f.delivered, ['report']);
});

test('held deliveries go out in order, and a failed one does not block the rest', async (t) => {
  const f = fixture(t);
  f.outbox.noteChatActivity();
  await f.send('first');
  await f.outbox.send('broken', async () => {
    throw new Error('telegram down');
  });
  await f.send('second');

  // Nothing jumps the queue, even once the chat is quiet.
  await f.advance(COOLDOWN);
  assert.deepEqual(f.delivered, ['first', 'second']);
  assert.equal(await f.send('third'), 'delivered');
  assert.deepEqual(f.delivered, ['first', 'second', 'third']);
});

test('a direct delivery failure reaches the caller', async (t) => {
  const f = fixture(t);
  await f.advance(COOLDOWN);
  await assert.rejects(
    f.outbox.send('report', async () => {
      throw new Error('telegram down');
    }),
    /telegram down/,
  );
});

test('only the background session goes through the outbox', async (t) => {
  const f = fixture(t);
  setBackgroundOutbox(f.outbox);
  t.after(() => setBackgroundOutbox(null));
  f.outbox.noteChatActivity();

  const sent: string[] = [];
  assert.equal(
    await deliverToChat('chat', 'reply', async () => {
      sent.push('chat');
    }),
    'delivered',
  );
  assert.equal(
    await deliverToChat('background', 'report', async () => {
      sent.push('background');
    }),
    'held',
  );
  assert.deepEqual(sent, ['chat']);
});

test('without an outbox everything is sent directly', async () => {
  setBackgroundOutbox(null);
  let sent = false;
  assert.equal(
    await deliverToChat('background', 'report', async () => {
      sent = true;
    }),
    'delivered',
  );
  assert.equal(sent, true);
});

test('stopping drops what is held', async (t) => {
  const f = fixture(t);
  f.outbox.noteChatActivity();
  await f.send('report');
  f.outbox.stop();
  await f.advance(COOLDOWN * 2);
  assert.deepEqual(f.delivered, []);
  assert.equal(f.outbox.heldCount, 0);
});
