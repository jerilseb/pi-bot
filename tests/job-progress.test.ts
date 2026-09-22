import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { type ProgressTransport, startProgressMessage } from '../src/job-progress.ts';

/**
 * The progress message is best-effort UI on a timer, so what matters is its
 * ordering (the final state is always the last thing written, never overtaken
 * by a refresh) and that a Telegram failure degrades quietly instead of
 * spamming the chat or rejecting into the job.
 */

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('condition not reached');
}

const settle = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fakeTransport() {
  const calls: Array<[method: 'send' | 'edit', text: string, messageId?: number]> = [];
  const transport: ProgressTransport = {
    async send(html) {
      calls.push(['send', html]);
      return 42;
    },
    async edit(messageId, html) {
      calls.push(['edit', html, messageId]);
    },
  };
  return { calls, transport };
}

function quiet(t: TestContext): void {
  t.mock.method(console, 'error', () => {});
}

test('sends at once, edits only when the text changes, and ends on the final state', async () => {
  const { calls, transport } = fakeTransport();
  let state = 'running 1s';
  const progress = startProgressMessage(() => state, { transport, intervalMs: 5 });
  await until(() => calls.length === 1);
  assert.deepEqual(calls[0], ['send', 'running 1s']);

  await settle();
  assert.equal(calls.length, 1, 'unchanged text is not re-sent');

  state = 'running 20s';
  await until(() => calls.length === 2);
  assert.deepEqual(calls[1], ['edit', 'running 20s', 42]);

  state = 'done';
  await progress.finish();
  assert.deepEqual(calls.at(-1), ['edit', 'done', 42]);

  const count = calls.length;
  state = 'late';
  await settle();
  assert.equal(calls.length, count, 'nothing is written after finish');
  assert.equal(progress.finish(), progress.finish(), 'finish is idempotent');
});

test('the final state waits for a send still in flight rather than racing it', async () => {
  const calls: string[] = [];
  const pending: { release?: () => void } = {};
  const transport: ProgressTransport = {
    send: (html) =>
      new Promise((resolve) => {
        pending.release = () => {
          calls.push(`send ${html}`);
          resolve(1);
        };
      }),
    async edit(_id, html) {
      calls.push(`edit ${html}`);
    },
  };
  let state = 'running';
  const progress = startProgressMessage(() => state, { transport, intervalMs: 1_000 });
  await until(() => pending.release !== undefined);
  // The job settles while the first send is still waiting on Telegram.
  state = 'done';
  const finished = progress.finish();
  pending.release?.();
  await finished;
  assert.deepEqual(calls, ['send running', 'edit done']);
});

test('a failed send is retried on the next refresh', async (t) => {
  quiet(t);
  const { calls, transport } = fakeTransport();
  let failures = 1;
  const flaky: ProgressTransport = {
    ...transport,
    async send(html) {
      if (failures-- > 0) throw new Error('network down');
      return transport.send(html);
    },
  };
  const progress = startProgressMessage(() => 'running', { transport: flaky, intervalMs: 5 });
  await until(() => calls.length === 1);
  assert.deepEqual(calls[0], ['send', 'running']);
  await progress.finish();
});

test('a failed edit stops the updates instead of retrying every refresh', async (t) => {
  quiet(t);
  let edits = 0;
  const transport: ProgressTransport = {
    send: async () => 1,
    async edit() {
      edits++;
      throw new Error('message to edit not found');
    },
  };
  let tick = 0;
  const progress = startProgressMessage(() => `running ${tick++}`, { transport, intervalMs: 2 });
  await until(() => edits === 1);
  await settle();
  await progress.finish();
  assert.equal(edits, 1);
});

test('a render that throws is logged and does not reject', async (t) => {
  quiet(t);
  const { calls, transport } = fakeTransport();
  const progress = startProgressMessage(
    () => {
      throw new Error('bad render');
    },
    { transport, intervalMs: 5 },
  );
  await progress.finish();
  assert.deepEqual(calls, []);
});
