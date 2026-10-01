import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';
import type { Terminal } from '@earendil-works/pi-tui';
import { TuiMainScreen } from '@earendil-works/pi-tui';
import type { Attachment } from '../src/types.ts';
import {
  imageAttachment,
  pastedImagePaths,
  resolveImageMarkers,
} from '../src/tui/pasted-images.ts';
import { PromptEditor } from '../src/tui/prompt-editor.ts';

initTheme();

const files = new Set(['/pics/a.png', '/pics/two words.jpg', path.join(os.homedir(), 'b.webp')]);
const exists = (file: string): boolean => files.has(file);

test('a paste of image paths is read as a terminal pastes or drops them', () => {
  assert.deepEqual(pastedImagePaths('/pics/a.png', exists), ['/pics/a.png']);
  assert.deepEqual(pastedImagePaths('  /pics/a.png\n', exists), ['/pics/a.png']);
  assert.deepEqual(pastedImagePaths("'/pics/two words.jpg' ", exists), ['/pics/two words.jpg']);
  assert.deepEqual(pastedImagePaths('"/pics/two words.jpg"', exists), ['/pics/two words.jpg']);
  assert.deepEqual(pastedImagePaths('/pics/two\\ words.jpg', exists), ['/pics/two words.jpg']);
  assert.deepEqual(pastedImagePaths('file:///pics/two%20words.jpg', exists), [
    '/pics/two words.jpg',
  ]);
  assert.deepEqual(pastedImagePaths('~/b.webp', exists), [path.join(os.homedir(), 'b.webp')]);
  assert.deepEqual(pastedImagePaths('/pics/a.png\n/pics/two\\ words.jpg', exists), [
    '/pics/a.png',
    '/pics/two words.jpg',
  ]);
});

test('anything but existing image files is pasted as text', () => {
  for (const pasted of [
    '',
    '   ',
    'hello there',
    '/pics/missing.png',
    '/pics/a.png and some words',
    '/pics/a.png /pics/missing.png',
    'a.png',
    "'/pics/two words.jpg",
    '/etc/passwd',
  ]) {
    assert.equal(
      pastedImagePaths(pasted, (file) => file !== '/pics/missing.png'),
      null,
      pasted,
    );
  }
});

test('the markers left in the text pick the images, numbered in the order the text names them', () => {
  const a = imageAttachment('/pics/a.png');
  const b = imageAttachment('/pics/b.jpg');
  const c = imageAttachment('/pics/c.gif');
  const images = new Map<number, Attachment>([
    [1, a],
    [2, b],
    [3, c],
  ]);
  assert.equal(a.mimeType, 'image/png');
  assert.equal(b.mimeType, 'image/jpeg');

  // [Image 2] was deleted; [Image 3] comes before [Image 1].
  const resolved = resolveImageMarkers('compare [Image 3] with [Image 1], again [Image 3]', images);
  assert.equal(resolved.text, 'compare [Image 1] with [Image 2], again [Image 1]');
  assert.deepEqual(resolved.attachments, [c, a]);

  const unknown = resolveImageMarkers('literal [Image 9] here', images);
  assert.equal(unknown.text, 'literal [Image 9] here');
  assert.deepEqual(unknown.attachments, []);
});

function editor(): PromptEditor {
  const terminal = {
    start() {},
    stop() {},
    write() {},
    columns: 80,
    rows: 24,
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
  } as unknown as Terminal;
  return new PromptEditor(new TuiMainScreen(terminal), {
    borderColor: (text) => text,
    selectList: getSelectListTheme(),
  });
}

test('the editor offers a whole paste, however it arrives, before it becomes text', () => {
  const input = editor();
  const offered: string[] = [];
  input.onPaste = (text) => {
    offered.push(text);
    if (text !== '/pics/a.png') return false;
    input.insertTextAtCursor('[Image 1]');
    return true;
  };
  input.handleInput('see ');
  input.handleInput('\x1b[200~/pics/');
  input.handleInput('a.png\x1b[201~ ok');
  assert.deepEqual(offered, ['/pics/a.png']);
  assert.equal(input.getText(), 'see [Image 1] ok');

  input.handleInput(' \x1b[200~plain text\x1b[201~');
  assert.deepEqual(offered, ['/pics/a.png', 'plain text']);
  assert.equal(input.getText(), 'see [Image 1] ok plain text');
});

test("an image's marker is one character to Backspace, Delete, the arrows and undo", () => {
  const input = editor();
  input.isImageMarker = (n) => n === 1;
  const BACKSPACE = '\x7f';
  const DELETE = '\x1b[3~';
  const RIGHT = '\x1b[C';
  const UNDO = '\x1f';

  input.setText('a [Image 1]');
  input.handleInput(BACKSPACE);
  assert.equal(input.getText(), 'a ');
  input.handleInput(UNDO);
  assert.equal(input.getText(), 'a [Image 1]');

  input.setText('[Image 1] b');
  input.handleInput('\x01');
  input.handleInput(DELETE);
  assert.equal(input.getText(), ' b');

  input.setText('[Image 1]x');
  input.handleInput('\x01');
  input.handleInput(RIGHT);
  input.handleInput(DELETE);
  assert.equal(input.getText(), '[Image 1]');

  // A marker with no image behind it is only text.
  input.setText('a [Image 2]');
  input.handleInput(BACKSPACE);
  assert.equal(input.getText(), 'a [Image 2');
});
