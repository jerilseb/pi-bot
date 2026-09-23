import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatSession } from '../src/chat-session.ts';
import type { PiRuntime } from '../src/pi-session.ts';

/** No SDK startup, credentials, network, or persisted session access in these tests. */
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

const ONE_DAY_MS = 24 * 60 * 60_000;

for (const state of ['idle', 'processing', 'queued', 'processing-and-queued'] as const) {
  test(`elapsed time preserves ${state} chat state`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const session = createChatSession(runtime());
    const chat = session.get();
    const cleanup = t.mock.method(chat.pi, 'cleanup', () => {});
    chat.processing = state === 'processing' || state === 'processing-and-queued';
    if (state === 'queued' || state === 'processing-and-queued') {
      chat.queue.push({ text: 'pending work', attachments: [] });
    }
    chat.messageCount = 3;
    const pendingCount = chat.queue.length;
    const wasBusy = session.isBusy();

    t.mock.timers.tick(ONE_DAY_MS);

    assert.equal(session.existing(), chat);
    assert.equal(session.isBusy(), wasBusy);
    assert.equal(session.get(), chat);
    assert.equal(chat.queue.length, pendingCount);
    assert.equal(chat.messageCount, 3);
    assert.equal(cleanup.mock.callCount(), 0);
  });
}

test('state is lazy and explicit clear disposes once before recreating it', (t) => {
  const session = createChatSession(runtime());
  assert.equal(session.existing(), null);
  assert.equal(session.isBusy(), false);
  session.clear();
  assert.equal(session.existing(), null);

  const chat = session.get();
  const cleanup = t.mock.method(chat.pi, 'cleanup', () => {});
  chat.processing = true;
  session.clear();
  assert.equal(cleanup.mock.callCount(), 1);
  assert.equal(session.existing(), null);
  assert.equal(session.isBusy(), false);

  session.clear();
  assert.equal(cleanup.mock.callCount(), 1);
  const replacement = session.get();
  assert.notEqual(replacement, chat);
  assert.notEqual(replacement.pi, chat.pi);
  assert.equal(replacement.pi.modelName, 'test/model');
  assert.equal(replacement.processing, false);
  assert.deepEqual(replacement.queue, []);
});
