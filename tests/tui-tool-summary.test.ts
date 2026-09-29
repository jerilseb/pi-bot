import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeTool, type ToolOutcome, toolOutput } from '../src/tui/tool-summary.ts';

/**
 * What a tool call's row says it came to, from results shaped as Pi's own
 * tools return them, and from the first line of any other tool's output.
 */

const ok = (text: string, details?: unknown): ToolOutcome => ({
  content: [{ type: 'text', text }],
  details,
  isError: false,
});
const failed = (text: string): ToolOutcome => ({ ...ok(text), isError: true });
const summary = (name: string, outcome: ToolOutcome, args: unknown = {}) =>
  summarizeTool(name, args, outcome);

test('a read says how many lines, or which of them when Pi cut the file short', () => {
  assert.deepEqual(summary('read', ok('a\nb\nc\n')), { text: '3 lines' });
  assert.deepEqual(summary('read', ok('only')), { text: '1 line' });
  assert.deepEqual(
    summary('read', ok('a\nb\n\n[Showing lines 1-2 of 900. Use offset=3 to continue.]')),
    { text: 'lines 1–2 of 900' },
  );
  assert.deepEqual(
    summary('read', ok('a\nb\n\n[Showing lines 5-6 of 9 (50KB limit). Use offset=7 to continue.]')),
    { text: 'lines 5–6 of 9' },
  );
  assert.deepEqual(
    summary('read', ok('a\nb\n\n[7 more lines in file. Use offset=12 to continue.]'), {
      offset: 10,
      limit: 2,
    }),
    { text: 'lines 10–11 of 18' },
  );
  assert.deepEqual(
    summary('read', {
      content: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', data: '', mimeType: 'image/png' },
      ],
      isError: false,
    }),
    { text: 'image' },
  );
});

test('a command says how much it printed, and a failed one its status and last line', () => {
  assert.deepEqual(summary('bash', ok('one\ntwo')), { text: '2 lines' });
  assert.deepEqual(summary('bash', ok('')), { text: 'no output' });
  assert.deepEqual(
    summary('bash', ok('x\ny\n\n[Showing lines 1-2 of 5000. Full output: /tmp/out]')),
    { text: '5000 lines' },
  );
  assert.deepEqual(summary('bash', failed('# fail 1\n✖ a test\n\nCommand exited with code 1')), {
    text: 'exit 1',
    error: '✖ a test',
  });
  assert.deepEqual(summary('bash', failed('Command exited with code 2')), { text: 'exit 2' });
  assert.deepEqual(
    summary(
      'bash',
      failed(
        'x\n\n[Showing lines 1-1 of 3. Full output: /tmp/o]\n\nCommand timed out after 30 seconds',
      ),
    ),
    { text: 'timed out after 30s', error: 'x' },
  );
  assert.deepEqual(summary('bash', failed('Command aborted')), { text: 'aborted' });
  assert.deepEqual(summary('bash', failed('spawn /bin/sh ENOENT')), {
    text: '',
    error: 'spawn /bin/sh ENOENT',
  });
});

test('an edit counts the lines its diff adds and removes; a write the lines it wrote', () => {
  const diff = '  1 a\n-2 old\n+2 new\n+3 more\n    ...';
  assert.deepEqual(summary('edit', ok('Successfully replaced 1 block(s) in x.', { diff })), {
    text: '+2 −1',
  });
  assert.deepEqual(summary('write', ok('Successfully wrote to x'), { content: 'a\nb\n' }), {
    text: '2 lines',
  });
});

test('a search counts what it found, with a + when it hit its limit', () => {
  assert.deepEqual(summary('grep', ok('a.ts:1: x\na.ts-2- y\nb.ts:9: x')), { text: '2 matches' });
  assert.deepEqual(summary('grep', ok('No matches found')), { text: 'no matches' });
  assert.deepEqual(
    summary(
      'grep',
      ok('a.ts:1: x\n\n[1 matches limit reached. Use limit=2]', { matchLimitReached: 1 }),
    ),
    { text: '1+ matches' },
  );
  assert.deepEqual(summary('find', ok('a.ts\nb.ts')), { text: '2 files' });
  assert.deepEqual(summary('find', ok('No files found matching pattern')), { text: 'no files' });
  assert.deepEqual(summary('ls', ok('a\nb/\n')), { text: '2 entries' });
  assert.deepEqual(summary('ls', ok('(empty directory)')), { text: 'empty' });
});

test("any other tool says its output's first line; a failure goes under the row", () => {
  assert.deepEqual(summary('web_search', ok('\n  Found 5 results\n\n1. …')), {
    text: 'Found 5 results',
  });
  assert.deepEqual(summary('send_image', failed('No channel took the image.')), {
    text: '',
    error: 'No channel took the image.',
  });
  assert.deepEqual(summary('web_fetch', failed('Operation aborted')), { text: 'aborted' });
  assert.deepEqual(summary('web_fetch', failed('')), { text: 'failed' });
});

test('output is printed without terminal sequences, carriage returns or tabs', () => {
  assert.equal(
    toolOutput([
      { type: 'text', text: '\n\x1b[31mred\x1b[0m\r\n\tindented  \n' },
      { type: 'image', data: '', mimeType: 'image/png' },
    ]).split('\n')[0],
    'red',
  );
  assert.match(toolOutput([{ type: 'text', text: '\ta' }]), /^ {3}a$/);
});
