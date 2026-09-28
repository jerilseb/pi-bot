import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { SdkPiSession, type PiRuntime } from '../src/pi-session.ts';

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

function retryStart(attempt: number): AgentSessionEvent {
  return {
    type: 'auto_retry_start',
    attempt,
    maxAttempts: 4,
    delayMs: 2_000,
    errorMessage: 'WebSocket error',
  };
}

test('a successful SDK retry clears the earlier error and partial output', async () => {
  const f = fixture([
    (emit) => {
      emit(textDelta('partial'));
      emit(errorEnd('WebSocket error', true));
      emit(retryStart(1));
      emit(errorEnd('WebSocket error', true));
      emit(retryStart(2));
      emit(textDelta('recovered answer'));
      emit(successEnd());
    },
  ]);
  const notices: string[] = [];
  const result = await f.pi.runPrompt('original', [], {
    onAutoRetry: (error) => {
      notices.push(error);
    },
  });

  assert.equal(result.text, 'recovered answer');
  assert.deepEqual(f.prompts, ['original']);
  // Announced once per run, however many attempts the SDK makes.
  assert.deepEqual(notices, ['WebSocket error']);
});

test('an error the SDK stops retrying fails the run, with no attempt of its own', async () => {
  const f = fixture([(emit) => emit(errorEnd('WebSocket error', false))]);
  await assert.rejects(f.pi.runPrompt('original', []), /WebSocket error/);
  assert.deepEqual(f.prompts, ['original']);
});
