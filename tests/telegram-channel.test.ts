import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { TELEGRAM_CHANNEL, TelegramChannel } from '../src/channels/telegram/channel.ts';
import { createWriteGate } from '../src/channels/telegram/job-progress.ts';
import type { TelegramCallbackQuery } from '../src/channels/telegram/types.ts';
import {
  ALLOWED_CHAT_ID,
  MAX_QUEUED_PROMPTS,
  TOOL_CALL_BATCH_MAX_ITEMS,
  type ToolCallMode,
} from '../src/config.ts';
import type {
  AgentCore,
  BashJobSnapshot,
  ChannelRef,
  ChoiceView,
  CoreEvent,
  Deliverable,
  PromptOrigin,
  SubmitResult,
  UserInput,
} from '../src/contract.ts';

interface ApiCall {
  method: string;
  text?: string;
  /** The message a call edits. */
  messageId?: number;
  /** The keyboard a call sends, as callback data. */
  buttons?: string[][];
  /** For an upload, the file's field and name. */
  file?: string;
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
    const payload = readPayload(init?.body);
    const call: ApiCall = {
      method: String(url).split('/').at(-1) ?? '',
      ...(payload.text !== undefined ? { text: payload.text } : {}),
      ...(payload.message_id !== undefined ? { messageId: payload.message_id } : {}),
      ...(payload.reply_markup
        ? {
            buttons: payload.reply_markup.inline_keyboard.map((row) =>
              row.map((button) => button.callback_data),
            ),
          }
        : {}),
      ...(payload.file ? { file: payload.file } : {}),
      silent: payload.disable_notification === true || payload.disable_notification === 'true',
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

interface Payload {
  text?: string;
  message_id?: number;
  disable_notification?: boolean | string;
  reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> };
  file?: string;
}

/** A JSON body, or a multipart upload's fields with its file as `field:name`. */
function readPayload(body: unknown): Payload {
  if (!(body instanceof FormData)) return JSON.parse(String(body ?? '{}')) as Payload;
  const payload: Payload = {};
  for (const [key, value] of body.entries()) {
    if (typeof value === 'string') {
      if (key === 'caption') payload.text = value;
      if (key === 'disable_notification') payload.disable_notification = value;
    } else {
      payload.file = `${key}:${value.name}`;
    }
  }
  return payload;
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
    commands: () => [],
    choose: async () => {
      throw new Error('unused');
    },
    stopJob: async () => 'not-running',
    beginIngestion: async () => ({ epoch: 0 }),
    attach: () => () => {},
    snapshot: async () => {
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

test('input typed in a terminal is mirrored silently, labelled, with its attachments', async (t) => {
  const { sent } = fakeTelegram(t);
  const telegram = channel(undefined, 'off');
  const terminal: ChannelRef = { id: 'tui:1', kind: 'tui' };
  telegram.onEvent({
    type: 'input',
    from: terminal,
    text: 'look at <this>',
    attachments: ['shot.png'],
    steered: false,
  });
  telegram.onEvent({
    type: 'input',
    from: terminal,
    text: 'and this',
    attachments: [],
    steered: true,
  });
  // Its own input is already in the chat.
  telegram.onEvent({
    type: 'input',
    from: TELEGRAM_CHANNEL,
    text: 'mine',
    attachments: [],
    steered: false,
  });
  await telegram.drain(1_000);
  assert.deepEqual(
    sent().map((call) => [call.text, call.silent]),
    [
      ['🖥 <i>From the terminal:</i>\nlook at &lt;this&gt;\n📎 shot.png', true],
      ['🖥 <i>From the terminal, steering the task under way:</i>\nand this', true],
    ],
  );
});

test("a terminal's turn shows no typing here, and its tool calls go out silently", async (t) => {
  const { calls, sent } = fakeTelegram(t);
  const telegram = channel(undefined, 'stream');
  const terminal: ChannelRef = { id: 'tui:1', kind: 'tui' };
  telegram.onEvent({
    type: 'turn_start',
    turnId: 'chat-1',
    session: 'chat',
    origin: { kind: 'user', channel: terminal },
  });
  telegram.onEvent(toolCall('chat-1', 'ls'));
  telegram.onEvent(reply('chat-1', 'Done', [terminal]));
  await telegram.drain(1_000);
  assert.equal(
    calls.some((call) => call.method === 'sendChatAction'),
    false,
  );
  assert.deepEqual(
    sent().map((call) => [call.text, call.silent]),
    [
      ['🛠 bash (<code>ls</code>)', true],
      ['Done', true],
    ],
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

test("Telegram's own commands are handled here, not by the core", async (t) => {
  const { sent } = fakeTelegram(t);
  const { core, commands, submitted } = fakeCore({ command: true });
  const telegram = channel(core);
  await telegram.submitInput({ text: '/start', attachments: [] });
  await telegram.drain(1_000);
  assert.deepEqual(commands, []);
  assert.deepEqual(submitted, []);
  assert.match(sent()[0]?.text ?? '', /^👋 Hi!/);
});

function tap(data: string, messageId: number): TelegramCallbackQuery {
  return {
    id: `tap-${messageId}`,
    from: { id: 1 },
    data,
    message: {
      message_id: messageId,
      chat: { id: Number(ALLOWED_CHAT_ID), type: 'private' },
      date: 0,
    },
  };
}

const MENU: ChoiceView = {
  id: 'm1',
  text: { format: 'plain', text: 'Pick <one>' },
  options: ['A', 'B', 'C'],
  columns: 2,
  cancellable: true,
  audience: 'all',
};

test('a core menu is a keyboard whose taps go to the core, and every copy closes', async (t) => {
  const { calls, sent } = fakeTelegram(t);
  const chosen: Array<[string, number | 'cancel']> = [];
  let telegram: TelegramChannel | null = null;
  const core: AgentCore = {
    ...fakeCore().core,
    async choose(choiceId, option, from) {
      chosen.push([choiceId, option]);
      const text = { format: 'plain', text: '✅ Picked <B>' } as const;
      // As the core does: every channel hears the menu close before the answer returns.
      telegram?.onEvent({ type: 'choice_closed', choiceId, text, by: from });
      return { toast: 'Picked', text, closed: true, submitted: { status: 'steered' } };
    },
  };
  telegram = channel(core);
  assert.deepEqual(await telegram.deliver({ kind: 'choice', choice: MENU, ping: pinged }), {
    channel: TELEGRAM_CHANNEL,
    ok: true,
  });
  await telegram.deliver({ kind: 'choice', choice: MENU, ping: [] });
  const [first, second] = sent();
  assert.equal(first?.text, 'Pick &lt;one&gt;');
  assert.deepEqual(first?.buttons, [['ch:m1:0', 'ch:m1:1'], ['ch:m1:2'], ['ch:m1:cancel']]);
  assert.equal(second?.silent, true);

  await telegram.handleCallbackQuery(tap('ch:m1:1', 1));
  await telegram.drain(1_000);
  assert.deepEqual(chosen, [['m1', 1]]);
  const edits = calls.filter((call) => call.method === 'editMessageText');
  assert.deepEqual(
    edits.map((call) => [call.messageId, call.text, call.buttons]),
    [
      [1, '✅ Picked &lt;B&gt;', undefined],
      [2, '✅ Picked &lt;B&gt;', undefined],
    ],
  );
  assert.equal(calls.find((call) => call.method === 'answerCallbackQuery') !== undefined, true);
  // The answer was submitted as a message that steered the turn under way.
  assert.equal(sent().at(-1)?.text, '↪️ Steering current task.');
});

test('a tap on a menu the core no longer knows closes only the copy tapped', async (t) => {
  const { calls } = fakeTelegram(t);
  const core: AgentCore = {
    ...fakeCore().core,
    choose: async () => ({
      toast: 'Menu expired.',
      text: { format: 'plain', text: '⏱ gone' },
      closed: false,
    }),
  };
  const telegram = channel(core);
  await telegram.handleCallbackQuery(tap('ch:old:0', 7));
  await telegram.drain(1_000);
  assert.deepEqual(
    calls
      .filter((call) => call.method === 'editMessageText')
      .map((call) => [call.messageId, call.text]),
    [[7, '⏱ gone']],
  );
});

test('files and voice notes are uploaded, silently when they alert no one', async (t) => {
  const { calls } = fakeTelegram(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-telegram-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (name: string) => {
    const full = path.join(dir, name);
    fs.writeFileSync(full, 'content');
    return full;
  };
  const telegram = channel();
  const deliveries: Deliverable[] = [
    { kind: 'image', path: file('chart.png'), caption: 'a <chart>', ping: pinged },
    { kind: 'document', path: file('notes.md'), ping: [] },
    { kind: 'voice', text: 'hello', path: file('note.ogg'), ping: pinged },
    { kind: 'voice', text: 'no <audio>', ping: pinged },
  ];
  for (const item of deliveries) {
    assert.equal((await telegram.deliver(item)).ok, true, item.kind);
  }
  assert.deepEqual(
    calls.map((call) => [call.method, call.file ?? call.text, call.silent]),
    [
      ['sendPhoto', 'photo:chart.png', false],
      ['sendDocument', 'document:notes.md', true],
      ['sendVoice', 'voice:pi-reply.ogg', false],
      ['sendMessage', '🔊 no &lt;audio&gt;', false],
    ],
  );
  assert.equal(calls[0]?.text, 'a &lt;chart&gt;', 'the caption is escaped for Telegram');
});

function bashJob(overrides: Partial<BashJobSnapshot> = {}): BashJobSnapshot {
  return {
    kind: 'bash',
    id: 'bg_abc123',
    command: 'npm test',
    status: 'running',
    statusText: 'running',
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    stopRequested: false,
    lastLine: null,
    ...overrides,
  };
}

test("a job's message follows its snapshots, and its last write holds what comes after", async (t) => {
  const { calls } = fakeTelegram(t);
  const stops: Array<[string, number | undefined]> = [];
  const core: AgentCore = {
    ...fakeCore().core,
    async stopJob(jobId, task) {
      stops.push([jobId, task]);
      return 'stopping';
    },
  };
  const telegram = new TelegramChannel({
    core,
    cwd: '/unused',
    toolCallMode: () => 'off',
    subagentToolCalls: () => false,
    progressOptions: { minIntervalMs: 1, heartbeatMs: 60_000, gate: createWriteGate(0) },
  });
  telegram.onEvent({ type: 'job', job: bashJob() });
  await until(() => calls.length === 1);
  assert.match(calls[0]?.text ?? '', /^⏳ <b>Background bash<\/b> · running/);
  assert.deepEqual(calls[0]?.buttons, [['stop:bg_abc123']]);

  await telegram.handleCallbackQuery(tap('stop:bg_abc123', 1));
  assert.deepEqual(stops, [['bg_abc123', undefined]]);

  const ended = bashJob({
    status: 'exited',
    exitCode: 0,
    statusText: 'exited with code 0',
    endedAt: Date.now(),
  });
  telegram.onEvent({ type: 'job', job: ended, final: true });
  telegram.onEvent({
    type: 'notice',
    text: { format: 'plain', text: 'after the job' },
    level: 'info',
    to: 'all',
    ping: pinged,
  });
  await telegram.drain(1_000);
  const writes = calls.filter((call) => call.method !== 'answerCallbackQuery');
  assert.match(writes.at(-2)?.text ?? '', /^✅ <b>Background bash<\/b> · exited with code 0/);
  assert.equal(writes.at(-1)?.text, 'after the job');
});

test("Telegram's /status section lists its own display settings", () => {
  const telegram = new TelegramChannel({
    core: fakeCore().core,
    cwd: '/unused',
    toolCallMode: () => 'stream',
    subagentToolCalls: () => true,
    showTranscripts: () => false,
  });
  assert.deepEqual(telegram.status(), {
    title: 'Telegram',
    settings: [
      { label: 'Sub-agent tool calls', on: true },
      { label: 'Voice transcripts', on: false },
      { label: '🛠 Tool calls', detail: 'Stream — a message per batch' },
    ],
  });
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('condition not reached');
}
