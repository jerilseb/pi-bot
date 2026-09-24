import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { BackgroundOutbox, setBackgroundOutbox } from '../src/background-outbox.ts';
import { createChatSession } from '../src/chat-session.ts';
import { CRON_NOOP, MAX_QUEUED_PROMPTS } from '../src/config.ts';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { PiRunPromptOptions, PiRuntime, SdkPiSession } from '../src/pi-session.ts';
import { createPromptQueue } from '../src/prompt-queue.ts';
import type { Attachment, IncomingPrompt } from '../src/types.ts';

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
 * `events`, so a test sees the reply exactly as runPrompt builds it.
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
      for (const event of events) for (const listener of listeners) listener(event);
    },
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [],
    async abort() {},
    dispose() {},
  };
  Object.assign(pi, { session });
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
  const messages: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { text?: string };
    if (payload.text) messages.push(payload.text);
    return Response.json({ ok: true, result: { message_id: messages.length } });
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
  const queue = createPromptQueue({
    chatSession,
    backgroundSession,
    restart: async () => {},
    isRunning: () => true,
  });
  t.after(async () => {
    gate.resolve();
    await until(() => !queue.isAssistantBusy());
  });
  const send = (text: string, source?: IncomingPrompt['source']) =>
    queue.handleIncoming({ text, attachments: [], ...(source ? { source } : {}) });
  return {
    chat,
    background,
    queue,
    send,
    gate,
    runs,
    backgroundRuns,
    steer,
    backgroundSteer,
    abort,
    note,
    messages,
    options: () => options,
    backgroundOptions: () => backgroundOptions,
  };
}

test('ordinary messages steer an active run instead of starting a second response', async (t) => {
  const f = setup(t);
  await f.send('first');
  await f.send('change direction');
  assert.equal(f.steer.mock.callCount(), 1);
  assert.equal(f.steer.mock.calls[0]?.arguments[0]?.text, 'change direction');
  assert.deepEqual(f.runs, ['first']);
  assert.deepEqual(f.chat.queue, []);
  assert.equal(f.chat.messageCount, 2);
  assert.ok(f.messages.includes('↪️ Steering current task.'));
});

test('idle messages use the normal prompt worker with foreground recovery', async (t) => {
  const f = setup(t);
  await f.send('first');
  assert.equal(f.steer.mock.callCount(), 0);
  assert.deepEqual(f.runs, ['first']);
  assert.equal(f.options()?.recoverTransportErrors, true);
  f.options()?.onAutoRecovery?.('WebSocket error');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(f.messages.includes('🔄 Temporary model error. Continuing automatically...'));
});

test('startup and finish races fall back to FIFO exactly once', async (t) => {
  const f = setup(t);
  f.steer.mock.mockImplementation(async () => false);
  await f.send('first');
  await f.send('second');
  assert.deepEqual(
    f.chat.queue.map((prompt) => prompt.text),
    ['second'],
  );
  f.gate.resolve();
  await until(() => !f.queue.isAssistantBusy());
  assert.deepEqual(f.runs, ['first', 'second']);
});

test('background jobs and completion reports never steer', async (t) => {
  const f = setup(t);
  await f.send('first');
  await f.send('shell done', 'background-bash-report');
  await f.send('workers done', 'subagent-report');
  await f.send('cron task', 'cron');
  await f.send('heartbeat task', 'heartbeat');
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
});

for (const command of ['/abort', '/new']) {
  test(`${command} bypasses steering and clears deferred work`, async (t) => {
    const f = setup(t);
    await f.send('first');
    f.options()?.onSteeringSettled?.({ text: 'late steer', attachments: [] }, 'deferred');
    assert.equal(f.chat.queue.length, 1);
    await f.send(command);
    if (command === '/new') {
      assert.ok(f.messages.some((message) => message.includes('Reasoning: <b>medium</b>')));
    }
    assert.equal(f.abort.mock.callCount(), 1);
    assert.equal(f.steer.mock.callCount(), 0);
    assert.deepEqual(f.chat.queue, []);
    f.gate.resolve();
    await until(() => !f.queue.isAssistantBusy());
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

test('pending steering counts toward the existing queue limit', async (t) => {
  const f = setup(t);
  await f.send('first');
  t.mock.getter(f.chat.pi, 'pendingSteeringCount', () => MAX_QUEUED_PROMPTS);
  await f.send('one too many');
  assert.equal(f.steer.mock.callCount(), 0);
  assert.ok(f.messages.some((text) => text.includes('Queue full')));
  assert.equal(f.chat.messageCount, 1);
});

test('completion reports are admitted when the queue is full', async (t) => {
  const f = setup(t);
  await f.send('first');
  t.mock.getter(f.chat.pi, 'pendingSteeringCount', () => MAX_QUEUED_PROMPTS);
  await f.send('shell done', 'background-bash-report');
  await f.send('workers done', 'subagent-report');
  assert.deepEqual(
    f.chat.queue.map((prompt) => prompt.text),
    ['shell done', 'workers done'],
  );
  assert.ok(!f.messages.some((text) => text.includes('Queue full')));
});

test('a queued report whose result was read meanwhile is dropped when its turn comes', async (t) => {
  const f = setup(t);
  await f.send('poll the command');
  let read = false;
  const report = (text: string, isSuperseded: () => boolean): Promise<void> =>
    f.queue.handleIncoming({
      text,
      attachments: [],
      source: 'background-bash-report',
      suppressNoop: true,
      isSuperseded,
    });
  await report('bg_1 finished', () => read);
  await report('bg_2 finished', () => false);
  // Queued before the agent read the result, so the check has to wait until now.
  read = true;
  f.gate.resolve();
  await until(() => !f.queue.isAssistantBusy());
  assert.deepEqual(f.runs, ['poll the command', 'bg_2 finished']);
});

test('late steering is replayed before fallback queued prompts', async (t) => {
  const f = setup(t);
  await f.send('first');
  f.steer.mock.mockImplementation(async () => false);
  await f.send('queued at shutdown');
  f.options()?.onSteeringSettled?.({ text: 'late steer 1', attachments: [] }, 'deferred');
  f.options()?.onSteeringSettled?.({ text: 'late steer 2', attachments: [] }, 'deferred');
  f.gate.resolve();
  await until(() => !f.queue.isAssistantBusy());
  assert.deepEqual(f.runs, ['first', 'late steer 1', 'late steer 2', 'queued at shutdown']);
});

test('rejected steering reports an error without retrying it as a new prompt', async (t) => {
  const f = setup(t);
  await f.send('first');
  f.steer.mock.mockImplementation(async () => {
    throw new Error('steer rejected');
  });
  await f.send('bad message');
  assert.deepEqual(f.chat.queue, []);
  assert.equal(f.chat.messageCount, 1);
  assert.ok(f.messages.some((text) => text.includes('steer rejected')));
});

test('a delivered scheduled-task report is noted in the chat session', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  const useModel = t.mock.method(f.background.pi, 'useModel', async () => {});
  await f.queue.handleIncoming({
    text: 'run the check',
    attachments: [],
    source: 'cron',
    suppressNoop: true,
    model: 'test/cron-model',
    label: 'Morning check',
  });
  await until(() => !f.queue.isAssistantBusy());

  assert.equal(f.backgroundRuns.length, 1);
  assert.equal(useModel.mock.calls[0]?.arguments[0], 'test/cron-model');
  assert.equal(f.note.mock.callCount(), 1);
  const [kind, text] = f.note.mock.calls[0]?.arguments as [string, string];
  assert.equal(kind, 'scheduled-task');
  assert.match(text, /"Morning check"/);
  assert.match(text, /test\/cron-model/);
  assert.match(text, /background answer/);
  // The report still reaches Telegram as before.
  assert.ok(f.messages.some((message) => message.includes('background answer')));
});

test('a background-bash report returns to the session that started the command', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  const useModel = t.mock.method(f.background.pi, 'useModel', async () => {});
  await f.queue.handleIncoming({
    text: 'bg_1 finished',
    attachments: [],
    source: 'background-bash-report',
    session: 'background',
    suppressNoop: true,
    model: 'test/job-model',
  });
  await until(() => !f.queue.isAssistantBusy());

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
  await f.queue.handleIncoming({
    text: 'bg_3 finished',
    attachments: [],
    source: 'background-bash-report',
    session: 'chat',
    suppressNoop: true,
  });
  await until(() => !f.queue.isAssistantBusy());
  assert.ok(f.messages.some((message) => message.includes('bg_3 finished')));
  assert.equal(f.note.mock.callCount(), 0);
});

test('a delivered heartbeat message is noted in the chat session', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  t.mock.method(f.background.pi, 'useModel', async () => {});
  await f.queue.handleIncoming({
    text: 'check things',
    attachments: [],
    source: 'heartbeat',
    suppressNoop: true,
    model: 'test/heartbeat-model',
  });
  await until(() => !f.queue.isAssistantBusy());
  const [kind, text] = f.note.mock.calls[0]?.arguments as [string, string];
  assert.equal(kind, 'heartbeat');
  assert.match(text, /heartbeat run on test\/heartbeat-model/);
  assert.match(text, /background answer/);
});

test('a background-bash report from the chat runs in the chat session', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  await f.queue.handleIncoming({
    text: 'bg_2 finished',
    attachments: [],
    source: 'background-bash-report',
    session: 'chat',
    suppressNoop: true,
  });
  await until(() => !f.queue.isAssistantBusy());

  assert.deepEqual(f.runs, ['bg_2 finished']);
  assert.deepEqual(f.backgroundRuns, []);
  assert.equal(f.options()?.recoverTransportErrors, true);
});

test('a scheduled task that reports nothing leaves no note in the chat session', async (t) => {
  const f = setup(t);
  f.gate.resolve();
  t.mock.method(f.background.pi, 'runPrompt', async () => ({ text: CRON_NOOP }));
  await f.queue.handleIncoming({
    text: 'run the check',
    attachments: [],
    source: 'cron',
    suppressNoop: true,
    label: 'Quiet check',
  });
  await until(() => !f.queue.isAssistantBusy());

  assert.equal(f.note.mock.callCount(), 0);
  assert.equal(f.messages.length, 0);
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
    await f.queue.handleIncoming({
      text: 'run the check',
      attachments: [],
      source: 'cron',
      suppressNoop: true,
      label: 'Quiet check',
    });
    await until(() => !f.queue.isAssistantBusy());

    assert.equal(f.note.mock.callCount(), 0);
    assert.deepEqual(f.messages, []);
  });
}

test('a chat reply that says nothing still answers the user', async (t) => {
  const f = setup(t);
  useRealRunPrompt(f.chat.pi, [assistantStart, runEnd]);
  await f.send('hello');
  await until(() => !f.queue.isAssistantBusy());
  assert.deepEqual(f.messages, ['(no response)']);
});

test('post-restart tasks queue behind an active run instead of steering it', async (t) => {
  const f = setup(t);
  await f.send('first task', 'post-restart');
  await f.send('second task', 'post-restart');
  assert.equal(f.steer.mock.callCount(), 0);
  assert.equal(f.chat.queue.length, 1);
  f.gate.resolve();
  await until(() => !f.queue.isAssistantBusy());
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
  await f.queue.handleIncoming({
    text: 'run the check',
    attachments: [],
    source: 'cron',
    suppressNoop: true,
    model: 'test/cron-model',
    label: 'Morning check',
  });
  await until(() => !f.queue.isAssistantBusy());

  // The run finished, but the chat was active less than a cooldown ago.
  assert.equal(f.backgroundRuns.length, 1);
  assert.equal(outbox.heldCount, 1);
  assert.ok(!f.messages.some((message) => message.includes('background answer')));
  assert.equal(f.note.mock.callCount(), 0);

  clock = 1_000;
  // The outbox rechecks on a timer, which setImmediate-based waiting outruns.
  for (let i = 0; i < 100 && f.note.mock.callCount() === 0; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(outbox.heldCount, 0);
  assert.equal(f.note.mock.callCount(), 1);
  assert.ok(f.messages.some((message) => message.includes('background answer')));
});
