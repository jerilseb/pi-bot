import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { TRANSPORT_RECOVERY_DELAY_MS } from '../src/config.ts';
import { SdkPiSession, type PiRuntime } from '../src/pi-session.ts';
import { TRANSPORT_RECOVERY_PROMPT } from '../src/transport-recovery.ts';

function runtime(): PiRuntime {
  return {
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
    sessionPerPrompt: false,
    sessionKind: 'chat',
    getExtensionPaths: () => [],
    systemPromptOverride: () => '',
    extensionFactories: [],
  };
}

type Emit = (event: AgentSessionEvent) => void;
type PromptBehavior = (emit: Emit) => void;

function errorEnd(message: string, willRetry: boolean): AgentSessionEvent {
  return {
    type: 'agent_end',
    messages: [
      {
        role: 'assistant',
        content: [],
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: 'error',
        errorMessage: message,
        timestamp: 0,
      },
    ],
    willRetry,
  } as unknown as AgentSessionEvent;
}

function textDelta(text: string): AgentSessionEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: text },
  } as AgentSessionEvent;
}

function successEnd(): AgentSessionEvent {
  return { type: 'agent_end', messages: [], willRetry: false };
}

function fixture(behaviors: PromptBehavior[]) {
  const pi = new SdkPiSession(runtime());
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const prompts: string[] = [];
  const queued: string[] = [];
  const emit: Emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const session = {
    isStreaming: false,
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      prompts.push(text);
      const behavior = behaviors.shift();
      if (!behavior) throw new Error('Unexpected prompt');
      behavior(emit);
    },
    async steer(text: string) {
      queued.push(text);
    },
    async followUp() {},
    getSteeringMessages: () => queued,
    clearQueue: () => ({ steering: queued.splice(0), followUp: [] }),
    async abort() {},
    dispose() {},
  };
  Object.assign(pi, { session });
  return { pi, prompts, emit };
}

async function reachRecoveryDelay(prompts: string[]): Promise<void> {
  for (let attempt = 0; attempt < 20 && prompts.length < 1; attempt++) await Promise.resolve();
  assert.equal(prompts.length, 1);
  // Let runPrompt inspect the terminal error and install its backoff timer.
  await Promise.resolve();
  await Promise.resolve();
}

function enableRecoveryTimer(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

test('a successful SDK retry clears the earlier error and partial output', async () => {
  const f = fixture([
    (emit) => {
      emit(textDelta('partial'));
      emit(errorEnd('WebSocket error', true));
      emit({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        errorMessage: 'WebSocket error',
      });
      emit(textDelta('recovered answer'));
      emit(successEnd());
    },
  ]);
  const notices: string[] = [];
  const result = await f.pi.runPrompt('original', [], {
    recoverTransportErrors: true,
    onAutoRecovery: (error) => {
      notices.push(error);
    },
  });

  assert.equal(result.text, 'recovered answer');
  assert.deepEqual(f.prompts, ['original']);
  assert.deepEqual(notices, ['WebSocket error']);
});

test('after SDK retries are exhausted, one fresh continuation resumes the session', async (t) => {
  enableRecoveryTimer(t);
  const f = fixture([
    (emit) => emit(errorEnd('WebSocket error', false)),
    (emit) => {
      emit(textDelta('finished after reconnect'));
      emit(successEnd());
    },
  ]);
  const notices: string[] = [];
  const run = f.pi.runPrompt('original', [], {
    recoverTransportErrors: true,
    onAutoRecovery: (error) => {
      notices.push(error);
    },
  });
  await reachRecoveryDelay(f.prompts);
  t.mock.timers.tick(TRANSPORT_RECOVERY_DELAY_MS);
  const result = await run;

  assert.equal(result.text, 'finished after reconnect');
  assert.deepEqual(f.prompts, ['original', TRANSPORT_RECOVERY_PROMPT]);
  assert.deepEqual(notices, ['WebSocket error']);
});

test('abort cancels the fallback backoff before another model call', async (t) => {
  enableRecoveryTimer(t);
  const f = fixture([(emit) => emit(errorEnd('WebSocket error', false))]);
  const run = f.pi.runPrompt('original', [], { recoverTransportErrors: true });
  const rejected = assert.rejects(run, /WebSocket error/);
  await reachRecoveryDelay(f.prompts);
  f.pi.abort();

  await rejected;
  assert.deepEqual(f.prompts, ['original']);
});

test('fallback continuation is bounded to one attempt', async (t) => {
  enableRecoveryTimer(t);
  const f = fixture([
    (emit) => emit(errorEnd('WebSocket error', false)),
    (emit) => emit(errorEnd('WebSocket error', false)),
  ]);
  const run = f.pi.runPrompt('original', [], { recoverTransportErrors: true });
  await reachRecoveryDelay(f.prompts);
  t.mock.timers.tick(TRANSPORT_RECOVERY_DELAY_MS);

  await assert.rejects(run, /WebSocket error/);
  assert.deepEqual(f.prompts, ['original', TRANSPORT_RECOVERY_PROMPT]);
});

test('auth, quota, tool, and other non-transport errors are never continued', async () => {
  for (const message of ['Invalid API key', 'quota exceeded', 'Tool execution failed']) {
    const f = fixture([(emit) => emit(errorEnd(message, false))]);
    await assert.rejects(
      f.pi.runPrompt('original', [], { recoverTransportErrors: true }),
      new RegExp(message),
    );
    assert.deepEqual(f.prompts, ['original']);
  }
});

test('fallback is opt-in so background runs use only the SDK retry policy', async () => {
  const f = fixture([(emit) => emit(errorEnd('WebSocket error', false))]);
  await assert.rejects(f.pi.runPrompt('background', []), /WebSocket error/);
  assert.deepEqual(f.prompts, ['background']);
});
