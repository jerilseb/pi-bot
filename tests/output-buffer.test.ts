import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoundedOutputBuffer } from '../src/output-buffer.ts';

/** The last visible line is what a progress message shows while a command runs. */

function buffer(...chunks: string[]): BoundedOutputBuffer {
  const output = new BoundedOutputBuffer('test-output');
  for (const chunk of chunks) output.append(Buffer.from(chunk));
  return output;
}

test('the last line skips trailing blank lines', () => {
  assert.equal(buffer('first\nsecond\n\n  \n').lastLine(), 'second');
});

test('a line still being written counts', () => {
  assert.equal(buffer('done\nhalf a li', 'ne').lastLine(), 'half a line');
});

test('a progress bar redrawn with carriage returns shows its latest state', () => {
  assert.equal(buffer('Downloading\n 10%\r 55%\r 90%').lastLine(), '90%');
  assert.equal(buffer('step 1\r\nstep 2\r\n').lastLine(), 'step 2');
});

test('terminal colours and titles are dropped, and a line of only codes is skipped', () => {
  const red = '\u001b[31m';
  const reset = '\u001b[0m';
  const title = '\u001b]0;building\u0007';
  assert.equal(buffer(`${title}${red}error:${reset} failed\n`).lastLine(), 'error: failed');
  assert.equal(buffer(`real line\n${reset}\n`).lastLine(), 'real line');
});

test('no output yet reads as empty', () => {
  assert.equal(buffer().lastLine(), '');
  assert.equal(buffer('\n\n').lastLine(), '');
});
