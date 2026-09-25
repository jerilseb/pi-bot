import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex, duplexPair } from 'node:stream';
import { test } from 'node:test';
import { encodeLine, JsonlDecoder } from '../src/channels/socket/jsonl.ts';
import { PROTOCOL_VERSION, recentHistory, type Welcome } from '../src/channels/socket/protocol.ts';
import { SocketServer } from '../src/channels/socket/server.ts';
import type { CoreEvent, Deliverable } from '../src/contract.ts';
import { emptySnapshot, ScriptedCore, until } from './scripted-core.ts';

/**
 * The bot's half of the terminal UI's socket: one channel per connection,
 * carrying the AgentCore contract as JSONL. A test plays the client over an
 * in-memory stream pair, writing its records and reading the bot's.
 */

const CAPS = { buttons: true, edits: true, files: true, voice: false, durable: false };
const HELLO = {
  id: 1,
  type: 'hello',
  protocol: PROTOCOL_VERSION,
  caps: CAPS,
  commands: [{ name: 'quit', description: 'Close this terminal' }],
};

/** A record from the bot, as a test reads it. */
interface Record {
  type: string;
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  event?: CoreEvent;
  item?: Deliverable;
}

const welcomeOf = (record: Record): Welcome => record.result as Welcome;

function client(server: SocketServer, stream?: Duplex) {
  const [ours, theirs] = duplexPair();
  const channel = server.accept(stream ?? theirs);
  const records: Record[] = [];
  const decoder = new JsonlDecoder(
    (record) => records.push(record as Record),
    (error) => {
      throw error;
    },
  );
  ours.on('data', (chunk: Buffer) => decoder.push(chunk));
  const send = (message: unknown): void => {
    ours.write(encodeLine(message));
  };
  const response = async (id: number): Promise<Record> => {
    await until(() => records.some((r) => r.type === 'response' && r.id === id), `response ${id}`);
    return records.find((r) => r.type === 'response' && r.id === id) as Record;
  };
  const events = (): CoreEvent[] =>
    records.flatMap((r) => (r.type === 'event' && r.event ? [r.event] : []));
  return { ours, channel, records, send, response, events };
}

function setup(options: ConstructorParameters<typeof SocketServer>[0]['channelOptions'] = {}) {
  const core = new ScriptedCore();
  const server = new SocketServer({ core, path: '/unused', channelOptions: options });
  return { core, server };
}

const agentUpdate = (text: string): CoreEvent => ({
  type: 'agent',
  turnId: 'chat-1',
  session: 'chat',
  event: {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    assistantMessageEvent: { type: 'text_delta', delta: text.slice(-1), partial: { big: true } },
  } as never,
});

test('a client is attached once it says hello, and hears nothing older than its snapshot', async () => {
  const { core, server } = setup();
  let finishSnapshot = (): void => {};
  core.snapshotResult = () =>
    new Promise((resolve) => {
      finishSnapshot = () => resolve({ ...emptySnapshot(), channels: [{ id: 'x', kind: 'tui' }] });
    });
  const c = client(server);
  assert.equal(core.channels.size, 0, 'nothing is attached before the hello');

  c.send(HELLO);
  await until(() => core.channels.size === 1);
  core.emit({ type: 'reset' });
  finishSnapshot();

  const welcome = await c.response(1);
  assert.equal(welcome.ok, true);
  assert.deepEqual(welcomeOf(welcome).ref, { id: 'tui:1', kind: 'tui' });
  assert.deepEqual(
    welcomeOf(welcome).commands.map((command) => command.name),
    ['help', 'quit'],
    "the core's commands, then the client's own",
  );
  assert.deepEqual(welcomeOf(welcome).snapshot.channels, [{ id: 'x', kind: 'tui' }]);
  await until(() => c.events().length === 1);
  assert.equal(c.records.indexOf(welcome) < c.records.findIndex((r) => r.type === 'event'), true);
  assert.deepEqual(core.channels.get('tui:1')?.caps, CAPS);
});

test('a client on another protocol version is told so, and let go', async () => {
  const { core, server } = setup();
  const c = client(server);
  c.send({ ...HELLO, protocol: PROTOCOL_VERSION + 1 });
  const answer = await c.response(1);
  assert.equal(answer.ok, false);
  assert.match(answer.error ?? '', /protocol/);
  assert.equal(core.channels.size, 0);
});

test('a request before the hello is refused; a malformed record ends the connection', async () => {
  const { server } = setup();
  const c = client(server);
  c.send({ id: 5, type: 'snapshot' });
  assert.equal((await c.response(5)).ok, false);
  c.send({ id: 6, type: 'nonsense' });
  await until(() => c.channel.isClosed, 'the channel to close');
});

test('every request is answered under its own ID, whichever finishes first', async () => {
  const { core, server } = setup();
  let release = (): void => {};
  core.command = (line) =>
    line === '/slow'
      ? new Promise((resolve) => {
          release = () => resolve(true);
        })
      : Promise.resolve(false);
  const c = client(server);
  c.send(HELLO);
  await c.response(1);
  c.send({ id: 2, type: 'command', line: '/slow' });
  c.send({ id: 3, type: 'command', line: '/fast' });
  assert.deepEqual((await c.response(3)).result, false);
  release();
  assert.deepEqual((await c.response(2)).result, true);
  c.send({ id: 4, type: 'stopJob', jobId: 'bg_1' });
  assert.equal((await c.response(4)).result, 'stopping');
  // The core hears the connection's channel, not whatever a client might claim.
  assert.deepEqual(core.stops, [
    { jobId: 'bg_1', task: undefined, from: { id: 'tui:1', kind: 'tui' } },
  ]);
});

test("a delivery waits for the client's receipt, and fails on a timeout or a disconnect", async () => {
  const { core, server } = setup({ receiptTimeoutMs: 30 });
  const c = client(server);
  c.send(HELLO);
  await c.response(1);
  const item: Deliverable = { kind: 'voice', text: 'hi', ping: [] };

  const answered = core.deliver('tui:1', item);
  await until(() => c.records.some((r) => r.type === 'deliver'));
  const delivery = c.records.find((r) => r.type === 'deliver') as Record;
  assert.deepEqual(delivery.item, item);
  c.send({ type: 'receipt', id: delivery.id, ok: false, error: 'no speaker' });
  assert.deepEqual(await answered, {
    channel: { id: 'tui:1', kind: 'tui' },
    ok: false,
    error: 'no speaker',
  });

  assert.deepEqual(await core.deliver('tui:1', item), {
    channel: { id: 'tui:1', kind: 'tui' },
    ok: false,
    error: 'timeout',
  });

  const unanswered = core.deliver('tui:1', item);
  c.ours.destroy();
  assert.equal((await unanswered).error, 'disconnected');
});

test('streaming updates are coalesced to the latest, and never overtake what follows', async () => {
  const { core, server } = setup({ coalesceMs: 10_000 });
  const c = client(server);
  c.send(HELLO);
  await c.response(1);
  for (const text of ['H', 'He', 'Hel']) core.emit(agentUpdate(text));
  core.emit({ type: 'reset' });
  await until(() => c.events().length === 2);
  const [update, reset] = c.events();
  assert.equal(reset?.type, 'reset');
  assert.ok(update?.type === 'agent' && update.event.type === 'message_update');
  assert.deepEqual((update.event.message as { content: unknown }).content, [
    { type: 'text', text: 'Hel' },
  ]);
  // The partial repeats the message it rides with, so it stays behind.
  assert.deepEqual(update.event.assistantMessageEvent, { type: 'text_delta', delta: 'l' });
});

test('image bytes stay on the server; the history starts at a user message', async () => {
  const { core, server } = setup({ historyMaxMessages: 3 });
  const image = { type: 'image', data: 'QUJD'.repeat(1000), mimeType: 'image/png' };
  core.snapshotResult = async () => ({
    ...emptySnapshot(),
    history: [
      { role: 'user', content: 'old', timestamp: 1 },
      { role: 'assistant', content: [], timestamp: 2 },
      { role: 'toolResult', content: [], timestamp: 3 },
      { role: 'user', content: [{ type: 'text', text: 'look' }, image], timestamp: 4 },
      { role: 'assistant', content: [], timestamp: 5 },
    ] as never,
  });
  const c = client(server);
  c.send(HELLO);
  const history = welcomeOf(await c.response(1)).snapshot.history as unknown as Array<{
    timestamp: number;
    content: unknown[];
  }>;
  assert.deepEqual(
    history.map((message) => message.timestamp),
    [4, 5],
  );
  assert.deepEqual(history[0].content[1], { ...image, data: '' });
});

test('recentHistory keeps everything when a cut would leave no user message', () => {
  const messages = [{ role: 'assistant' }, { role: 'toolResult' }, { role: 'assistant' }] as never;
  assert.equal(recentHistory(messages, 2).length, 2);
  assert.equal(recentHistory(messages, 5).length, 3);
});

test('a client that stops reading is dropped rather than buffered for', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { core, server } = setup({ bufferMaxBytes: 200 });
  // A socket whose peer never reads: nothing written ever finishes.
  const written: string[] = [];
  let push: (chunk: string) => void = () => {};
  const stalled = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, _callback) {
      written.push(chunk.toString());
    },
  });
  push = (chunk) => stalled.push(chunk);
  const channel = server.accept(stalled);
  push(encodeLine(HELLO));
  await until(() => core.channels.size === 1);
  for (let i = 0; i < 20 && !channel.isClosed; i++) {
    core.emit({
      type: 'notice',
      text: { format: 'plain', text: 'x'.repeat(50) },
      level: 'info',
      to: 'all',
      ping: [],
    });
  }
  assert.equal(channel.isClosed, true);
  assert.deepEqual(core.detached, ['tui:1']);
  assert.equal(server.connected, 0);
});

test('a missing attachment is turned away before it reaches the core', async () => {
  const { core, server } = setup();
  const c = client(server);
  c.send(HELLO);
  await c.response(1);
  c.send({
    id: 2,
    type: 'submit',
    text: 'see this',
    attachments: [{ type: 'file', path: '/nonexistent/pi-bot-test-file' }],
  });
  const answer = await c.response(2);
  assert.deepEqual(answer.result, {
    status: 'rejected',
    reason: 'error',
    error: 'No such file: /nonexistent/pi-bot-test-file',
  });
  assert.equal(core.submitted.length, 0);
  c.send({ id: 3, type: 'submit', text: 'hi', attachments: [] });
  assert.deepEqual((await c.response(3)).result, { status: 'queued' });
  assert.deepEqual(core.submitted[0]?.from, { id: 'tui:1', kind: 'tui' });
});

test('each connection is a channel of its own, detached when it goes', async () => {
  const { core, server } = setup();
  const first = client(server);
  const second = client(server);
  first.send(HELLO);
  second.send(HELLO);
  assert.equal(welcomeOf(await first.response(1)).ref.id, 'tui:1');
  assert.equal(welcomeOf(await second.response(1)).ref.id, 'tui:2');
  first.ours.end();
  await until(() => core.detached.length === 1);
  assert.deepEqual(core.detached, ['tui:1']);
  assert.deepEqual([...core.channels.keys()], ['tui:2']);
  assert.equal(server.connected, 1);
});

test('the socket is private, one bot owns it, and a stale one is replaced', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-socket-'));
  const socketPath = path.join(dir, 'private', 'tui.sock');
  const core = new ScriptedCore();
  const server = new SocketServer({ core, path: socketPath });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await server.start();
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

  await assert.rejects(new SocketServer({ core, path: socketPath }).start(), /already serving/);

  // A real client: hello and welcome over the socket itself.
  const socket = net.connect(socketPath);
  const records: Record[] = [];
  const decoder = new JsonlDecoder(
    (record) => records.push(record as Record),
    () => {},
  );
  socket.on('data', (chunk: Buffer) => decoder.push(chunk));
  socket.write(encodeLine(HELLO));
  await until(() => records.length > 0);
  assert.match(welcomeOf(records[0] as Record).ref.id, /^tui:\d+$/);

  await server.stop();
  assert.equal(fs.existsSync(socketPath), false);
  await until(() => socket.destroyed || socket.readableEnded, 'the client to see the close');

  // A bot that died mid-listen leaves its socket file behind; the next start takes over.
  spawnSync(process.execPath, [
    '-e',
    `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, 'SIGKILL'))`,
  ]);
  assert.equal(fs.lstatSync(socketPath).isSocket(), true, 'a socket was left behind');
  const next = new SocketServer({ core, path: socketPath });
  await next.start();
  await next.stop();

  fs.writeFileSync(socketPath, '');
  await assert.rejects(new SocketServer({ core, path: socketPath }).start(), /not a socket/);
});
