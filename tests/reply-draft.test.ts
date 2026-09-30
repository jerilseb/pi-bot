import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { createReplyDraft, type ReplyDraftOptions } from '../src/channels/telegram/reply-draft.ts';

const INTERVAL_MS = 40;

function start(): AgentSessionEvent {
  return { type: 'message_start', message: { role: 'assistant', content: [] } } as never;
}

function delta(text: string): AgentSessionEvent {
  return {
    type: 'message_update',
    message: { role: 'assistant', content: [] },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text },
  } as never;
}

function retry(): AgentSessionEvent {
  return { type: 'auto_retry_start', attempt: 1, maxAttempts: 4, delayMs: 0 } as never;
}

/** A draft whose sends are recorded, answered by `answer` (at once, by default). */
function recordedDraft(
  t: TestContext,
  options: Omit<ReplyDraftOptions, 'send'> & { answer?: (html: string) => Promise<void> } = {},
) {
  const sends: Array<{ draftId: number; html: string; at: number }> = [];
  const logged: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => logged.push(args.join(' ')));
  t.mock.method(console, 'error', (...args: unknown[]) => logged.push(args.join(' ')));
  const { answer, ...rest } = options;
  const draft = createReplyDraft({
    intervalMs: INTERVAL_MS,
    keepAliveMs: 60_000,
    ...rest,
    async send(draftId, html) {
      sends.push({ draftId, html, at: Date.now() });
      await answer?.(html);
    },
  });
  t.after(() => draft.stop());
  return { draft, sends, logged };
}

test('the first text is drafted at once, and later text an interval later, all together', async (t) => {
  const { draft, sends } = recordedDraft(t);
  draft.observe(start());
  draft.observe(delta('Hel'));
  await until(() => sends.length === 1);
  for (const piece of ['lo', ' **wor', 'ld**']) draft.observe(delta(piece));
  await until(() => sends.length === 2);

  assert.deepEqual(
    sends.map((send) => send.html),
    ['Hel', 'Hello <b>world</b>'],
  );
  assert.equal(
    sends[0]?.draftId,
    sends[1]?.draftId,
    'one draft, animated from one text to the next',
  );
  assert.ok((sends[1]?.at ?? 0) - (sends[0]?.at ?? 0) >= INTERVAL_MS - 2);
});

test("the draft holds each of the turn's messages, and drops one that is retried", async (t) => {
  const { draft, sends } = recordedDraft(t);
  for (const event of [start(), delta('Checking.'), start(), delta('Half an ans'), retry()]) {
    draft.observe(event);
  }
  draft.observe(start());
  draft.observe(delta('The answer'));
  await until(() => sends.at(-1)?.html === 'Checking.\n\nThe answer');
});

test('each turn has a draft of its own', async (t) => {
  const first = recordedDraft(t);
  const second = recordedDraft(t);
  first.draft.observe(delta('one'));
  second.draft.observe(delta('two'));
  await until(() => first.sends.length === 1 && second.sends.length === 1);
  assert.notEqual(first.sends[0]?.draftId, second.sends[0]?.draftId);
});

test('nothing is drafted before the turn is reached in the send queue', async (t) => {
  let reach = (): void => {};
  const after = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const { draft, sends } = recordedDraft(t, { after });
  draft.observe(delta('early'));
  await sleep(INTERVAL_MS);
  assert.equal(sends.length, 0);
  draft.observe(delta(' and more'));
  reach();
  await until(() => sends.length === 1);
  assert.equal(sends[0]?.html, 'early and more');
});

test('stop waits for the draft in flight, and nothing is drafted after it', async (t) => {
  let answer = (): void => {};
  const { draft, sends } = recordedDraft(t, {
    answer: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  draft.observe(delta('Hello'));
  await until(() => sends.length === 1);
  let settled = false;
  const stopped = draft.stop().then(() => {
    settled = true;
  });
  draft.observe(delta(' again'));
  await sleep(5);
  assert.equal(settled, false, 'the reply must wait for the draft in flight');
  answer();
  await stopped;
  await sleep(INTERVAL_MS * 2);
  assert.equal(sends.length, 1);
});

test('text that holds still is sent again, so the draft stays shown', async (t) => {
  const { draft, sends } = recordedDraft(t, { keepAliveMs: INTERVAL_MS });
  draft.observe(delta('Running the tests.'));
  await until(() => sends.length === 3);
  assert.deepEqual(new Set(sends.map((send) => send.html)), new Set(['Running the tests.']));
});

test('a rate limit pauses the draft for as long as Telegram asks', async (t) => {
  const { draft, sends, logged } = recordedDraft(t, {
    answer: async () => {
      throw new Error(
        'Telegram sendMessageDraft failed (429): {"ok":false,"error_code":429,"parameters":{"retry_after":30}}',
      );
    },
  });
  draft.observe(delta('Hello'));
  await until(() => sends.length === 1);
  draft.observe(delta(' world'));
  await sleep(INTERVAL_MS * 3);
  assert.equal(sends.length, 1);
  assert.match(logged.join('\n'), /limiting drafts; the next in 30s/);
});

test('any other refusal ends the draft for the turn', async (t) => {
  const { draft, sends, logged } = recordedDraft(t, {
    answer: async () => {
      throw new Error('Telegram sendMessageDraft failed (400): {"ok":false}');
    },
  });
  draft.observe(delta('Hello'));
  await until(() => sends.length === 1);
  draft.observe(delta(' world'));
  await sleep(INTERVAL_MS * 3);
  assert.equal(sends.length, 1);
  assert.match(logged.join('\n'), /reply will arrive whole/);
  await draft.stop();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(2);
  }
  assert.fail('condition not reached');
}
