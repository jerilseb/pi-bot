import assert from 'node:assert/strict';
import { type Duplex, duplexPair } from 'node:stream';
import { test } from 'node:test';
import type { Welcome } from '../src/channels/socket/protocol.ts';
import { SocketServer } from '../src/channels/socket/server.ts';
import type {
  Channel,
  ChannelCaps,
  ChannelRef,
  CoreEvent,
  Deliverable,
  Receipt,
} from '../src/contract.ts';
import { RemoteCore } from '../src/tui/remote-core.ts';
import { ScriptedCore, until } from './scripted-core.ts';

/**
 * The terminal's half of the socket: AgentCore as a proxy, over the bot's real
 * half (SocketServer and its channels) on in-memory streams. What a terminal
 * relies on: the welcome before anything else, its calls answered as its own
 * channel, its receipts reaching the bot, and a reconnect after the bot goes.
 */

class TestTerminal implements Channel {
  ref: ChannelRef = { id: 'tui', kind: 'tui' };
  readonly caps: ChannelCaps = {
    buttons: true,
    edits: true,
    files: true,
    voice: false,
    durable: false,
  };
  readonly commands = [{ name: 'quit', description: 'Close this terminal' }];
  readonly seen: string[] = [];
  receipt: Omit<Receipt, 'channel'> = { ok: true };

  onEvent(event: CoreEvent): void {
    this.seen.push(`event:${event.type}`);
  }

  async deliver(item: Deliverable): Promise<Receipt> {
    this.seen.push(`deliver:${item.kind}`);
    return { channel: this.ref, ...this.receipt };
  }

  async drain(): Promise<void> {}
}

function setup() {
  const core = new ScriptedCore();
  const server = new SocketServer({ core, path: '/unused' });
  const serverSides: Duplex[] = [];
  const terminal = new TestTerminal();
  const disconnects: string[] = [];
  const remote = new RemoteCore({
    connect: async () => {
      const [ours, theirs] = duplexPair();
      serverSides.push(theirs);
      server.accept(theirs);
      return ours;
    },
    onConnect: (welcome: Welcome) => terminal.seen.push(`welcome:${welcome.ref.id}`),
    onDisconnect: (reason) => disconnects.push(reason),
    reconnectMinMs: 5,
    reconnectMaxMs: 20,
  });
  return { core, server, serverSides, terminal, remote, disconnects };
}

test("the welcome reaches the terminal before any of its connection's events", async (t) => {
  const f = setup();
  // An event the moment the terminal is attached: before its welcome is even sent.
  f.core.onAttach = () => f.core.emit({ type: 'reset' });
  t.after(f.remote.attach(f.terminal));
  await until(() => f.terminal.seen.length === 2);
  assert.deepEqual(f.terminal.seen, ['welcome:tui:1', 'event:reset']);
  assert.deepEqual(f.remote.ref, { id: 'tui:1', kind: 'tui' });
  assert.deepEqual(
    f.remote.commands().map((command) => command.name),
    ['help', 'quit'],
  );
});

test('calls reach the core as this connection, whatever they claim to be', async (t) => {
  const f = setup();
  t.after(f.remote.attach(f.terminal));
  await until(() => f.remote.connected);
  const telegram: ChannelRef = { id: 'telegram', kind: 'telegram' };
  assert.deepEqual(await f.remote.submit({ from: telegram, text: 'hi', attachments: [] }), {
    status: 'queued',
  });
  assert.deepEqual(f.core.submitted[0]?.from, { id: 'tui:1', kind: 'tui' });
  assert.equal(await f.remote.command('/help', telegram), true);
  assert.deepEqual(f.core.commandsRun, [{ line: '/help', from: { id: 'tui:1', kind: 'tui' } }]);
  assert.equal(await f.remote.stopJob('sub_1', 2, telegram), 'stopping');
  assert.deepEqual(f.core.stops[0], {
    jobId: 'sub_1',
    task: 2,
    from: { id: 'tui:1', kind: 'tui' },
  });
  assert.deepEqual(await f.remote.beginIngestion(), { epoch: 7 });
  assert.equal((await f.remote.choose('menu', 1, telegram)).text.text, 'menu:1');
  assert.deepEqual((await f.remote.snapshot()).history, []);
});

test("a delivery is answered with the terminal's own receipt", async (t) => {
  const f = setup();
  t.after(f.remote.attach(f.terminal));
  await until(() => f.remote.connected);
  f.terminal.receipt = { ok: false, error: 'cannot play voice', skipped: 'unsupported' };
  const receipt = await f.core.deliver('tui:1', { kind: 'voice', text: 'hello', ping: [] });
  assert.deepEqual(receipt, {
    channel: { id: 'tui:1', kind: 'tui' },
    ok: false,
    error: 'cannot play voice',
    skipped: 'unsupported',
  });
  assert.deepEqual(f.terminal.seen.slice(1), ['deliver:voice']);
});

test('a call while disconnected fails at once, and one in flight fails when the link drops', async (t) => {
  const f = setup();
  await assert.rejects(f.remote.command('/help'), /Not connected/);
  let hold = (): void => {};
  f.core.command = () =>
    new Promise((resolve) => {
      hold = () => resolve(true);
    });
  t.after(f.remote.attach(f.terminal));
  await until(() => f.remote.connected);
  const inFlight = f.remote.command('/slow');
  await until(() => f.serverSides.length === 1);
  f.serverSides[0]?.destroy();
  await assert.rejects(inFlight, /Lost the connection/);
  hold();
});

test('it reconnects after the bot goes away, and says hello again', async (t) => {
  const f = setup();
  t.after(f.remote.attach(f.terminal));
  await until(() => f.remote.connected);
  f.serverSides[0]?.end();
  await until(() => f.disconnects.length === 1, 'the disconnect');
  assert.equal(f.remote.connected, false);
  await until(() => f.remote.ref?.id === 'tui:2', 'the second welcome');
  assert.deepEqual(
    f.terminal.seen.filter((entry) => entry.startsWith('welcome')),
    ['welcome:tui:1', 'welcome:tui:2'],
  );
  assert.deepEqual(f.core.detached, ['tui:1']);
});

test('a failed hello is a disconnect, retried with a growing backoff', async (t) => {
  let attempts = 0;
  const delays: number[] = [];
  const remote = new RemoteCore({
    connect: async () => {
      attempts++;
      throw new Error('ENOENT');
    },
    onDisconnect: (_reason, retryInMs) => delays.push(retryInMs),
    reconnectMinMs: 1,
    reconnectMaxMs: 4,
  });
  t.after(remote.attach(new TestTerminal()));
  await until(() => attempts >= 4);
  assert.deepEqual(delays.slice(0, 3), [2, 4, 4]);
});
