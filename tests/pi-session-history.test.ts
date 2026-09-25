import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { type PiRuntime, SdkPiSession } from '../src/pi-session.ts';

/**
 * What a terminal is shown when it connects: the conversation as the chat
 * would resume it, without starting an agent for it.
 */

function fixture() {
  const runtime = {
    modelName: 'test/model',
    cwd: '/unused',
    sessionDir: '/unused',
    sessionPrefix: 'test',
    sessionKind: 'chat',
  } as unknown as PiRuntime;
  const stored = SessionManager.inMemory('/work');
  stored.appendMessage({ role: 'user', content: 'from the transcript', timestamp: 1 });
  const pi = new SdkPiSession(runtime);
  // Stands in for reading sessions/: nothing here may touch the disk.
  Object.assign(pi, { openStoredSessionManager: async () => stored });
  return { pi, stored };
}

test('with no session loaded, the history is the transcript the chat would resume', async () => {
  const { pi } = fixture();
  const history = await pi.history();
  assert.deepEqual(
    history.map((message) => (message.role === 'user' ? message.content : message.role)),
    ['from the transcript'],
  );
});

test("a loaded session's history is its own messages", async () => {
  const { pi } = fixture();
  const messages = [{ role: 'user', content: 'live', timestamp: 2 }];
  Object.assign(pi, { session: { messages } });
  assert.equal(await pi.history(), messages);
});

test('after /new the history is empty, even before the new session starts', async () => {
  const { pi } = fixture();
  pi.reset();
  assert.deepEqual(await pi.history(), []);
});

test('a transcript that cannot be read is an empty history, not an error', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { pi } = fixture();
  Object.assign(pi, {
    openStoredSessionManager: async () => {
      throw new Error('unreadable');
    },
  });
  assert.deepEqual(await pi.history(), []);
});
