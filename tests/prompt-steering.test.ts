import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ImageContent } from '@earendil-works/pi-ai';
import { PromptSteering } from '../src/prompt-steering.ts';
import type { IncomingPrompt } from '../src/types.ts';

function fixture() {
  const steering: string[] = [];
  const calls: Array<{ text: string; images?: ImageContent[] }> = [];
  const settled: IncomingPrompt[] = [];
  const session = {
    isStreaming: true,
    async steer(text: string, images?: ImageContent[]) {
      calls.push({ text, images });
      steering.push(text);
      return 'queued' as const;
    },
    getSteeringMessages: () => steering,
    clearQueue: () => ({ steering: steering.splice(0), followUp: [] }),
  };
  const run = new PromptSteering(session, (prompt) => {
    settled.push(prompt);
  });
  const prompt = (text: string): IncomingPrompt => ({
    text,
    attachments: [],
    origin: { kind: 'user', channel: { id: 'telegram', kind: 'telegram' } },
  });
  return { run, session, steering, calls, settled, prompt };
}

test('steers text and images in the current run; holds the prompt until finish', async () => {
  const f = fixture();
  const prompt: IncomingPrompt = {
    text: 'Inspect this instead',
    attachments: [{ type: 'image', path: '/unused/image.png' }],
    origin: { kind: 'user', channel: { id: 'telegram', kind: 'telegram' } },
  };
  const images: ImageContent[] = [{ type: 'image', data: 'AA==', mimeType: 'image/png' }];
  assert.equal(await f.run.trySteer(prompt, { message: prompt.text, images }), true);
  assert.deepEqual(f.calls, [{ text: prompt.text, images }]);
  assert.equal(f.run.pendingCount, 1);
  // Pi hands it to the agent: no longer pending, but its attachments are still in use.
  f.steering.shift();
  assert.equal(f.run.pendingCount, 0);
  assert.deepEqual(f.settled, []);
  f.run.finish();
  assert.deepEqual(f.settled, [prompt]);
});

test('startup and the final agent_end return false instead of stranding a message', async () => {
  const f = fixture();
  const prompt = f.prompt('new');
  f.session.isStreaming = false;
  assert.equal(await f.run.trySteer(prompt, { message: prompt.text }), false);
  f.session.isStreaming = true;
  // A run the SDK is about to retry is still open.
  f.run.observe({ type: 'agent_end', messages: [], willRetry: true });
  assert.equal(await f.run.trySteer(prompt, { message: prompt.text }), true);
  f.run.observe({ type: 'agent_end', messages: [], willRetry: false });
  assert.equal(await f.run.trySteer(prompt, { message: prompt.text }), false);
  assert.equal(f.calls.length, 1);
});

test('abort discards pending steering but only releases attachments once idle', async () => {
  const f = fixture();
  const prompt = f.prompt('new');
  await f.run.trySteer(prompt, { message: prompt.text });
  f.run.cancel();
  assert.deepEqual(f.steering, []);
  assert.deepEqual(f.settled, []);
  assert.equal(await f.run.trySteer(prompt, { message: prompt.text }), false);
  f.run.finish();
  assert.deepEqual(f.settled, [prompt]);
});

test('failed steering is not accepted or settled', async () => {
  const f = fixture();
  f.session.steer = async () => {
    throw new Error('rejected');
  };
  await assert.rejects(f.run.trySteer(f.prompt('new'), { message: 'new' }), /rejected/);
  assert.equal(f.run.pendingCount, 0);
  f.run.finish();
  assert.deepEqual(f.settled, []);
});
