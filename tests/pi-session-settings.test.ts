import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { SdkPiSession, type PiRuntime } from '../src/pi-session.ts';

/** Exercise the bot/SDK boundary without credentials, filesystem writes, or network. */
function fixture() {
  const model = { provider: 'test', id: 'new' } as Model<Api>;
  const settings = SettingsManager.inMemory({
    defaultProvider: 'test',
    defaultModel: 'old',
    defaultThinkingLevel: 'low',
  });
  const calls: string[] = [];
  const runtime = {
    modelName: 'test/old',
    modelRuntime: {
      async refresh() {},
      getModel: () => model,
      hasConfiguredAuth: () => true,
    },
    settingsManager: settings,
    cwd: '/unused',
    sessionDir: '/unused',
    sessionPrefix: 'test',
    getExtensionPaths: () => [],
    getSkillPaths: () => [],
    systemPromptOverride: () => '',
    extensionFactories: [],
  } as unknown as PiRuntime;
  const session = {
    isStreaming: false,
    thinkingLevel: 'low' as ThinkingLevel,
    async setModel(next: Model<Api>, options?: { persist?: boolean }) {
      assert.equal(options?.persist, true);
      calls.push('model');
      settings.setDefaultModelAndProvider(next.provider, next.id);
    },
    setThinkingLevel(level: ThinkingLevel, options?: { persist?: boolean }) {
      assert.equal(options?.persist, true);
      calls.push('thinking');
      // The SDK may clamp a requested level to what the selected model supports.
      this.thinkingLevel = level === 'xhigh' ? 'high' : level;
      settings.setDefaultThinkingLevel(this.thinkingLevel);
    },
    dispose() {
      calls.push('dispose');
    },
  };
  const pi = new SdkPiSession(runtime);
  Object.assign(pi, {
    session,
    async noteEvent() {
      calls.push('note');
    },
  });
  return { pi, runtime, settings, session, calls };
}

test('chat model selection persists the restart default and updates replacement sessions', async () => {
  const f = fixture();
  await f.pi.setModel('test/new');
  assert.equal(f.settings.getDefaultProvider(), 'test');
  assert.equal(f.settings.getDefaultModel(), 'new');
  assert.equal(f.pi.modelName, 'test/new');
  assert.equal(new SdkPiSession(f.runtime).modelName, 'test/new');
  assert.deepEqual(f.calls, ['model', 'note']);
});

test('reselecting the current model still persists it', async () => {
  const f = fixture();
  f.runtime.modelName = 'test/new';
  const pi = new SdkPiSession(f.runtime);
  Object.assign(pi, { session: f.session });
  await pi.setModel('test/new');
  assert.equal(f.settings.getDefaultModel(), 'new');
  assert.deepEqual(f.calls, ['model']);
});

test('reasoning selection persists the supported level, not an unsupported request', async () => {
  const f = fixture();
  assert.equal(await f.pi.setThinkingLevel('xhigh'), 'high');
  assert.equal(f.settings.getDefaultThinkingLevel(), 'high');
  assert.equal(f.settings.getDefaultModel(), 'old');
  assert.deepEqual(f.calls, ['thinking']);
});

for (const setting of ['model', 'thinking'] as const) {
  test(`${setting} selection waits for settings writes before acknowledging success`, async (t) => {
    const f = fixture();
    let release = () => {};
    const flushed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const flushing = new Promise<void>((resolve) => {
      started = resolve;
    });
    t.mock.method(f.settings, 'flush', () => {
      started();
      return flushed;
    });
    let completed = false;
    const change = (
      setting === 'model' ? f.pi.setModel('test/new') : f.pi.setThinkingLevel('high')
    ).then(() => {
      completed = true;
    });
    await flushing;
    assert.equal(completed, false);
    release();
    await change;
    assert.equal(completed, true);
  });
}

test('busy sessions do not mutate persisted model or reasoning preferences', async () => {
  const f = fixture();
  f.session.isStreaming = true;
  await assert.rejects(f.pi.setModel('test/new'), /Cannot switch models/);
  await assert.rejects(f.pi.setThinkingLevel('high'), /Cannot switch reasoning/);
  assert.equal(f.settings.getDefaultModel(), 'old');
  assert.equal(f.settings.getDefaultThinkingLevel(), 'low');
  assert.deepEqual(f.calls, []);
});

test('temporary background model selection leaves chat defaults untouched', async () => {
  const f = fixture();
  await f.pi.useModel('test/new');
  assert.equal(f.pi.modelName, 'test/new');
  assert.equal(f.runtime.modelName, 'test/old');
  assert.equal(f.settings.getDefaultModel(), 'old');
  assert.equal(f.settings.getDefaultThinkingLevel(), 'low');
  assert.deepEqual(f.calls, ['dispose']);
});
