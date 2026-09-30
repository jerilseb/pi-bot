import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { type PiRuntime, SdkPiSession } from '../src/pi-session.ts';

/**
 * start_new_session with a task: the task belongs to the run that asked for
 * it, so only a run that finishes hands it on. Driven through the real
 * runPrompt and requestNewSession against fake SDK sessions.
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

/** A fake AgentSession whose run does `during`, standing in for the agent's tool calls, then ends. */
function fakeSession(during: () => Promise<unknown> = async () => {}) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const fake = {
    prompts: [] as string[],
    isStreaming: false,
    thinkingLevel: 'medium',
    getAvailableThinkingLevels: () => ['off', 'low', 'medium', 'high'],
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      fake.prompts.push(text);
      await during();
      for (const listener of listeners) {
        listener({ type: 'agent_end', messages: [], willRetry: false } as AgentSessionEvent);
      }
    },
    async abort() {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [],
    dispose() {},
  };
  return fake;
}

/** An SdkPiSession whose createSession hands out `sessions` in order. */
function chat() {
  const pi = new SdkPiSession(runtime());
  const sessions: Array<ReturnType<typeof fakeSession>> = [];
  Object.assign(pi, {
    createSession: async () => {
      const next = sessions.shift();
      assert.ok(next, 'unexpected session start');
      return next;
    },
  });
  return { pi, sessions };
}

test('a run that finishes hands on the task it asked the new session to start with', async () => {
  const { pi, sessions } = chat();
  sessions.push(fakeSession(() => pi.requestNewSession('draft the release notes')));
  const result = await pi.runPrompt('start fresh and draft the release notes', []);
  assert.equal(result.newSessionTask, 'draft the release notes');
});

test('a run that fails drops its task, so the next message is not followed by it', async () => {
  const { pi, sessions } = chat();
  const fresh = fakeSession();
  sessions.push(
    fakeSession(async () => {
      await pi.requestNewSession('draft the release notes');
      throw new Error('model unavailable');
    }),
    fresh,
  );
  await assert.rejects(
    pi.runPrompt('start fresh and draft the release notes', []),
    /model unavailable/,
  );

  const next = await pi.runPrompt('what is the weather?', []);
  assert.equal(next.newSessionTask, undefined);
  // The new session itself still started, as the agent asked.
  assert.deepEqual(fresh.prompts, ['what is the weather?']);
});

test('an aborted run drops its task', async () => {
  const { pi, sessions } = chat();
  sessions.push(
    fakeSession(async () => {
      await pi.requestNewSession('draft the release notes');
      pi.abort();
    }),
  );
  const result = await pi.runPrompt('start fresh and draft the release notes', []);
  assert.equal(result.newSessionTask, undefined);
});
