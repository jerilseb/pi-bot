import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { type PiRuntime, SdkPiSession } from '../src/pi-session.ts';

/**
 * Which transcript the chat resumes: the one its pointer names. Transcripts go
 * to a temporary directory, and nothing here starts an agent.
 */
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    modelName: 'test/model',
    cwd: dir,
    sessionDir: dir,
    sessionPrefix: 'chat',
    sessionPerPrompt: false,
    sessionKind: 'chat',
  } as unknown as PiRuntime;
  const chat = () => {
    const pi = new SdkPiSession(runtime);
    const internals = pi as unknown as {
      createSessionManager(): Promise<SessionManager>;
      openStoredSessionManager(): Promise<SessionManager | null>;
    };
    return { pi, internals };
  };
  // What a restart finds: a fresh SdkPiSession over the same directory.
  const resumed = async () => (await chat().internals.openStoredSessionManager())?.getSessionFile();
  return { dir, chat, resumed };
}

/** The SDK writes a transcript to disk with its first assistant message. */
function saveExchange(manager: SessionManager): void {
  manager.appendMessage({ role: 'user', content: 'hello', timestamp: Date.now() });
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    api: 'test',
    provider: 'test',
    model: 'm',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as never);
}

test('a new conversation is resumed after a restart once its transcript is written', async (t) => {
  const f = fixture(t);
  assert.equal(await f.resumed(), undefined);
  const manager = await f.chat().internals.createSessionManager();
  // Before the first reply there is nothing on disk to resume.
  assert.equal(await f.resumed(), undefined);
  saveExchange(manager);
  assert.equal(await f.resumed(), manager.getSessionFile());
});

test('/new forgets the conversation, and the next one takes its place', async (t) => {
  const f = fixture(t);
  const { pi, internals } = f.chat();
  const first = await internals.createSessionManager();
  saveExchange(first);
  Object.assign(pi, {
    session: { thinkingLevel: 'low', getAvailableThinkingLevels: () => ['low'], dispose() {} },
  });
  await pi.requestNewSession();
  // A restart now starts fresh, though the old transcript is still on disk.
  assert.equal(await f.resumed(), undefined);
  assert.ok(fs.existsSync(first.getSessionFile() ?? ''));

  pi.reset();
  // Transcript file names carry the time to the millisecond, and so tell the two apart.
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await internals.createSessionManager();
  saveExchange(second);
  assert.notEqual(second.getSessionFile(), first.getSessionFile());
  assert.equal(await f.resumed(), second.getSessionFile());
});
