import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundOutbox, setBackgroundOutbox } from '../src/background-outbox.ts';
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

test('a command answers the channel that asked; a change everyone needs goes to all', async () => {
  const c = core();
  const first = telegram();
  const second = tui(1);
  c.attach(first);
  c.attach(second);
  await c.command('/help', second.ref);
  assert.deepEqual(first.notices(), []);
  assert.match(second.notices()[0] ?? '', /\/status — show this chat session status/);

  await c.command('/abort', second.ref);
  assert.match(first.notices().at(-1) ?? '', /Aborting current prompt/);
  // Every channel hears it, but only the one that asked is alerted.
  assert.deepEqual(first.of('notice').at(-1)?.ping, [second.ref]);
  assert.equal(await c.command('/nosuchcommand', second.ref), false);
});

test("a channel's own commands are listed, and helped, only for that channel", async () => {
  const c = core();
  const plain = telegram();
  const terminal = Object.assign(tui(1), {
    commands: [{ name: 'quit', description: 'Leave', help: 'leave the terminal' }],
  });
  c.attach(plain);
  c.attach(terminal);
  assert.ok(c.commands(terminal.ref).some((command) => command.name === 'quit'));
  assert.ok(!c.commands(plain.ref).some((command) => command.name === 'quit'));
  assert.ok(c.commands(plain.ref).some((command) => command.name === 'models'));
  await c.command('/help', terminal.ref);
  assert.match(terminal.notices()[0] ?? '', /\/quit — leave the terminal/);
});

test('/models offers its menu to the channel that asked, and every channel hears it close', async () => {
  const c = core();
  const first = telegram();
  const second = tui(1);
  c.attach(first);
  c.attach(second);
  await c.command('/models', second.ref);
  assert.deepEqual(first.deliveries, []);
  const [offered] = second.deliveries;
  assert.equal(offered?.kind, 'choice');
  if (offered?.kind !== 'choice') return;
  assert.deepEqual(offered.choice.audience, second.ref);
  assert.deepEqual(
    c.snapshot().choices.map((choice) => choice.id),
    [offered.choice.id],
  );

  const outcome = await c.choose(offered.choice.id, 'cancel', second.ref);
  assert.equal(outcome.text.text, 'Cancelled model switch.');
  for (const channel of [first, second]) {
    assert.equal(channel.of('choice_closed')[0]?.choiceId, offered.choice.id);
  }
});

test('a menu no channel could show is forgotten', async () => {
  const c = core();
  const only = telegram();
  only.receipt = () => ({ ok: false, error: 'offline' });
  c.attach(only);
  await c.command('/models', only.ref);
  assert.deepEqual(c.snapshot().choices, []);
});

test('a message whose ingestion began before /abort is turned away as stale', async () => {
  const c = core();
  const only = telegram();
  c.attach(only);
  const ticket = c.beginIngestion();
  await c.command('/abort', only.ref);
  const result = await c.submit({ from: only.ref, text: 'late photo', attachments: [], ticket });
  assert.deepEqual(result, { status: 'rejected', reason: 'stale' });
  assert.deepEqual(only.of('input'), []);
  const fresh = c.beginIngestion();
  assert.equal(
    (await c.submit({ from: only.ref, text: 'ok', attachments: [], ticket: fresh })).status,
    'queued',
  );
});

test("a tool's delivery during a chat turn alerts the channel the turn came from", async () => {
  const c = core();
  const first = telegram();
  const second = tui(1);
  c.attach(first);
  c.attach(second);
  c.emit({
    type: 'turn_start',
    turnId: 'chat-1',
    session: 'chat',
    origin: { kind: 'user', channel: second.ref },
  });
  let seen: string[] = [];
  const result = await c.toolHost.deliver(
    'chat',
    'image',
    () => ({ kind: 'image', path: '/tmp/x.png' }),
    (receipts) => {
      seen = receipts.map((receipt) => receipt.channel.id);
    },
  );
  assert.equal(result.outcome, 'delivered');
  assert.deepEqual(seen, ['telegram', 'tui:1']);
  assert.deepEqual(first.deliveries[0]?.ping, [second.ref]);
});

test('a background delivery waits for the outbox, and for a channel to send it to', async (t) => {
  const c = core();
  const outbox = new BackgroundOutbox({
    isChatBusy: () => false,
    hasAudience: () => c.hasChannels(),
    cooldownMs: 0,
    pollMs: 1,
  });
  setBackgroundOutbox(outbox);
  t.after(() => {
    outbox.stop();
    setBackgroundOutbox(null);
  });
  t.mock.method(console, 'log', () => {});
  const result = await c.toolHost.deliver('background', 'image', () => ({
    kind: 'image',
    path: '/tmp/x.png',
  }));
  assert.deepEqual(result, { outcome: 'held' }, 'nobody is attached yet');
  assert.equal(outbox.heldCount, 1);

  const only = telegram();
  c.attach(only);
  for (let i = 0; i < 100 && only.deliveries.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(only.deliveries[0]?.kind, 'image');
  assert.equal(outbox.heldCount, 0);
});

test('a stop names the job; anything that is not a running job is not running', () => {
  const c = core();
  const only = telegram();
  c.attach(only);
  assert.equal(c.stopJob('bg_000000', undefined, only.ref), 'not-running');
  assert.equal(c.stopJob('sub_000000', 1, only.ref), 'not-running');
  assert.equal(c.stopJob('bg_000000', 2, only.ref), 'not-running');
});
