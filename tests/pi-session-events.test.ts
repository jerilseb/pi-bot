import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { type PiRuntime, SdkPiSession } from '../src/pi-session.ts';

/**
 * The event hook: every SDK event of every AgentSession an SdkPiSession runs
 * reaches onEvent, although the live session is replaced by model switches,
 * /new, and each session-per-prompt run.
 */

interface FakeSession {
  name: string;
  emit(event: AgentSessionEvent): void;
  listenerCount(): number;
}

function event(type: string): AgentSessionEvent {
  return { type, messages: [], willRetry: false } as unknown as AgentSessionEvent;
}

function fixture(sessionPerPrompt = false, listener?: (event: AgentSessionEvent) => void) {
  const runtime = {
    modelName: 'test/model',
    cwd: '/unused',
    sessionDir: '/unused',
    sessionPrefix: 'test',
    sessionPerPrompt,
    sessionKind: sessionPerPrompt ? 'background' : 'chat',
  } as unknown as PiRuntime;
  const heard: string[] = [];
  const pi = new SdkPiSession(runtime, {
    onEvent: listener ?? ((received) => heard.push(received.type)),
  });
  const sessions: FakeSession[] = [];
  const internals = pi as unknown as {
    createSession(): Promise<unknown>;
    resolveFreshModel(): Promise<unknown>;
  };
  // Each start creates a fresh fake, the way a real start creates a fresh AgentSession.
  internals.createSession = async () => {
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const name = `session-${sessions.length + 1}`;
    const emit = (sent: AgentSessionEvent) => {
      for (const listener of [...listeners]) listener(sent);
    };
    sessions.push({ name, emit, listenerCount: () => listeners.size });
    return {
      isStreaming: false,
      subscribe(listener: (event: AgentSessionEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        emit(event(`${name}:agent_end`));
      },
      clearQueue: () => ({ steering: [], followUp: [] }),
      getSteeringMessages: () => [],
      async abort() {},
      dispose() {},
    };
  };
  internals.resolveFreshModel = async () => ({});
  return { pi, heard, sessions };
}

test('events reach the hook from the session, and stop once it is cleaned up', async () => {
  const { pi, heard, sessions } = fixture();
  await pi.runPrompt('go', []);
  assert.deepEqual(heard, ['session-1:agent_end']);

  pi.cleanup();
  assert.equal(sessions[0]?.listenerCount(), 0);
  sessions[0]?.emit(event('late'));
  assert.deepEqual(heard, ['session-1:agent_end']);
});

test('a model switch and /new each move the hook to the replacement session', async () => {
  const { pi, heard, sessions } = fixture();
  await pi.runPrompt('go', []);
  await pi.useModel('test/other');
  await pi.runPrompt('go', []);
  pi.reset();
  await pi.runPrompt('go', []);

  assert.deepEqual(heard, ['session-1:agent_end', 'session-2:agent_end', 'session-3:agent_end']);
  // Only the live session is still heard.
  assert.deepEqual(
    sessions.map((session) => session.listenerCount()),
    [0, 0, 1],
  );
});

test('every session-per-prompt run is heard, and none outlives its run', async () => {
  const { pi, heard, sessions } = fixture(true);
  await pi.runPrompt('first', []);
  await pi.runPrompt('second', []);
  assert.deepEqual(heard, ['session-1:agent_end', 'session-2:agent_end']);
  assert.deepEqual(
    sessions.map((session) => session.listenerCount()),
    [0, 0],
  );
});

test('a listener that throws does not break the run', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { pi } = fixture(false, () => {
    throw new Error('listener failed');
  });
  assert.deepEqual(await pi.runPrompt('go', []), { text: '', finalText: '' });
});
