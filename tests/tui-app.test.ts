import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import type { UserInput, SubmitResult } from '../src/contract.ts';
import { TerminalApp } from '../src/tui/app.ts';
import { ChatView } from '../src/tui/chat-view.ts';
import type { PromptEditor } from '../src/tui/prompt-editor.ts';
import { RemoteCore } from '../src/tui/remote-core.ts';

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

test('a pasted image path is an [Image N] in the editor, sent as the image beside its marker', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-paste-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shot = path.join(dir, 'screen shot.png');
  const photo = path.join(dir, 'photo.jpg');
  fs.writeFileSync(shot, 'png');
  fs.writeFileSync(photo, 'jpg');

  const { app, notes } = fixture(t);
  const sent: UserInput[] = [];
  let result: SubmitResult = { status: 'rejected', reason: 'queue-full' };
  t.mock.method(RemoteCore.prototype, 'submit', async (input: UserInput) => {
    sent.push(input);
    return result;
  });
  const editor = (app as unknown as { editor: PromptEditor }).editor;
  const paste = (text: string): void => editor.handleInput(`\x1b[200~${text}\x1b[201~`);

  editor.handleInput('compare');
  paste(`'${shot}'`);
  editor.handleInput('with ');
  paste(photo);
  assert.equal(editor.getText(), 'compare [Image 1] with [Image 2] ');

  // The first marker deleted: only the second image goes, renumbered.
  editor.setText('now just [Image 2]');
  editor.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, 'now just [Image 1]');
  assert.deepEqual(
    sent[0]?.attachments.map(({ type, path: file, mimeType }) => ({ type, file, mimeType })),
    [{ type: 'image', file: photo, mimeType: 'image/jpeg' }],
  );

  // Turned away, the draft comes back as it was written, its image still behind the marker.
  assert.equal(editor.getText(), 'now just [Image 2]');
  assert.match(notes.join('\n'), /Queue full/);
  result = { status: 'queued' };
  editor.handleInput('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[1]?.text, 'now just [Image 1]');
  assert.equal(sent[1]?.attachments[0]?.path, photo);

  // A pasted path that is not an image stays text.
  paste(path.join(dir, 'missing.png'));
  assert.equal(editor.getText(), path.join(dir, 'missing.png'));
});

test('a marker keeps its image through history, Ctrl+C and undo, and is never numbered twice', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-paste-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = path.join(dir, 'first.png');
  const second = path.join(dir, 'second.png');
  fs.writeFileSync(first, 'png');
  fs.writeFileSync(second, 'png');

  const { app } = fixture(t);
  const sent: UserInput[] = [];
  t.mock.method(RemoteCore.prototype, 'submit', async (input: UserInput) => {
    sent.push(input);
    return { status: 'queued' } satisfies SubmitResult;
  });
  const commands: string[] = [];
  t.mock.method(RemoteCore.prototype, 'command', async (line: string) => {
    commands.push(line);
    return true;
  });
  const internals = app as unknown as {
    editor: PromptEditor;
    handleKey(data: string): unknown;
  };
  const { editor } = internals;
  const paste = (text: string): void => editor.handleInput(`\x1b[200~${text}\x1b[201~`);
  const send = async (): Promise<void> => {
    editor.handleInput('\r');
    await new Promise((resolve) => setImmediate(resolve));
  };
  const images = (input: UserInput | undefined): string[] =>
    input?.attachments.map((attachment) => attachment.path) ?? [];

  paste(first);
  await send();
  assert.equal(sent[0]?.text, '[Image 1]');
  assert.deepEqual(images(sent[0]), [first]);

  // Recalled from history, the marker still has its image, and a new paste does not take its number.
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), '[Image 1]');
  editor.handleInput('\x05');
  paste(second);
  assert.equal(editor.getText(), '[Image 1] [Image 2] ');
  await send();
  assert.equal(sent[1]?.text, '[Image 1] [Image 2]');
  assert.deepEqual(images(sent[1]), [first, second]);

  // Cleared with Ctrl+C and brought back with undo, the marker still has its image.
  paste(second);
  internals.handleKey('\x03');
  assert.equal(editor.getText(), '');
  editor.handleInput('\x1f');
  assert.equal(editor.getText(), '[Image 3] ');
  await send();
  assert.equal(sent[2]?.text, '[Image 1]');
  assert.deepEqual(images(sent[2]), [second]);

  // A slash line with an image is its caption, not a command.
  editor.setText('/look [Image 1]');
  await send();
  assert.deepEqual(commands, []);
  assert.equal(sent[3]?.text, '/look [Image 1]');
  assert.deepEqual(images(sent[3]), [first]);
});
