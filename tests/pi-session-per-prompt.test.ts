import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { type PiRuntime, type RunTranscript, SdkPiSession } from '../src/pi-session.ts';
import { lastSessionEventKind } from '../src/session-notes.ts';

/** A session-per-prompt runtime writing into a temporary directory. */
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-per-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {
    modelName: null,
    cwd: dir,
    sessionDir: dir,
    sessionPrefix: 'telegram-background',
    sessionPerPrompt: true,
    sessionKind: 'background',
  } as unknown as PiRuntime;
  const pi = new SdkPiSession(runtime);
  const internals = pi as unknown as {
    nextRun: { resumeSessionFile?: string; transcript?: RunTranscript };
    createRunSessionManager(): SessionManager;
  };
  const createFor = (next: { resumeSessionFile?: string; transcript?: RunTranscript }) => {
    internals.nextRun = next;
    return internals.createRunSessionManager();
  };
  return { dir, pi, createFor };
}

test('every background run starts a transcript of its own, where and as the run says', (t) => {
  const { dir, createFor } = fixture(t);
  const heartbeatDir = path.join(dir, 'heartbeat-sessions');
  const first = createFor({
    transcript: { dir: heartbeatDir, prefix: 'telegram-heartbeat', name: 'heartbeat' },
  });
  const second = createFor({});

  assert.notEqual(first.getSessionId(), second.getSessionId());
  assert.match(first.getSessionId(), /^telegram-heartbeat-.+-[0-9a-f]{8}$/);
  assert.equal(path.dirname(first.getSessionFile() ?? ''), heartbeatDir);
  assert.equal(first.getSessionName(), 'heartbeat');
  // Without a transcript the runtime's directory and prefix apply.
  assert.match(second.getSessionId(), /^telegram-background-/);
  assert.equal(path.dirname(second.getSessionFile() ?? ''), dir);
  assert.equal(second.getSessionName(), undefined);
});

test('a job report resumes the transcript of the run that started the job', (t) => {
  const { dir, createFor } = fixture(t);
  const run = createFor({
    transcript: { dir: path.join(dir, 'scheduled'), prefix: 'telegram-scheduled-task' },
  });
  run.appendMessage({ role: 'user', content: 'build it', timestamp: Date.now() });
  run.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'started' }],
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
  const file = run.getSessionFile() ?? '';
  assert.ok(fs.existsSync(file));

  const resumed = createFor({ resumeSessionFile: file });
  assert.equal(resumed.getSessionFile(), file);
  assert.equal(resumed.getSessionId(), run.getSessionId());
});

test('a report whose transcript is gone starts fresh rather than failing', (t) => {
  const { dir, createFor } = fixture(t);
  t.mock.method(console, 'error', () => {});
  const missing = path.join(dir, 'gone.jsonl');
  const fresh = createFor({ resumeSessionFile: missing });
  assert.notEqual(fresh.getSessionFile(), missing);
});

test('an exit note can target one run transcript, and nothing resumes on its own', async (t) => {
  const { pi, createFor } = fixture(t);
  const run = createFor({});
  run.appendMessage({ role: 'user', content: 'hi', timestamp: Date.now() });
  run.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
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
  const file = run.getSessionFile() ?? '';

  await pi.noteEventBeforeExit('subagent', 'Jobs were stopped.', file);
  const reopened = createFor({ resumeSessionFile: file });
  assert.equal(lastSessionEventKind(reopened), 'subagent');

  // Without a file there is no shared background conversation to write into.
  assert.equal(await pi.lastNoteKind(), null);
});
