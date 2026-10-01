import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { TerminalApp } from '../src/tui/app.ts';
import { ChatView } from '../src/tui/chat-view.ts';

initTheme();

/** Exercise the app's event handling without starting a terminal or connecting to the bot. */
function fixture(t: TestContext) {
  const terminal: Terminal = {
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
  const notes: string[] = [];
  t.mock.method(ChatView.prototype, 'note', (text: string) => {
    notes.push(stripTerminalSequences(text));
  });
  const ended = t.mock.method(ChatView.prototype, 'turnEnd');
  const app = new TerminalApp({
    terminal,
    connect: async () => {
      throw new Error('The test must not connect to the bot');
    },
    cwd: process.cwd(),
    onQuit() {},
  });
  t.after(() => app.stop());
  return { app, notes, ended };
}

test('an aborted turn ends without a duplicate error notice', (t) => {
  const { app, notes, ended } = fixture(t);
  app.onEvent({
    type: 'turn_end',
    turnId: 'chat-1',
    session: 'chat',
    outcome: 'error',
    error: 'Request was aborted',
    ping: [],
  });
  assert.deepEqual(notes, []);
  assert.equal(ended.mock.callCount(), 1);
});

test('a failed turn still shows its error notice', (t) => {
  const { app, notes, ended } = fixture(t);
  app.onEvent({
    type: 'turn_end',
    turnId: 'chat-1',
    session: 'chat',
    outcome: 'error',
    error: 'Connection failed',
    ping: [],
  });
  assert.deepEqual(notes, ['❌ Connection failed']);
  assert.equal(ended.mock.callCount(), 1);
});
