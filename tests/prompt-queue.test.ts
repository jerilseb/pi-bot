import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { BackgroundOutbox, setBackgroundOutbox } from '../src/background-outbox.ts';
import { createChatSession } from '../src/chat-session.ts';
import { CRON_NOOP, MAX_QUEUED_PROMPTS } from '../src/config.ts';
import type { ChannelRef, PromptOrigin } from '../src/contract.ts';
import { LocalCore } from '../src/core.ts';
import type { PiRunPromptOptions, PiRuntime, SdkPiSession } from '../src/pi-session.ts';
import type { Attachment, IncomingPrompt } from '../src/types.ts';
import { RecordingChannel } from './recording-channel.ts';

const USER: ChannelRef = { id: 'test', kind: 'telegram' };
const userOrigin: PromptOrigin = { kind: 'user', channel: USER };

function runtime(): PiRuntime {
  return {
    modelName: 'test/model',
    get modelRuntime(): never {
      throw new Error('Unexpected SDK startup');
    },
    get settingsManager(): never {
      throw new Error('Unexpected settings access');
    },
    cwd: '/unused',
    sessionDir: '/unused',
    sessionPrefix: 'test',
    sessionPerPrompt: false,
    sessionKind: 'chat',
    getExtensionPaths: () => [],
    systemPromptOverride: () => '',
    extensionFactories: [],
  };
}

/**
 * Puts the real runPrompt back on `pi`, over a fake SDK session that emits
 * `events`, so a test sees the reply exactly as runPrompt builds it. The fake
 * is wired the way start() wires a real session, so its events reach the core.
 */
function useRealRunPrompt(pi: SdkPiSession, events: AgentSessionEvent[]): void {
  (pi.runPrompt as unknown as { mock: { restore(): void } }).mock.restore();
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session = {
    isStreaming: false,
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const event of events) for (const listener of [...listeners]) listener(event);
    },
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [],
    async abort() {},
    dispose() {},
  };
  Object.assign(pi, { session });
  (pi as unknown as { forwardEvents(session: unknown): void }).forwardEvents(session);
}

const assistantStart = {
  type: 'message_start',
  message: { role: 'assistant', content: [] },
} as unknown as AgentSessionEvent;
const runEnd = { type: 'agent_end', messages: [], willRetry: false } as AgentSessionEvent;
const textDelta = (text: string) =>
  ({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: text },
  }) as AgentSessionEvent;

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('queue did not settle');
}

function setup(t: TestContext) {
  const chatSession = createChatSession(runtime());
  const backgroundSession = createChatSession(runtime());
  const chat = chatSession.get();
  const background = backgroundSession.get();
  let resolveGate = () => {};
  const gate = {
    promise: new Promise<void>((resolve) => {
      resolveGate = resolve;
    }),
    resolve: () => resolveGate(),
  };
  // Commands still send their own output straight to Telegram.
  const commandMessages: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { text?: string };
    if (payload.text) commandMessages.push(payload.text);
    return Response.json({ ok: true, result: { message_id: commandMessages.length } });
  });
  const runs: string[] = [];
  let options: PiRunPromptOptions | undefined;
  t.mock.method(
    chat.pi,
    'runPrompt',
    async (text: string, _attachments: Attachment[], opts?: PiRunPromptOptions) => {
      runs.push(text);
      options = opts;
      if (runs.length === 1) await gate.promise;
      return { text: `answer: ${text}` };
    },
  );
  const steer = t.mock.method(chat.pi, 'trySteer', async () => true);
  const backgroundRuns: string[] = [];
  let backgroundOptions: PiRunPromptOptions | undefined;
  t.mock.method(
    background.pi,
    'runPrompt',
    async (text: string, _attachments: Attachment[], opts?: PiRunPromptOptions) => {
      backgroundRuns.push(text);
      backgroundOptions = opts;
      await gate.promise;
      return { text: 'background answer' };
    },
  );
  const backgroundSteer = t.mock.method(background.pi, 'trySteer', async () => true);
  const abort = t.mock.method(chat.pi, 'abort', () => {});
  const note = t.mock.method(chat.pi, 'noteEvent', async () => {});
  t.mock.method(chat.pi, 'getThinkingState', async () => ({
    level: 'medium' as const,
    availableLevels: ['medium' as const],
  }));
  t.mock.method(chat.pi, 'requestNewSession', async () => 'reset');
  let running = true;
  const core = new LocalCore({
    chatSession,
    backgroundSession,
    restart: async () => {},
    isRunning: () => running,
  });
  const channel = new RecordingChannel(USER);
  core.attach(channel);
  t.after(async () => {
    gate.resolve();
    await until(() => !core.isAssistantBusy());
  });
  /** User input as a channel sends it: a command when the core knows it, otherwise a message. */
  const send = async (text: string) => {
    if (text.startsWith('/') && (await core.command(text, USER))) return null;
    return core.submit({ from: USER, text, attachments: [] });
  };
  const enqueue = (text: string, origin: PromptOrigin, extra: Partial<IncomingPrompt> = {}) =>
    core.enqueue({ text, attachments: [], origin, ...extra });
  return {
    chat,
    background,
    core,
    channel,
    send,
    enqueue,
    gate,
    runs,
    backgroundRuns,
    steer,
    backgroundSteer,
    abort,
    note,
    commandMessages,
    stop: () => {
      running = false;
    },
    options: () => options,
    backgroundOptions: () => backgroundOptions,
  };
}

const bashReport = { kind: 'job-report', source: 'background-bash-report' } as const;
const subagentReport = { kind: 'job-report', source: 'subagent-report' } as const;
const cron = { kind: 'cron', taskId: 'task-1' } as const;

test('ordinary messages steer an active run instead of starting a second response', async (t) => {
  const f = setup(t);
  assert.deepEqual(await f.send('first'), { status: 'queued' });
  assert.deepEqual(await f.send('change direction'), { status: 'steered' });
  assert.equal(f.steer.mock.callCount(), 1);
  assert.equal(f.steer.mock.calls[0]?.arguments[0]?.text, 'change direction');
  assert.deepEqual(f.steer.mock.calls[0]?.arguments[0]?.origin, userOrigin);
  assert.deepEqual(f.runs, ['first']);
  assert.deepEqual(f.chat.queue, []);
  assert.equal(f.chat.messageCount, 2);
  assert.deepEqual(
    f.channel.of('input').map(({ text, steered }) => ({ text, steered })),
    [
      { text: 'first', steered: false },
      { text: 'change direction', steered: true },
    ],
  );
});

test('idle messages use the normal prompt worker with foreground recovery', async (t) => {
  const f = setup(t);
  await f.send('first');
  assert.equal(f.steer.mock.callCount(), 0);
  assert.deepEqual(f.runs, ['first']);
  assert.equal(f.options()?.recoverTransportErrors, true);
  await f.options()?.onAutoRecovery?.('WebSocket error');
  const [notice] = f.channel.of('notice');
  assert.equal(notice?.text.text, '🔄 Temporary model error. Continuing automatically...');
  assert.deepEqual(notice?.ping, [USER]);
});

test('a turn is its start, the SDK events it caused, and its end, under one ID', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  useRealRunPrompt(f.chat.pi, [assistantStart, textDelta('Hi'), runEnd]);
  await f.send('hello');
  await until(() => !f.core.isAssistantBusy());

  const [start] = f.channel.of('turn_start');
  assert.deepEqual(start?.origin, userOrigin);
  assert.equal(start?.session, 'chat');
  const agent = f.channel.of('agent');
  assert.deepEqual(
    agent.map((event) => event.event.type),
    ['message_start', 'message_update', 'agent_end'],
  );
  assert.ok(agent.every((event) => event.turnId === start?.turnId));
  const [end] = f.channel.of('turn_end');
  assert.equal(end?.turnId, start?.turnId);
  assert.equal(end?.outcome, 'replied');
  assert.deepEqual(end?.ping, [USER]);
  assert.deepEqual(f.channel.replies(), ['Hi']);
  // Ordered: nothing of a turn arrives after its end.
  const types = f.channel.events.map((event) => event.type).filter((type) => type !== 'state');
  assert.equal(types.at(-1), 'turn_end');
});

test('a turn that fails ends with its error', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  t.mock.method(console, 'error', () => {});
  t.mock.method(f.chat.pi, 'runPrompt', async () => {
    throw new Error('model unavailable');
  });
  await f.send('hello');
  await until(() => !f.core.isAssistantBusy());
  const [end] = f.channel.of('turn_end');
  assert.equal(end?.outcome, 'error');
  assert.equal(end?.outcome === 'error' && end.error, 'model unavailable');
});

test('startup and finish races fall back to FIFO exactly once', async (t) => {
  const f = setup(t);
  f.steer.mock.mockImplementation(async () => false);
  await f.send('first');
  assert.deepEqual(await f.send('second'), { status: 'queued' });
  assert.deepEqual(
    f.chat.queue.map((prompt) => prompt.text),
    ['second'],
  );
  f.gate.resolve();
  await until(() => !f.core.isAssistantBusy());
  assert.deepEqual(f.runs, ['first', 'second']);
});

test('background jobs and completion reports never steer', async (t) => {
  const f = setup(t);
  await f.send('first');
  await f.enqueue('shell done', bashReport);
  await f.enqueue('workers done', subagentReport);
  await f.enqueue('cron task', cron);
  await f.enqueue('heartbeat task', { kind: 'heartbeat' });
  assert.equal(f.steer.mock.callCount(), 0);
  assert.equal(f.backgroundSteer.mock.callCount(), 0);
  assert.deepEqual(
    f.chat.queue.map((prompt) => prompt.text),
    ['shell done', 'workers done'],
  );
  assert.deepEqual(f.backgroundRuns, ['cron task']);
  assert.equal(f.backgroundOptions()?.recoverTransportErrors, undefined);
  assert.equal(f.backgroundOptions()?.onAutoRecovery, undefined);
  assert.deepEqual(
    f.background.queue.map((prompt) => prompt.text),
    ['heartbeat task'],
  );
  // Only user input is echoed as input.
  assert.equal(f.channel.of('input').length, 1);
});

for (const command of ['/abort', '/new']) {
  test(`${command} bypasses steering and clears deferred work`, async (t) => {
    const f = setup(t);
    await f.send('first');
    f.options()?.onSteeringSettled?.(
      { text: 'late steer', attachments: [], origin: userOrigin },
      'deferred',
    );
    assert.equal(f.chat.queue.length, 1);
    assert.equal(await f.send(command), null);
    if (command === '/new') {
      assert.ok(f.commandMessages.some((message) => message.includes('Reasoning: <b>medium</b>')));
    }
    assert.equal(f.abort.mock.callCount(), 1);
    assert.equal(f.steer.mock.callCount(), 0);
    assert.deepEqual(f.chat.queue, []);
    f.gate.resolve();
    await until(() => !f.core.isAssistantBusy());
    assert.deepEqual(f.runs, ['first']);
  });
}

for (const interrupted of [true, false]) {
  test(`/abort notes a cut-short turn only when one was under way (${interrupted})`, async (t) => {
    const f = setup(t);
    await f.send('first');
    // False when the session was still starting or the reply was already done.
    f.abort.mock.mockImplementation(() => interrupted);
    await f.send('/abort');
    const notes = f.note.mock.calls.filter((call) => call.arguments[0] === 'abort');
    assert.equal(notes.length, interrupted ? 1 : 0);
  });
}

test('an unknown command is a message, queued rather than steered', async (t) => {
  const f = setup(t);
  await f.send('first');
  assert.deepEqual(await f.send('/nosuchcommand'), { status: 'queued' });
  assert.equal(f.steer.mock.callCount(), 0);
  assert.deepEqual(
    f.chat.queue.map((prompt) => prompt.text),
    ['/nosuchcommand'],
  );
});

test('pending steering counts toward the existing queue limit', async (t) => {
  const f = setup(t);
  await f.send('first');
  t.mock.getter(f.chat.pi, 'pendingSteeringCount', () => MAX_QUEUED_PROMPTS);
  assert.deepEqual(await f.send('one too many'), { status: 'rejected', reason: 'queue-full' });
  assert.equal(f.steer.mock.callCount(), 0);
  assert.equal(f.chat.messageCount, 1);
});

test('completion reports are admitted when the queue is full', async (t) => {
  const f = setup(t);
  await f.send('first');
  t.mock.getter(f.chat.pi, 'pendingSteeringCount', () => MAX_QUEUED_PROMPTS);
  assert.deepEqual(await f.enqueue('shell done', bashReport), { status: 'queued' });
  assert.deepEqual(await f.enqueue('workers done', subagentReport), { status: 'queued' });
  assert.deepEqual(
    f.chat.queue.map((prompt) => prompt.text),
    ['shell done', 'workers done'],
  );
});

test('nothing is queued once the bot is shutting down', async (t) => {
  const f = setup(t);
  f.stop();
  assert.deepEqual(await f.send('too late'), { status: 'rejected', reason: 'shutting-down' });
  assert.deepEqual(f.runs, []);
  assert.deepEqual(f.chat.queue, []);
});

test('a queued report whose result was read meanwhile is dropped when its turn comes', async (t) => {
  const f = setup(t);
  await f.send('poll the command');
  let read = false;
  const report = (text: string, isSuperseded: () => boolean) =>
    f.enqueue(text, bashReport, { suppressNoop: true, isSuperseded });
  await report('bg_1 finished', () => read);
  await report('bg_2 finished', () => false);
  // Queued before the agent read the result, so the check has to wait until now.
  read = true;
  f.gate.resolve();
  await until(() => !f.core.isAssistantBusy());
  assert.deepEqual(f.runs, ['poll the command', 'bg_2 finished']);
});

test('late steering is replayed before fallback queued prompts', async (t) => {
  const f = setup(t);
  await f.send('first');
  f.steer.mock.mockImplementation(async () => false);
  await f.send('queued at shutdown');
  const late = (text: string): IncomingPrompt => ({ text, attachments: [], origin: userOrigin });
  f.options()?.onSteeringSettled?.(late('late steer 1'), 'deferred');
  f.options()?.onSteeringSettled?.(late('late steer 2'), 'deferred');
  f.gate.resolve();
  await until(() => !f.core.isAssistantBusy());
  assert.deepEqual(f.runs, ['first', 'late steer 1', 'late steer 2', 'queued at shutdown']);
});

test('rejected steering reports an error without retrying it as a new prompt', async (t) => {
  const f = setup(t);
  await f.send('first');
  f.steer.mock.mockImplementation(async () => {
    throw new Error('steer rejected');
  });
  assert.deepEqual(await f.send('bad message'), {
    status: 'rejected',
    reason: 'error',
    error: 'steer rejected',
  });
  assert.deepEqual(f.chat.queue, []);
  assert.equal(f.chat.messageCount, 1);
});

test('a delivered scheduled-task report is noted in the chat session', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  const useModel = t.mock.method(f.background.pi, 'useModel', async () => {});
  await f.enqueue('run the check', cron, {
    suppressNoop: true,
    model: 'test/cron-model',
    label: 'Morning check',
  });
  await until(() => !f.core.isAssistantBusy());

  assert.equal(f.backgroundRuns.length, 1);
  assert.equal(useModel.mock.calls[0]?.arguments[0], 'test/cron-model');
  assert.equal(f.note.mock.callCount(), 1);
  const [kind, text] = f.note.mock.calls[0]?.arguments as [string, string];
  assert.equal(kind, 'scheduled-task');
  assert.match(text, /"Morning check"/);
  assert.match(text, /test\/cron-model/);
  assert.match(text, /background answer/);
  // The report reaches the channels as a delivery, not as a chat reply.
  assert.deepEqual(f.channel.reports(), ['background answer']);
  assert.deepEqual(f.channel.deliveries[0]?.origin, cron);
  assert.equal(f.channel.deliveries[0]?.label, 'Morning check');
  assert.deepEqual(f.channel.replies(), []);
});

test('a report no channel took is not noted, and its failure is reported', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  t.mock.method(f.background.pi, 'useModel', async () => {});
  t.mock.method(console, 'error', () => {});
  f.channel.receipt = () => ({ ok: false, error: 'Telegram sendMessage failed (400)' });
  await f.enqueue('run the check', cron, { suppressNoop: true, model: 'test/cron-model' });
  await until(() => !f.core.isAssistantBusy());

  assert.equal(f.note.mock.callCount(), 0);
  assert.deepEqual(f.channel.notices(), ['❌ Telegram sendMessage failed (400)']);
});

test('an unprompted report alerts the channel used last, or every durable one', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  t.mock.method(f.background.pi, 'useModel', async () => {});
  const other = new RecordingChannel({ id: 'tui:1', kind: 'tui' }, false);
  f.core.attach(other);
  // Nobody has acted yet: only the durable channel is alerted.
  await f.enqueue('run the check', cron, { suppressNoop: true, model: 'test/m' });
  await until(() => !f.core.isAssistantBusy());
  assert.deepEqual(f.channel.deliveries[0]?.ping, [USER]);
  assert.deepEqual(other.deliveries[0]?.ping, [USER]);

  await f.core.command('/help', other.ref);
  await f.enqueue('run it again', cron, { suppressNoop: true, model: 'test/m' });
  await until(() => !f.core.isAssistantBusy());
  assert.deepEqual(f.channel.deliveries[1]?.ping, [other.ref]);
});

test('a background-bash report returns to the session that started the command', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  const useModel = t.mock.method(f.background.pi, 'useModel', async () => {});
  await f.enqueue('bg_1 finished', bashReport, {
    session: 'background',
    suppressNoop: true,
    model: 'test/job-model',
  });
  await until(() => !f.core.isAssistantBusy());

  assert.deepEqual(f.runs, []);
  assert.deepEqual(f.backgroundRuns, ['bg_1 finished']);
  assert.equal(useModel.mock.calls[0]?.arguments[0], 'test/job-model');
  // Unattended: no foreground recovery.
  assert.equal(f.backgroundOptions()?.recoverTransportErrors, undefined);
  // The user got a message from the background session, so the chat is told.
  assert.equal(f.note.mock.callCount(), 1);
  const [kind, text] = f.note.mock.calls[0]?.arguments as [string, string];
  assert.equal(kind, 'background-bash');
  assert.match(text, /background command/);
  assert.match(text, /test\/job-model/);
  assert.match(text, /background answer/);
});

test('a background-bash report answered in the chat session leaves no note', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  await f.enqueue('bg_3 finished', bashReport, { session: 'chat', suppressNoop: true });
  await until(() => !f.core.isAssistantBusy());
  assert.ok(f.channel.replies().some((reply) => reply.includes('bg_3 finished')));
  assert.equal(f.note.mock.callCount(), 0);
});

test('a delivered heartbeat message is noted in the chat session', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  t.mock.method(f.background.pi, 'useModel', async () => {});
  await f.enqueue(
    'check things',
    { kind: 'heartbeat' },
    { suppressNoop: true, model: 'test/heartbeat-model' },
  );
  await until(() => !f.core.isAssistantBusy());
  const [kind, text] = f.note.mock.calls[0]?.arguments as [string, string];
  assert.equal(kind, 'heartbeat');
  assert.match(text, /heartbeat run on test\/heartbeat-model/);
  assert.match(text, /background answer/);
});

test('a background-bash report from the chat runs in the chat session', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  await f.enqueue('bg_2 finished', bashReport, { session: 'chat', suppressNoop: true });
  await until(() => !f.core.isAssistantBusy());

  assert.deepEqual(f.runs, ['bg_2 finished']);
  assert.deepEqual(f.backgroundRuns, []);
  assert.equal(f.options()?.recoverTransportErrors, true);
});

test('a scheduled task that reports nothing leaves no note in the chat session', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  t.mock.method(f.background.pi, 'runPrompt', async () => ({ text: CRON_NOOP }));
  await f.enqueue('run the check', cron, { suppressNoop: true, label: 'Quiet check' });
  await until(() => !f.core.isAssistantBusy());

  assert.equal(f.note.mock.callCount(), 0);
  assert.deepEqual(f.channel.deliveries, []);
  assert.equal(f.channel.of('turn_end')[0]?.outcome, 'silent');
});

for (const [name, events] of [
  // Once sent as "(no response)": runPrompt filled in the placeholder itself.
  ['says nothing', [assistantStart, runEnd]],
  // Once sent as "Checking state.__CRON_NOOP__", which no longer matched.
  [
    'narrates, then answers with the sentinel',
    [assistantStart, textDelta('Checking state.'), assistantStart, textDelta(CRON_NOOP), runEnd],
  ],
] as const) {
  test(`a scheduled task that ${name} sends nothing and leaves no note`, async (t) => {
    const f = setup(t);
    f.gate.resolve();
    useRealRunPrompt(f.background.pi, [...events]);
    await f.enqueue('run the check', cron, { suppressNoop: true, label: 'Quiet check' });
    await until(() => !f.core.isAssistantBusy());

    assert.equal(f.note.mock.callCount(), 0);
    assert.deepEqual(f.channel.deliveries, []);
    assert.deepEqual(f.channel.notices(), []);
  });
}

test('a chat reply that says nothing still answers the user', async (t) => {
  const f = setup(t);
  useRealRunPrompt(f.chat.pi, [assistantStart, runEnd]);
  await f.send('hello');
  await until(() => !f.core.isAssistantBusy());
  assert.deepEqual(f.channel.replies(), ['(no response)']);
});

test('post-restart tasks queue behind an active run instead of steering it', async (t) => {
  const f = setup(t);
  await f.enqueue('first task', { kind: 'post-restart', taskId: 'a' });
  await f.enqueue('second task', { kind: 'post-restart', taskId: 'b' });
  assert.equal(f.steer.mock.callCount(), 0);
  assert.equal(f.chat.queue.length, 1);
  f.gate.resolve();
  await until(() => !f.core.isAssistantBusy());
  assert.deepEqual(f.runs, ['first task', 'second task']);
});

test('a background report waits for the chat cooldown, and is noted only once delivered', async (t) => {
  const f = setup(t);
  t.mock.method(f.background.pi, 'useModel', async () => {});
  t.mock.method(console, 'log', () => {});
  let clock = 0;
  const outbox = new BackgroundOutbox({
    isChatBusy: () => f.chat.processing || f.chat.queue.length > 0,
    cooldownMs: 1_000,
    pollMs: 1,
    now: () => clock,
  });
  setBackgroundOutbox(outbox);
  t.after(() => {
    outbox.stop();
    setBackgroundOutbox(null);
  });

  f.gate.resolve();
  await f.enqueue('run the check', cron, {
    suppressNoop: true,
    model: 'test/cron-model',
    label: 'Morning check',
  });
  await until(() => !f.core.isAssistantBusy());

  // The run finished, but the chat was active less than a cooldown ago.
  assert.equal(f.backgroundRuns.length, 1);
  assert.equal(outbox.heldCount, 1);
  assert.deepEqual(f.channel.deliveries, []);
  assert.equal(f.note.mock.callCount(), 0);

  clock = 1_000;
  // The outbox rechecks on a timer, which setImmediate-based waiting outruns.
  for (let i = 0; i < 100 && f.note.mock.callCount() === 0; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(outbox.heldCount, 0);
  assert.equal(f.note.mock.callCount(), 1);
  assert.deepEqual(f.channel.reports(), ['background answer']);
});
