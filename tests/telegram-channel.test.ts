import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { TELEGRAM_CHANNEL, TelegramChannel } from '../src/channels/telegram/channel.ts';
import { MAX_QUEUED_PROMPTS, TOOL_CALL_BATCH_MAX_ITEMS, type ToolCallMode } from '../src/config.ts';
import type {
  AgentCore,
  ChannelRef,
  CoreEvent,
  Deliverable,
  PromptOrigin,
  SubmitResult,
  UserInput,
} from '../src/contract.ts';

interface ApiCall {
  method: string;
  text?: string;
  silent: boolean;
  /** Set once Telegram has answered. */
  done: boolean;
  /** Whether every earlier call had been answered when this one was made. */
  afterEarlierDone: boolean;
}

/**
 * Fakes the Bot API. `slow` holds a sendMessage matching it for a moment, and
 * `fail` rejects one matching it, so ordering and fallbacks can be seen.
 */
function fakeTelegram(t: TestContext, options: { slow?: RegExp; fail?: RegExp } = {}) {
  const calls: ApiCall[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as {
      text?: string;
      disable_notification?: boolean;
    };
    const call: ApiCall = {
      method: String(url).split('/').at(-1) ?? '',
      ...(payload.text !== undefined ? { text: payload.text } : {}),
      silent: payload.disable_notification === true,
      done: false,
      afterEarlierDone: calls.every((earlier) => earlier.done),
    };
    calls.push(call);
    if (payload.text && options.slow?.test(payload.text)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    call.done = true;
    if (payload.text && options.fail?.test(payload.text)) {
      return new Response('{"ok":false,"description":"Bad Request: chat not found"}', {
        status: 400,
      });
    }
    return Response.json({ ok: true, result: { message_id: calls.length } });
  });
  const sent = () => calls.filter((call) => call.method === 'sendMessage');
  return { calls, sent };
}

/** An AgentCore that answers submit and command the way a test says. */
function fakeCore(options: { submit?: SubmitResult; command?: boolean } = {}) {
  const submitted: UserInput[] = [];
  const commands: string[] = [];
  const core: AgentCore = {
    async submit(input) {
      submitted.push(input);
      return options.submit ?? { status: 'queued' };
    },
    async command(line) {
      commands.push(line);
      return options.command ?? false;
    },
    attach: () => () => {},
    snapshot: () => {
      throw new Error('unused');
    },
  };
  return { core, submitted, commands };
}

function channel(core: AgentCore = fakeCore().core, mode: ToolCallMode = 'collapsed') {
  return new TelegramChannel({ core, cwd: '/unused', toolCallMode: () => mode });
}

const user: PromptOrigin = { kind: 'user', channel: TELEGRAM_CHANNEL };
const pinged: ChannelRef[] = [TELEGRAM_CHANNEL];

function toolCall(turnId: string, command: string, session: 'chat' | 'background' = 'chat') {
  return {
    type: 'agent',
    turnId,
    session,
    event: {
      type: 'tool_execution_start',
      toolCallId: command,
      toolName: 'bash',
      args: { command },
    } as AgentSessionEvent,
  } satisfies CoreEvent;
}

function reply(turnId: string, text: string, ping = pinged) {
  return {
    type: 'turn_end',
    turnId,
    session: 'chat',
    ping,
    outcome: 'replied',
    reply: { format: 'telegram-html', text },
  } satisfies CoreEvent;
}

test("a turn's tool calls go out before its reply, which waits for them", async (t) => {
  const { sent } = fakeTelegram(t, { slow: /tool call/ });
  const telegram = channel();
  telegram.onEvent({ type: 'turn_start', turnId: 'chat-1', session: 'chat', origin: user });
  telegram.onEvent(toolCall('chat-1', 'ls'));
  telegram.onEvent(toolCall('chat-1', 'pwd'));
  telegram.onEvent(reply('chat-1', '<b>Done</b>'));
  await telegram.drain(1_000);

  const [tools, answer] = sent();
  assert.match(tools?.text ?? '', /2 tool calls/);
  assert.equal(tools?.silent, true);
  assert.equal(answer?.text, '<b>Done</b>');
  assert.equal(answer?.silent, false);
  assert.equal(answer?.afterEarlierDone, true, 'the reply must wait for the tool calls');
  assert.equal(sent().length, 2);
});

test("a turn's tool calls wait for the reply to the turn before it", async (t) => {
  const { sent } = fakeTelegram(t, { slow: /^First answer$/ });
  const telegram = channel(undefined, 'stream');
  telegram.onEvent({ type: 'turn_start', turnId: 'chat-1', session: 'chat', origin: user });
  telegram.onEvent(reply('chat-1', 'First answer'));
  telegram.onEvent({ type: 'turn_start', turnId: 'chat-2', session: 'chat', origin: user });
  // A full batch flushes at once, while the first reply is still being sent.
  for (let i = 0; i < TOOL_CALL_BATCH_MAX_ITEMS; i++)
    telegram.onEvent(toolCall('chat-2', `ls ${i}`));
  telegram.onEvent(reply('chat-2', 'Second answer'));
  await telegram.drain(1_000);

  const texts = sent().map((call) => call.text ?? '');
  assert.equal(texts[0], 'First answer');
  assert.match(texts[1] ?? '', /^🛠 bash/);
  assert.equal(texts[2], 'Second answer');
  assert.equal(sent()[1]?.afterEarlierDone, true);
});

test('stream mode sends each batch of tool calls as its own message', async (t) => {
  const { sent } = fakeTelegram(t);
  const telegram = channel(undefined, 'stream');
  telegram.onEvent({ type: 'turn_start', turnId: 'chat-1', session: 'chat', origin: user });
  telegram.onEvent(toolCall('chat-1', 'ls'));
  telegram.onEvent(reply('chat-1', 'Done'));
  await telegram.drain(1_000);
  assert.deepEqual(
    sent().map((call) => call.text),
    ['🛠 bash (<code>ls</code>)', 'Done'],
  );
});

test('a background turn shows nothing as it runs', async (t) => {
  const { calls } = fakeTelegram(t);
  const telegram = channel();
  telegram.onEvent({
    type: 'turn_start',
    turnId: 'background-1',
    session: 'background',
    origin: { kind: 'heartbeat' },
  });
  telegram.onEvent(toolCall('background-1', 'ls', 'background'));
  telegram.onEvent({ ...reply('background-1', 'report'), session: 'background' });
  await telegram.drain(1_000);
  assert.deepEqual(calls, []);
});

test('a chat turn shows typing until its reply is sent', async (t) => {
  const { calls } = fakeTelegram(t);
  const telegram = channel(undefined, 'off');
  telegram.onEvent({ type: 'turn_start', turnId: 'chat-1', session: 'chat', origin: user });
  telegram.onEvent(reply('chat-1', 'Hi'));
  await telegram.drain(1_000);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['sendChatAction', 'sendMessage'],
  );
});

test('a reply that alerts no one is sent silently', async (t) => {
  const { sent } = fakeTelegram(t);
  const telegram = channel(undefined, 'off');
  telegram.onEvent({ type: 'turn_start', turnId: 'chat-1', session: 'chat', origin: user });
  telegram.onEvent(reply('chat-1', 'Hi', []));
  await telegram.drain(1_000);
  assert.equal(sent()[0]?.silent, true);
});

test("a failed turn shows its error, escaped, after the turn's tool calls", async (t) => {
  const { sent } = fakeTelegram(t, { slow: /tool call/ });
  const telegram = channel();
  telegram.onEvent({ type: 'turn_start', turnId: 'chat-1', session: 'chat', origin: user });
  telegram.onEvent(toolCall('chat-1', 'ls'));
  telegram.onEvent({
    type: 'turn_end',
    turnId: 'chat-1',
    session: 'chat',
    ping: pinged,
    outcome: 'error',
    error: 'bad <thing>\n    at stack frame',
  });
  await telegram.drain(1_000);
  assert.deepEqual(
    sent().map((call) => (call.text?.startsWith('🛠') ? 'tools' : call.text)),
    ['tools', '❌ bad &lt;thing&gt;'],
  );
});

test('a reply that fails to send is replaced by the error', async (t) => {
  const { sent } = fakeTelegram(t, { fail: /^The answer$/ });
  t.mock.method(console, 'error', () => {});
  const telegram = channel(undefined, 'off');
  telegram.onEvent({ type: 'turn_start', turnId: 'chat-1', session: 'chat', origin: user });
  telegram.onEvent(reply('chat-1', 'The answer'));
  await telegram.drain(1_000);
  assert.equal(sent().length, 2);
  assert.match(sent()[1]?.text ?? '', /^❌ Telegram sendMessage failed \(400\)/);
});

function report(origin: PromptOrigin, ping = pinged): Deliverable {
  return { kind: 'report', text: { format: 'telegram-html', text: '<b>News</b>' }, origin, ping };
}

test('a scheduled report gets its header; other reports go as they are', async (t) => {
  const { sent } = fakeTelegram(t);
  const telegram = channel();
  const cron = { kind: 'cron', taskId: 'task-1' } as const;
  const bash = { kind: 'job-report', source: 'background-bash-report' } as const;

  assert.deepEqual(await telegram.deliver(report(cron)), { channel: TELEGRAM_CHANNEL, ok: true });
  await telegram.deliver(report({ kind: 'heartbeat' }, []));
  await telegram.deliver(report(bash));

  assert.deepEqual(
    sent().map((call) => [call.text, call.silent]),
    [
      ['⏰ <b>Scheduled report</b>\n\n<b>News</b>', false],
      ['<b>News</b>', true],
      ['<b>News</b>', false],
    ],
  );
});

test('a report that fails to send says so in its receipt', async (t) => {
  fakeTelegram(t, { fail: /News/ });
  const receipt = await channel().deliver(report({ kind: 'heartbeat' }));
  assert.equal(receipt.ok, false);
  assert.match(receipt.error ?? '', /chat not found/);
});

test('plain notices are escaped, and follow the order of events', async (t) => {
  const { sent } = fakeTelegram(t);
  const telegram = channel();
  const notice = (text: string) =>
    ({
      type: 'notice',
      text: { format: 'plain', text },
      level: 'info',
      to: 'all',
      ping: pinged,
    }) satisfies CoreEvent;
  telegram.onEvent(notice('✅ Bot is up and running.'));
  telegram.onEvent(notice('🔁 Running post-restart task: a <b> title'));
  await telegram.drain(1_000);
  assert.deepEqual(
    sent().map((call) => call.text),
    ['✅ Bot is up and running.', '🔁 Running post-restart task: a &lt;b&gt; title'],
  );
});

for (const [result, expected] of [
  [{ status: 'queued' }, []],
  [{ status: 'steered' }, ['↪️ Steering current task.']],
  [
    { status: 'rejected', reason: 'queue-full' },
    [`⚠️ Queue full (${MAX_QUEUED_PROMPTS} pending). Wait or use /abort.`],
  ],
  [
    { status: 'rejected', reason: 'error', error: 'steer <rejected>' },
    ['❌ steer &lt;rejected&gt;'],
  ],
] as const) {
  test(`a submit that was ${result.status} ${'reason' in result ? `(${result.reason}) ` : ''}shows its own feedback`, async (t) => {
    const { sent } = fakeTelegram(t);
    const { core, submitted } = fakeCore({ submit: result });
    const telegram = channel(core);
    await telegram.submitInput({ text: 'hello', attachments: [] });
    await telegram.drain(1_000);
    assert.deepEqual(submitted, [{ from: TELEGRAM_CHANNEL, text: 'hello', attachments: [] }]);
    assert.deepEqual(
      sent().map((call) => call.text),
      expected,
    );
  });
}

test('a slash command goes to the core as a command, and an unknown one as a message', async (t) => {
  fakeTelegram(t);
  const known = fakeCore({ command: true });
  await channel(known.core).submitInput({ text: ' /status ', attachments: [] });
  assert.deepEqual(known.commands, ['/status']);
  assert.deepEqual(known.submitted, []);

  const unknown = fakeCore({ command: false });
  await channel(unknown.core).submitInput({ text: '/nosuch', attachments: [] });
  assert.deepEqual(
    unknown.submitted.map((input) => input.text),
    ['/nosuch'],
  );
});

test('a menu answer is submitted as a message, never run as a command', async (t) => {
  fakeTelegram(t);
  const { core, commands, submitted } = fakeCore({ command: true });
  await channel(core).submitAnswer('/looks like a command');
  assert.deepEqual(commands, []);
  assert.deepEqual(
    submitted.map((input) => input.text),
    ['/looks like a command'],
  );
});
