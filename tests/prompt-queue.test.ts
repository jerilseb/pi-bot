import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createChatSession } from '../src/chat-session.ts';
import { MAX_QUEUED_PROMPTS } from '../src/config.ts';
import type { PiRunPromptOptions, PiRuntime } from '../src/pi-session.ts';
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
    getExtensionPaths: () => [],
    getSkillPaths: () => [],
    systemPromptOverride: () => '',
    extensionFactories: [],
  };
}

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
  t.mock.method(background.pi, 'runPrompt', async (text: string) => {
    backgroundRuns.push(text);
    await gate.promise;
    return { text: 'background answer' };
  });
  const backgroundSteer = t.mock.method(background.pi, 'trySteer', async () => true);
  const abort = t.mock.method(chat.pi, 'abort', () => {});
  t.mock.method(chat.pi, 'noteEvent', async () => {});
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
    messages,
    options: () => options,
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

test('idle messages use the normal prompt worker', async (t) => {
  const f = setup(t);
  await f.send('first');
  assert.equal(f.steer.mock.callCount(), 0);
  assert.deepEqual(f.runs, ['first']);
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
  await f.send('cron task', 'cron');
  await f.send('heartbeat task', 'heartbeat');
  assert.equal(f.steer.mock.callCount(), 0);
  assert.equal(f.backgroundSteer.mock.callCount(), 0);
  assert.deepEqual(
    f.chat.queue.map((prompt) => prompt.text),
    ['shell done'],
  );
  assert.deepEqual(f.backgroundRuns, ['cron task']);
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
    assert.equal(f.abort.mock.callCount(), 1);
    assert.equal(f.steer.mock.callCount(), 0);
    assert.deepEqual(f.chat.queue, []);
    f.gate.resolve();
    await until(() => !f.queue.isAssistantBusy());
    assert.deepEqual(f.runs, ['first']);
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
