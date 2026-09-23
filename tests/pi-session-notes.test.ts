import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { SdkPiSession, type PiRuntime } from '../src/pi-session.ts';
import {
  lastSessionEventKind,
  SESSION_EVENT_TYPE,
  sessionEventMessage,
} from '../src/session-notes.ts';

/** A live session stand-in: records what reaches the SDK and what reaches the file. */
function fixture() {
  const runtime = {
    modelName: 'test/model',
    cwd: '/unused',
    sessionDir: '/unused',
    sessionPrefix: 'test',
    sessionKind: 'chat',
  } as unknown as PiRuntime;
  const sessionManager = SessionManager.inMemory('/work');
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const session = {
    sessionManager,
    async sendCustomMessage(message: unknown, options: unknown) {
      sent.push({ message, options });
    },
  };
  const pi = new SdkPiSession(runtime);
  return { pi, session, sessionManager, sent };
}

test('a note on a live session goes through the SDK so the running agent sees it', async () => {
  const { pi, session, sessionManager, sent } = fixture();
  Object.assign(pi, { session });

  await pi.noteEvent('model', 'The chat model was changed.');

  assert.deepEqual(sent, [
    {
      message: sessionEventMessage('model', 'The chat model was changed.'),
      // Context only: a note must never start a turn of its own.
      options: { triggerTurn: false },
    },
  ]);
  // The SDK writes the file itself; a second write here would duplicate the note.
  assert.equal(sessionManager.getEntries().length, 0);
});

test('a note waits for a session that is still starting rather than bypassing it', async () => {
  const { pi, session, sent } = fixture();
  let finishStart: (value: typeof session) => void = () => {};
  const starting = new Promise<typeof session>((resolve) => {
    finishStart = resolve;
  });
  Object.assign(pi, { starting });

  const noted = pi.noteEvent('abort', 'The user aborted your previous turn.');
  finishStart(session);
  await noted;

  assert.equal(sent.length, 1);
});

test('an exit note is written straight to the file, where the next start looks for it', async () => {
  const { pi, session, sessionManager, sent } = fixture();
  Object.assign(pi, { session });

  await pi.noteEventBeforeExit('restart', 'The bot process was restarted deliberately.');

  assert.deepEqual(sent, []);
  assert.equal(lastSessionEventKind(sessionManager), 'restart');
  const entry = sessionManager.getEntries().at(-1);
  assert.equal(entry?.type === 'custom_message' && entry.customType, SESSION_EVENT_TYPE);
});

test('a failed note is logged, not thrown into the command that recorded it', async (t) => {
  const { pi, session } = fixture();
  Object.assign(pi, {
    session: {
      ...session,
      async sendCustomMessage() {
        throw new Error('boom');
      },
    },
  });
  const logged = t.mock.method(console, 'error', () => {});

  await pi.noteEvent('model', 'The chat model was changed.');

  assert.equal(logged.mock.callCount(), 1);
});
