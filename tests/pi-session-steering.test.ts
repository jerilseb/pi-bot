import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { SdkPiSession, type PiRuntime } from '../src/pi-session.ts';
import type { SteeringDisposition } from '../src/prompt-steering.ts';
import type { IncomingPrompt } from '../src/types.ts';

/** A transport-free SDK double: exercises the real wrapper, not a model/provider. */
function fixture() {
  const runtime: PiRuntime = {
    modelName: 'test/model',
    get modelRuntime(): never {
      throw new Error('Unexpected model runtime access');
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
  const pi = new SdkPiSession(runtime);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const emit = (event: AgentSessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  const queued: string[] = [];
  const queueUpdate = () => emit({ type: 'queue_update', steering: [...queued], followUp: [] });
  let aborted = false;
  const sdk = {
    isStreaming: false,
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt() {
      sdk.isStreaming = true;
      await gate;
      emit({ type: 'agent_end', messages: [], willRetry: false });
      sdk.isStreaming = false;
    },
    async steer(text: string) {
      queued.push(text);
      queueUpdate();
    },
    async followUp() {},
    getSteeringMessages: () => queued,
    clearQueue() {
      const steering = queued.splice(0);
      queueUpdate();
      return { steering, followUp: [] };
    },
    async abort() {
      aborted = true;
      release();
    },
    dispose() {},
  };
  // Inject only an already-started session; never touch settings, disk, or auth.
  Object.assign(pi, { session: sdk });
  const settled: Array<{ prompt: IncomingPrompt; disposition: SteeringDisposition }> = [];
  const start = async () => {
    const run = pi.runPrompt('original', [], {
      onSteeringSettled: (prompt, disposition) => {
        settled.push({ prompt, disposition });
      },
    });
    await Promise.resolve();
    assert.equal(sdk.isStreaming, true);
    return { run };
  };
  return { pi, sdk, queued, queueUpdate, settled, start, release, emit, aborted: () => aborted };
}

test('wrapper steers file prompts and retains ownership until the existing run finishes', async () => {
  const f = fixture();
  const { run } = await f.start();
  const prompt: IncomingPrompt = {
    text: 'use this file instead',
    attachments: [{ type: 'file', path: '/unused/report.txt', filename: 'report.txt' }],
  };
  assert.equal(await f.pi.trySteer(prompt), true);
  assert.match(f.queued[0], /report.txt: \/unused\/report.txt/);
  assert.match(f.queued[0], /use this file instead/);
  assert.equal(f.pi.pendingSteeringCount, 1);
  f.queued.shift();
  f.queueUpdate();
  assert.equal(f.pi.pendingSteeringCount, 0);
  assert.deepEqual(f.settled, []);
  f.release();
  await run;
  assert.deepEqual(f.settled, [{ prompt, disposition: 'done' }]);
  assert.equal(await f.pi.trySteer(prompt), false);
});

test('wrapper defers an unconsumed tail message and removes it from the SDK queue', async () => {
  const f = fixture();
  const { run } = await f.start();
  const prompt: IncomingPrompt = { text: 'last instant', attachments: [] };
  await f.pi.trySteer(prompt);
  f.release();
  await run;
  assert.deepEqual(f.queued, []);
  assert.deepEqual(f.settled, [{ prompt, disposition: 'deferred' }]);
});

test('wrapper abort clears SDK steering and never replays cancelled prompts', async () => {
  const f = fixture();
  const { run } = await f.start();
  const prompt: IncomingPrompt = { text: 'cancel me', attachments: [] };
  await f.pi.trySteer(prompt);
  f.pi.abort();
  assert.equal(f.aborted(), true);
  assert.deepEqual(f.queued, []);
  await run;
  assert.deepEqual(f.settled, [{ prompt, disposition: 'done' }]);
});

test('agent_end and a pending session reset both prevent new steering', async () => {
  for (const mode of ['ending', 'reset']) {
    const f = fixture();
    const { run } = await f.start();
    if (mode === 'ending') f.emit({ type: 'agent_end', messages: [], willRetry: false });
    else await f.pi.requestNewSession();
    assert.equal(await f.pi.trySteer({ text: 'next', attachments: [] }), false);
    f.release();
    await run;
  }
});
