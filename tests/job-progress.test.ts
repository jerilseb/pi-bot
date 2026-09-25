import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  createWriteGate,
  jobStopCallbackData,
  type ProgressContent,
  type ProgressMessageOptions,
  type ProgressTransport,
  parseJobStopCallback,
  startProgressMessage,
} from '../src/channels/telegram/job-progress.ts';

/**
 * The progress message is best-effort UI kept current by the bot, so what
 * matters is its ordering (the final state is always the last thing written,
 * never overtaken by a refresh), its pacing (changes coalesce, taps do not
 * wait), and that a Telegram failure degrades quietly instead of spamming the
 * chat or rejecting into the job.
 */

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('condition not reached');
}

const settle = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const content = (html: string): ProgressContent => ({ html, keyboard: [] });

function fakeTransport() {
  const calls: Array<[method: 'send' | 'edit', html: string, messageId?: number]> = [];
  const transport: ProgressTransport = {
    async send({ html }) {
      calls.push(['send', html]);
      return 42;
    },
    async edit(messageId, { html }) {
      calls.push(['edit', html, messageId]);
    },
  };
  return { calls, transport };
}

/** Fast defaults: no shared gate, short intervals, a heartbeat that never fires on its own. */
function options(overrides: ProgressMessageOptions): ProgressMessageOptions {
  return { minIntervalMs: 1, heartbeatMs: 60_000, gate: createWriteGate(0), ...overrides };
}

function quiet(t: TestContext): void {
  t.mock.method(console, 'error', () => {});
}

test('sends at once, edits only when the content changes, and ends on the final state', async () => {
  const { calls, transport } = fakeTransport();
  let state = 'running 1s';
  const progress = startProgressMessage(() => content(state), options({ transport }));
  await until(() => calls.length === 1);
  assert.deepEqual(calls[0], ['send', 'running 1s']);

  progress.refresh();
  await settle();
  assert.equal(calls.length, 1, 'unchanged content is not re-sent');

  state = 'running 20s';
  progress.refresh();
  await until(() => calls.length === 2);
  assert.deepEqual(calls[1], ['edit', 'running 20s', 42]);

  state = 'done';
  await progress.finish();
  assert.deepEqual(calls.at(-1), ['edit', 'done', 42]);

  const count = calls.length;
  state = 'late';
  progress.refresh();
  progress.refreshNow();
  await settle();
  assert.equal(calls.length, count, 'nothing is written after finish');
  assert.equal(progress.finish(), progress.finish(), 'finish is idempotent');
});

test('a change to the buttons alone is written, and the keyboard goes with every write', async () => {
  const writes: ProgressContent[] = [];
  const transport: ProgressTransport = {
    async send(written) {
      writes.push(written);
      return 1;
    },
    async edit(_id, written) {
      writes.push(written);
    },
  };
  const stop = [[{ text: '⏹ Stop', callback_data: 'stop:bg_1' }]];
  let keyboard = stop;
  const progress = startProgressMessage(() => ({ html: 'same', keyboard }), options({ transport }));
  await until(() => writes.length === 1);
  keyboard = [];
  await progress.finish();
  assert.deepEqual(writes, [
    { html: 'same', keyboard: stop },
    { html: 'same', keyboard: [] },
  ]);
});

test('the final state waits for a send still in flight rather than racing it', async () => {
  const calls: string[] = [];
  const pending: { release?: () => void } = {};
  const transport: ProgressTransport = {
    send: ({ html }) =>
      new Promise((resolve) => {
        pending.release = () => {
          calls.push(`send ${html}`);
          resolve(1);
        };
      }),
    async edit(_id, { html }) {
      calls.push(`edit ${html}`);
    },
  };
  let state = 'running';
  const progress = startProgressMessage(() => content(state), options({ transport }));
  await until(() => pending.release !== undefined);
  // The job settles while the first send is still waiting on Telegram.
  state = 'done';
  const finished = progress.finish();
  pending.release?.();
  await finished;
  assert.deepEqual(calls, ['send running', 'edit done']);
});

test('a job that ends before the first send gets one message, in its final state', async () => {
  const { calls, transport } = fakeTransport();
  const progress = startProgressMessage(() => content('done'), options({ transport }));
  await progress.finish();
  assert.deepEqual(calls, [['send', 'done']]);
});

test('a burst of changes is coalesced into one edit showing the latest state', async () => {
  const { calls, transport } = fakeTransport();
  let state = 'tool 0';
  const progress = startProgressMessage(
    () => content(state),
    options({ transport, minIntervalMs: 40 }),
  );
  await until(() => calls.length === 1);
  for (let i = 1; i <= 5; i++) {
    state = `tool ${i}`;
    progress.refresh();
  }
  await settle(10);
  assert.equal(calls.length, 1, 'no edit inside the minimum interval');
  await until(() => calls.length === 2);
  assert.deepEqual(calls[1], ['edit', 'tool 5', 42]);
  await settle(60);
  assert.equal(calls.length, 2);
  await progress.finish();
});

test('refreshNow writes at once, without waiting out the interval', async () => {
  const { calls, transport } = fakeTransport();
  let state = 'running';
  const progress = startProgressMessage(
    () => content(state),
    options({ transport, minIntervalMs: 60_000 }),
  );
  await until(() => calls.length === 1);
  state = 'stopping…';
  progress.refreshNow();
  await until(() => calls.length === 2);
  assert.deepEqual(calls[1], ['edit', 'stopping…', 42]);
  await progress.finish();
});

test('the heartbeat re-renders with no change reported', async () => {
  const { calls, transport } = fakeTransport();
  let tick = 0;
  const progress = startProgressMessage(
    () => content(`running ${tick++}`),
    options({ transport, heartbeatMs: 5 }),
  );
  await until(() => calls.length >= 3);
  await progress.finish();
});

test('a failed send is retried once the heartbeat interval has passed', async (t) => {
  quiet(t);
  const { calls, transport } = fakeTransport();
  let failures = 1;
  const flaky: ProgressTransport = {
    ...transport,
    async send(written) {
      if (failures-- > 0) throw new Error('network down');
      return transport.send(written);
    },
  };
  const progress = startProgressMessage(
    () => content('running'),
    options({ transport: flaky, heartbeatMs: 30 }),
  );
  const started = Date.now();
  await until(() => calls.length === 1);
  assert.deepEqual(calls[0], ['send', 'running']);
  assert.ok(Date.now() - started >= 25, 'the retry waited out the heartbeat');
  await progress.finish();
});

test('after a failed edit, a change waits for the heartbeat rather than retrying at once', async (t) => {
  quiet(t);
  let edits = 0;
  let failing = true;
  const transport: ProgressTransport = {
    send: async () => 1,
    async edit() {
      edits++;
      if (failing) throw new Error('Too Many Requests: retry after 30');
    },
  };
  let state = 'running 0';
  const progress = startProgressMessage(
    () => content(state),
    options({ transport, heartbeatMs: 50 }),
  );
  await settle(5);
  state = 'running 1';
  progress.refresh();
  await until(() => edits === 1);
  failing = false;
  state = 'running 2';
  progress.refresh();
  await settle(15);
  assert.equal(edits, 1, 'no retry inside the heartbeat interval');
  await until(() => edits === 2);
  await progress.finish();
});

test('updates stop after five failed writes in a row, but the final state is still tried', async (t) => {
  quiet(t);
  const edited: string[] = [];
  const transport: ProgressTransport = {
    send: async () => 1,
    async edit(_id, { html }) {
      edited.push(html);
      throw new Error('message to edit not found');
    },
  };
  let tick = 0;
  let state: string | null = null;
  const progress = startProgressMessage(
    () => content(state ?? `running ${tick++}`),
    options({ transport, heartbeatMs: 2 }),
  );
  await until(() => edited.length === 5);
  await settle();
  assert.equal(edited.length, 5, 'no further routine edits once it gave up');
  progress.refreshNow();
  await settle(5);
  assert.equal(edited.length, 5, 'a tap does not revive it either');

  state = 'done';
  await progress.finish();
  assert.deepEqual(edited.at(-1), 'done');
  assert.equal(edited.length, 6);
});

test('a success resets the failure count', async (t) => {
  quiet(t);
  let edits = 0;
  const transport: ProgressTransport = {
    send: async () => 1,
    async edit() {
      edits++;
      // Every fifth edit succeeds, so there are never five failures in a row.
      if (edits % 5 !== 0) throw new Error('flaky');
    },
  };
  let tick = 0;
  const progress = startProgressMessage(
    () => content(`running ${tick++}`),
    options({ transport, heartbeatMs: 1 }),
  );
  await until(() => edits >= 12);
  await progress.finish();
});

test('a render that throws is logged and does not reject', async (t) => {
  quiet(t);
  const { calls, transport } = fakeTransport();
  const progress = startProgressMessage(() => {
    throw new Error('bad render');
  }, options({ transport }));
  await progress.finish();
  assert.deepEqual(calls, []);
});

test('the shared gate spaces routine edits across messages, but not first sends', async () => {
  const gate = createWriteGate(40);
  const times: Array<[method: string, at: number]> = [];
  const transport: ProgressTransport = {
    async send() {
      times.push(['send', Date.now()]);
      return 1;
    },
    async edit() {
      times.push(['edit', Date.now()]);
    },
  };
  let state = 'a';
  const first = startProgressMessage(() => content(`first ${state}`), options({ transport, gate }));
  const second = startProgressMessage(
    () => content(`second ${state}`),
    options({ transport, gate }),
  );
  await until(() => times.length === 2);
  const [sendA, sendB] = times;
  assert.ok(sendA && sendB);
  assert.ok(sendB[1] - sendA[1] < 30, 'first sends go out at once');

  state = 'b';
  first.refresh();
  second.refresh();
  await until(() => times.length === 4);
  const [, , editA, editB] = times;
  assert.ok(editA && editB);
  assert.ok(editA[1] - sendB[1] >= 35, 'an edit keeps its distance from the last send');
  assert.ok(editB[1] - editA[1] >= 35, 'two messages do not edit at once');
  await Promise.all([first.finish(), second.finish()]);
});

test('the final state does not wait at the gate', async () => {
  const gate = createWriteGate(60_000);
  const { calls, transport } = fakeTransport();
  let state = 'running';
  const progress = startProgressMessage(() => content(state), options({ transport, gate }));
  await until(() => calls.length === 1);
  state = 'done';
  await progress.finish();
  assert.deepEqual(calls.at(-1), ['edit', 'done', 42]);
});

test('a Stop button names the job, and a task for a sub-agent', () => {
  assert.equal(jobStopCallbackData('bg_1a2b3c'), 'stop:bg_1a2b3c');
  assert.equal(jobStopCallbackData('sub_1a2b3c', 2), 'stop:sub_1a2b3c:2');
  assert.deepEqual(parseJobStopCallback('bg_1a2b3c'), { jobId: 'bg_1a2b3c' });
  assert.deepEqual(parseJobStopCallback('sub_1a2b3c:2'), { jobId: 'sub_1a2b3c', taskNumber: 2 });
  assert.equal(parseJobStopCallback('sub_1a2b3c:x'), null);
  assert.equal(parseJobStopCallback(''), null);
});
