import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSessionEvent, SessionManager } from '@earendil-works/pi-coding-agent';
import { driveWorkerSession, type PiRuntime, SdkPiSession } from '../src/pi-session.ts';
import type { WorkerRunRequest } from '../src/subagent.ts';

/**
 * Aborts that land before there is anything to abort: while a session is still
 * starting, during the SDK's own setup inside prompt(), or after a run returned
 * but before its reply was delivered. Driven through the real runPrompt, abort,
 * requestNewSession and driveWorkerSession against fake SDK sessions, which also
 * carry the tool-start hook a worker's live progress row is built from.
 */

function runtime(): PiRuntime {
  return {
    modelName: 'test/model',
    cwd: '/unused',
    sessionDir: '/unused',
    sessionPrefix: 'test',
    sessionPerPrompt: false,
    sessionKind: 'chat',
  } as unknown as PiRuntime;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !condition(); attempt++) await Promise.resolve();
  assert.ok(condition(), 'condition never became true');
}

/**
 * A fake AgentSession. prompt() waits for `setup` (standing in for the SDK's
 * async work before the run exists), then emits agent_start and a clean end.
 */
function fakeSession(setup: Promise<void> = Promise.resolve()) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const entries: string[] = [];
  const fake = {
    prompts: [] as string[],
    aborts: 0,
    disposed: false,
    cleared: false,
    isStreaming: false,
    thinkingLevel: 'medium',
    getAvailableThinkingLevels: () => ['off', 'low', 'medium', 'high'],
    sessionManager: {
      getEntries: () => [],
      appendCustomEntry: (type: string) => {
        entries.push(type);
        fake.cleared = true;
      },
    },
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      fake.prompts.push(text);
      await setup;
      for (const listener of listeners) listener({ type: 'agent_start' });
      for (const listener of listeners) {
        listener({ type: 'agent_end', messages: [], willRetry: false } as AgentSessionEvent);
      }
    },
    async abort() {
      fake.aborts++;
    },
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [],
    async steer() {},
    async followUp() {},
    dispose() {
      fake.disposed = true;
    },
  };
  return fake;
}

type FakeSession = ReturnType<typeof fakeSession>;

/** An SdkPiSession whose createSession hands out the given sessions in order. */
function chat(...sessions: Array<FakeSession | Promise<FakeSession>>) {
  const pi = new SdkPiSession(runtime());
  let starts = 0;
  Object.assign(pi, {
    createSession: async () => {
      const next = sessions[starts++];
      assert.ok(next, 'unexpected session start');
      return next;
    },
  });
  return { pi, starts: () => starts };
}

test('an abort while the session is still starting stops the run before its prompt', async () => {
  const starting = deferred<FakeSession>();
  const session = fakeSession();
  const { pi } = chat(starting.promise, session);

  const run = pi.runPrompt('hello', []);
  await Promise.resolve();
  assert.equal(pi.abort(), false, 'no turn had started, so none was cut short');
  starting.resolve(session);

  await assert.rejects(run, /Request was aborted/);
  assert.deepEqual(session.prompts, []);

  // The abort belonged to that run only: the next one goes ahead.
  await pi.runPrompt('next', []);
  assert.deepEqual(session.prompts, ['next']);
});

test("an abort during the SDK's prompt setup is sent again once the run starts", async () => {
  const setup = deferred();
  const session = fakeSession(setup.promise);
  const { pi } = chat(session);

  const run = pi.runPrompt('hello', []);
  await until(() => session.prompts.length === 1);
  assert.equal(pi.abort(), true, 'the prompt was already on its way');
  assert.equal(session.aborts, 1);

  setup.resolve();
  await run;
  assert.equal(session.aborts, 2, 'agent_start re-sent the abort the setup swallowed');
});

test('a run that was not aborted is not aborted when it starts', async () => {
  const session = fakeSession();
  const { pi } = chat(session);
  await pi.runPrompt('hello', []);
  assert.equal(session.aborts, 0);
  assert.equal(pi.abort(), false, 'the reply is done, so no turn was cut short');
});

test('/new while the reply is still being delivered moves the next message to a new conversation', async () => {
  const old = fakeSession();
  const fresh = fakeSession();
  const { pi, starts } = chat(old, fresh);
  await pi.runPrompt('first', []);

  // runPrompt has returned, but the queue is still delivering the reply, so
  // /new only aborts and queues the swap, as src/commands.ts does then.
  pi.abort();
  await pi.requestNewSession();
  assert.equal(old.cleared, true);

  await pi.runPrompt('second', []);
  assert.deepEqual(old.prompts, ['first']);
  assert.deepEqual(fresh.prompts, ['second']);
  assert.equal(old.disposed, true);
  assert.equal(starts(), 2);
});

function workerRequest(signal: AbortSignal): WorkerRunRequest {
  return {
    sessionId: 'worker-1',
    sessionDir: '/unused',
    sessionName: 'worker',
    customType: 'test-worker',
    metadata: {},
    systemPrompt: '',
    task: 'do the task',
    cwd: '/unused',
    model: 'test/model',
    signal,
  };
}

function workerTranscript() {
  const ends: Array<Record<string, unknown>> = [];
  const manager = {
    getSessionFile: () => '/unused/worker-1.jsonl',
    appendCustomEntry: (_type: string, data: Record<string, unknown>) => {
      if (data.event === 'end') ends.push(data);
    },
    appendSessionInfo() {},
  } as unknown as SessionManager;
  return { manager, ends };
}

test('a worker stopped while its session is loading never sends its task', async () => {
  const controller = new AbortController();
  const loading = deferred<FakeSession>();
  const session = fakeSession();
  const { manager, ends } = workerTranscript();

  const run = driveWorkerSession(
    workerRequest(controller.signal),
    manager,
    () => loading.promise as never,
  );
  controller.abort();
  loading.resolve(session);

  await assert.rejects(run, /aborted/);
  assert.deepEqual(session.prompts, []);
  assert.equal(session.disposed, true);
  assert.equal(ends.at(-1)?.status, 'aborted');
});

test("a worker stopped during the SDK's prompt setup is aborted once its run starts", async () => {
  const controller = new AbortController();
  const setup = deferred();
  const session = fakeSession(setup.promise);
  const { manager, ends } = workerTranscript();

  const run = driveWorkerSession(workerRequest(controller.signal), manager, async () => {
    return session as never;
  });
  await until(() => session.prompts.length === 1);
  controller.abort();
  assert.equal(session.aborts, 1);
  setup.resolve();

  await assert.rejects(run, /aborted/);
  assert.equal(session.aborts, 2);
  assert.equal(ends.at(-1)?.status, 'aborted');
});

test('a worker whose session fails to load closes its transcript as failed', async () => {
  const { manager, ends } = workerTranscript();
  const run = driveWorkerSession(workerRequest(new AbortController().signal), manager, () =>
    Promise.reject(new Error('no extensions')),
  );
  await assert.rejects(run, /no extensions/);
  assert.deepEqual(
    { status: ends.at(-1)?.status, error: ends.at(-1)?.error },
    { status: 'failed', error: 'no extensions' },
  );
});

test('a worker reports each tool call it starts, for its progress row', async () => {
  const session = fakeSession();
  // Keeps the driver's listener, so the task can emit a tool call before the run ends.
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const subscribe = session.subscribe.bind(session);
  session.subscribe = (added) => {
    listener = added;
    return subscribe(added);
  };
  const prompt = session.prompt.bind(session);
  session.prompt = async (text: string) => {
    listener?.({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'read',
      args: { path: 'src/cron.ts' },
    } as AgentSessionEvent);
    await prompt(text);
  };
  const started: Array<{ toolName: string; args: unknown }> = [];

  await driveWorkerSession(
    { ...workerRequest(new AbortController().signal), onToolStart: (event) => started.push(event) },
    workerTranscript().manager,
    async () => session as never,
  );
  assert.deepEqual(started, [{ toolName: 'read', args: { path: 'src/cron.ts' } }]);
});
