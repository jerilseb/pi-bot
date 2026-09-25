import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatSession } from '../src/chat-session.ts';
import type { CoreEvent, Deliverable } from '../src/contract.ts';
import { LocalCore } from '../src/core.ts';
import type { PiRuntime } from '../src/pi-session.ts';
import { RecordingChannel } from './recording-channel.ts';

function core(now = () => 0) {
  const runtime = {
    modelName: 'test/model',
    sessionPerPrompt: false,
    sessionKind: 'chat',
  } as unknown as PiRuntime;
  const chatSession = createChatSession(runtime);
  // Nothing here may start a real Pi session.
  Object.assign(chatSession.get().pi, { runPrompt: async () => ({ text: 'ok' }) });
  return new LocalCore({
    chatSession,
    backgroundSession: createChatSession({ ...runtime, sessionKind: 'background' }),
    restart: async () => {},
    isRunning: () => true,
    now,
    activeWindowMs: 1_000,
  });
}

const telegram = () => new RecordingChannel({ id: 'telegram', kind: 'telegram' });
const tui = (n: number) => new RecordingChannel({ id: `tui:${n}`, kind: 'tui' }, false);

test('attaching and detaching tells every channel who is attached', () => {
  const c = core();
  const first = telegram();
  const second = tui(1);
  c.attach(first);
  const detach = c.attach(second);
  detach();
  detach();
  assert.deepEqual(
    first.of('channels').map((event) => event.attached.map((ref) => ref.id)),
    [['telegram'], ['telegram', 'tui:1'], ['telegram']],
  );
  assert.deepEqual(c.snapshot().channels, [first.ref]);
  assert.throws(() => c.attach(telegram()), /already attached/);
});

test('a notice for one channel reaches only that channel', () => {
  const c = core();
  const first = telegram();
  const second = tui(1);
  c.attach(first);
  c.attach(second);
  c.emit({
    type: 'notice',
    text: { format: 'plain', text: 'just for you' },
    level: 'info',
    to: second.ref,
    ping: [],
  });
  c.notice('for everyone');
  assert.deepEqual(first.notices(), ['for everyone']);
  assert.deepEqual(second.notices(), ['just for you', 'for everyone']);
});

test('a channel that throws does not keep events or deliveries from the rest', async (t) => {
  t.mock.method(console, 'error', () => {});
  const c = core();
  const broken = telegram();
  broken.onEvent = (_event: CoreEvent) => {
    throw new Error('broken');
  };
  broken.deliver = async () => {
    throw new Error('upload failed');
  };
  const working = tui(1);
  c.attach(broken);
  c.attach(working);
  c.notice('still here');
  assert.deepEqual(working.notices(), ['still here']);

  const item: Deliverable = {
    kind: 'report',
    text: { format: 'plain', text: 'report' },
    origin: { kind: 'heartbeat' },
    ping: [],
  };
  assert.deepEqual(await c.deliver(item), [
    { channel: broken.ref, ok: false, error: 'upload failed' },
    { channel: working.ref, ok: true },
  ]);
});

test('an unprompted alert goes to the channel used last, within the active window', async () => {
  let clock = 0;
  const c = core(() => clock);
  const first = telegram();
  const second = tui(1);
  c.attach(first);
  c.attach(second);
  const heartbeat = { kind: 'heartbeat' } as const;
  assert.deepEqual(c.pingFor(heartbeat), [first.ref], 'nobody active: every durable channel');

  await c.submit({ from: second.ref, text: 'hi', attachments: [] });
  assert.deepEqual(c.pingFor(heartbeat), [second.ref]);
  // A reply goes to where the input came from, whoever acted since.
  assert.deepEqual(c.pingFor({ kind: 'user', channel: first.ref }), [first.ref]);

  clock = 1_001;
  assert.deepEqual(c.pingFor(heartbeat), [first.ref], 'outside the window: durable again');

  // A reply to input from a channel that has gone alerts like anything unprompted.
  const gone = tui(2);
  c.attach(gone)();
  assert.deepEqual(c.pingFor({ kind: 'user', channel: gone.ref }), [first.ref]);
});
