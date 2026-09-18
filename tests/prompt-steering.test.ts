import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ImageContent } from '@earendil-works/pi-ai';
import { PromptSteering, type SteeringDisposition } from '../src/prompt-steering.ts';
import type { IncomingPrompt } from '../src/types.ts';

function fixture() {
  const steering: string[] = [];
  const followUp: string[] = [];
  const calls: Array<{ text: string; images?: ImageContent[] }> = [];
  const settled: Array<{ prompt: IncomingPrompt; disposition: SteeringDisposition }> = [];
  const session = {
    isStreaming: true,
    async steer(text: string, images?: ImageContent[]) {
      calls.push({ text, images });
      steering.push(text);
    },
    async followUp(text: string) {
      followUp.push(text);
    },
    getSteeringMessages: () => steering,
    clearQueue: () => ({ steering: steering.splice(0), followUp: followUp.splice(0) }),
  };
  const run = new PromptSteering(session, (prompt, disposition) => {
    settled.push({ prompt, disposition });
  });
  const prompt = (text: string): IncomingPrompt => ({ text, attachments: [] });
  const deliver = (text: string) => {
    const index = steering.indexOf(text);
    if (index !== -1) steering.splice(index, 1);
    run.observe({ type: 'queue_update', steering: [...steering], followUp: [...followUp] });
  };
  return { run, session, steering, followUp, calls, settled, prompt, deliver };
}

test('steers text and images in the current run; retains attachments until finish', async () => {
  const f = fixture();
  const prompt: IncomingPrompt = {
    text: 'Inspect this instead',
    attachments: [{ type: 'image', path: '/unused/image.png' }],
  };
  const images: ImageContent[] = [{ type: 'image', data: 'AA==', mimeType: 'image/png' }];
  assert.equal(await f.run.trySteer(prompt, { message: prompt.text, images }), true);
  assert.deepEqual(f.calls, [{ text: prompt.text, images }]);
  assert.equal(f.run.pendingCount, 1);
  f.deliver(prompt.text);
  assert.equal(f.run.pendingCount, 0);
  assert.deepEqual(f.settled, []);
  await f.run.finish();
  assert.deepEqual(f.settled, [{ prompt, disposition: 'done' }]);
});

test('startup and agent_end return false instead of stranding a message', async () => {
  const f = fixture();
  const prompt = f.prompt('new');
  f.session.isStreaming = false;
  assert.equal(await f.run.trySteer(prompt, { message: prompt.text }), false);
  f.session.isStreaming = true;
  f.run.observe({ type: 'agent_end', messages: [], willRetry: false });
  assert.equal(await f.run.trySteer(prompt, { message: prompt.text }), false);
  assert.deepEqual(f.calls, []);
});

test('messages accepted after the final SDK poll are deferred in order, not lost', async () => {
  const f = fixture();
  const first = f.prompt('first');
  const second = f.prompt('second');
  await f.run.trySteer(first, { message: first.text });
  await f.run.trySteer(second, { message: second.text });
  f.run.observe({ type: 'agent_end', messages: [], willRetry: false });
  await f.run.finish();
  assert.deepEqual(f.steering, []);
  assert.deepEqual(f.settled, [
    { prompt: first, disposition: 'deferred' },
    { prompt: second, disposition: 'deferred' },
  ]);
});

test('identical messages are tracked separately', async () => {
  const f = fixture();
  const first = f.prompt('same');
  const second = f.prompt('same');
  await f.run.trySteer(first, { message: first.text });
  await f.run.trySteer(second, { message: second.text });
  f.deliver('same');
  await f.run.finish();
  assert.deepEqual(f.settled, [
    { prompt: first, disposition: 'done' },
    { prompt: second, disposition: 'deferred' },
  ]);
});

test('uses SDK-expanded text to identify delivered messages', async () => {
  const f = fixture();
  f.session.steer = async () => {
    f.steering.push('expanded');
  };
  const prompt = f.prompt('original');
  await f.run.trySteer(prompt, { message: prompt.text });
  f.deliver('expanded');
  await f.run.finish();
  assert.equal(f.settled[0]?.disposition, 'done');
});

test('abort discards pending steering but only releases attachments once idle', async () => {
  const f = fixture();
  const prompt = f.prompt('new');
  await f.run.trySteer(prompt, { message: prompt.text });
  f.run.cancel();
  assert.deepEqual(f.steering, []);
  assert.deepEqual(f.settled, []);
  assert.equal(await f.run.trySteer(prompt, { message: prompt.text }), false);
  await f.run.finish();
  assert.deepEqual(f.settled, [{ prompt, disposition: 'done' }]);
});

test('failed steering is not accepted or settled twice', async () => {
  const f = fixture();
  f.session.steer = async () => {
    throw new Error('rejected');
  };
  await assert.rejects(f.run.trySteer(f.prompt('new'), { message: 'new' }), /rejected/);
  assert.equal(f.run.pendingCount, 0);
  await f.run.finish();
  assert.deepEqual(f.settled, []);
});

test('deferral does not discard native SDK messages queued by extensions', async () => {
  const f = fixture();
  const prompt = f.prompt('new');
  await f.run.trySteer(prompt, { message: prompt.text });
  f.steering.push('extension steering');
  f.followUp.push('extension follow-up');
  await f.run.finish();
  assert.deepEqual(f.steering, ['extension steering']);
  assert.deepEqual(f.followUp, ['extension follow-up']);
  assert.equal(f.settled[0]?.disposition, 'deferred');
});
