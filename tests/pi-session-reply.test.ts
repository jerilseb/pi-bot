import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { type PiRuntime, SdkPiSession } from '../src/pi-session.ts';

/**
 * What runPrompt returns as a run's reply: one paragraph per assistant message,
 * the last message on its own, and nothing at all when the model said nothing.
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

/** Runs one prompt on a fake session that emits `events`. */
async function reply(events: AgentSessionEvent[]) {
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
  const pi = new SdkPiSession(runtime());
  Object.assign(pi, { session });
  return pi.runPrompt('go', []);
}

const assistantStart = {
  type: 'message_start',
  message: { role: 'assistant', content: [] },
} as unknown as AgentSessionEvent;

function delta(text: string): AgentSessionEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: text },
  } as AgentSessionEvent;
}

const toolResultStart = {
  type: 'message_start',
  message: { role: 'toolResult', content: [] },
} as unknown as AgentSessionEvent;

const end = { type: 'agent_end', messages: [], willRetry: false } as AgentSessionEvent;

test('narration before a tool call and the answer after it are separate paragraphs', async () => {
  const result = await reply([
    assistantStart,
    delta('Checking '),
    delta('now.'),
    toolResultStart,
    assistantStart,
    delta('Done.'),
    end,
  ]);
  // Once delivered as "Checking now.Done."
  assert.deepEqual(result, { text: 'Checking now.\n\nDone.', finalText: 'Done.' });
});

test('a message with no text, such as a bare tool call, adds no empty paragraph', async () => {
  const result = await reply([assistantStart, toolResultStart, assistantStart, delta('Hi'), end]);
  assert.deepEqual(result, { text: 'Hi', finalText: 'Hi' });
});

test('a run that says nothing returns no text, not a placeholder', async () => {
  const result = await reply([assistantStart, end]);
  assert.deepEqual(result, { text: '', finalText: '' });
});

test('an SDK retry drops only the failed attempt, keeping the narration before it', async () => {
  const result = await reply([
    assistantStart,
    delta('Checking.'),
    toolResultStart,
    assistantStart,
    delta('Here is th'),
    {
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 0,
      errorMessage: 'WebSocket error',
    },
    assistantStart,
    delta('Here is the answer.'),
    end,
  ]);
  assert.equal(result.text, 'Checking.\n\nHere is the answer.');
});
