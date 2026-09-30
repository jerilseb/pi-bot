import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pipeThroughProcess } from '../src/speech.ts';

/** ffmpeg runs through pipeThroughProcess; Node stands in for it here. */

function node(script: string, input: Buffer, timeoutMs = 10_000): Promise<Buffer> {
  return pipeThroughProcess(process.execPath, ['-e', script], input, timeoutMs);
}

test('the process gets the input on stdin, and its stdout is the result', async () => {
  const output = await node('process.stdin.pipe(process.stdout)', Buffer.from('audio'));
  assert.equal(output.toString(), 'audio');
});

test('a process that exits before reading its input rejects instead of crashing the bot', async () => {
  // Far more than a pipe buffer holds, so the write fails with EPIPE.
  const input = Buffer.alloc(8 * 1024 * 1024);
  await assert.rejects(node('process.exit(3)', input), /failed \(3\)/);
});

test('a failure carries what the process wrote to stderr', async () => {
  await assert.rejects(
    node('process.stderr.write("Unknown encoder libopus"); process.exit(1)', Buffer.alloc(0)),
    /failed \(1\): Unknown encoder libopus/,
  );
});

test('a process that hangs is killed after the timeout', async () => {
  await assert.rejects(node('setInterval(() => {}, 1000)', Buffer.alloc(0), 200), /timed out/);
});
