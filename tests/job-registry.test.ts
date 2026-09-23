import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ProgressTransport } from '../src/job-progress.ts';
import { captureJobOrigin, type Job, JobRegistry, jobReportPrompt } from '../src/job-registry.ts';
import { notifySteeringMessage } from '../src/steering-signal.ts';
import type { SessionKind } from '../src/types.ts';

/**
 * The parts of a background job that background bash and sub-agents share:
 * where a report goes back to, and the yield-then-background step that decides
 * whether a report is ever sent at all.
 */

type Terminal = 'done' | 'cancelled';
type TestJob = Job<Terminal> & { finish: () => void };

function registry(
  extra: Partial<
    ConstructorParameters<typeof JobRegistry<Terminal, TestJob, { id: string }>>[0]
  > = {},
) {
  return new JobRegistry<Terminal, TestJob, { id: string }>({
    idPrefix: 'job',
    jobNoun: 'test job',
    jobNounPlural: 'test jobs',
    listToolName: 'job_list',
    completedTtlMs: 60_000,
    cancelWaitMs: 10,
    cancelledStatus: 'cancelled',
    signalCancel: (job) => job.finish(),
    describeStatus: (job) => job.status,
    buildReport: (job) => ({ id: job.id }),
    ...extra,
  });
}

/** A registry that renders progress into a fake transport. */
function progressRegistry() {
  const calls: Array<[method: string, text: string]> = [];
  const transport: ProgressTransport = {
    async send(html) {
      calls.push(['send', html]);
      return 1;
    },
    async edit(_id, html) {
      calls.push(['edit', html]);
    },
  };
  const reg = registry({
    renderProgress: (job) => `${job.id} ${job.status}`,
    progressOptions: { transport, intervalMs: 60_000 },
  });
  const reports: string[] = [];
  reg.setReportHandler(async (report) => {
    // The report must follow the final progress edit, never precede it.
    reports.push(`${report.id} after ${calls.at(-1)?.[1] ?? 'nothing'}`);
  });
  return { reg, calls, reports };
}

function job(
  reg: JobRegistry<Terminal, TestJob, { id: string }>,
  session: SessionKind = 'chat',
): TestJob {
  let resolve = () => {};
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const created: TestJob = {
    id: reg.allocateId(),
    origin: { session },
    status: 'running',
    statusDetail: null,
    startedAt: Date.now(),
    endedAt: null,
    backgrounded: false,
    resultRead: false,
    done,
    finish() {
      if (created.status === 'running') created.status = 'done';
      created.endedAt = Date.now();
      resolve();
    },
  };
  reg.register(created);
  return created;
}

test('a job that settles within the yield is forgotten and not backgrounded', async () => {
  const reg = registry();
  const j = job(reg);
  setTimeout(() => j.finish(), 5);
  assert.equal(await reg.settleOrBackground(j, 1_000), false);
  assert.equal(j.backgrounded, false);
  assert.equal(reg.get(j.id), null);
});

test('a job still running after the yield is backgrounded and kept', async () => {
  const reg = registry();
  const j = job(reg);
  assert.equal(await reg.settleOrBackground(j, 5), true);
  assert.equal(j.backgrounded, true);
  assert.equal(reg.get(j.id), j);
  j.finish();
});

test('a report returns to the chat session on whatever model the chat is using', () => {
  const prompt = jobReportPrompt(
    { session: 'chat', model: 'test/old' },
    { text: 'done', source: 'subagent-report', label: 'the task', isSuperseded: () => false },
  );
  assert.equal(prompt.session, 'chat');
  assert.equal(prompt.source, 'subagent-report');
  assert.equal(prompt.suppressNoop, true);
  assert.equal(prompt.label, 'the task');
  assert.equal(prompt.model, undefined);
  assert.deepEqual(prompt.attachments, []);
});

test('a report to the background session pins the model that started the job', () => {
  const pinned = jobReportPrompt(
    { session: 'background', model: 'test/job' },
    { text: 'done', source: 'background-bash-report', label: 'cmd', isSuperseded: () => false },
  );
  assert.equal(pinned.session, 'background');
  assert.equal(pinned.model, 'test/job');

  const unpinned = jobReportPrompt(
    { session: 'background' },
    { text: 'done', source: 'background-bash-report', label: 'cmd', isSuperseded: () => false },
  );
  assert.equal(unpinned.model, undefined);
});

test('a report to the background session resumes the transcript of the run that started the job', () => {
  const background = jobReportPrompt(
    { session: 'background', model: 'test/job', sessionFile: '/bg/run-a.jsonl' },
    { text: 'done', source: 'subagent-report', label: 'task', isSuperseded: () => false },
  );
  assert.equal(background.resumeSessionFile, '/bg/run-a.jsonl');

  // The chat keeps one conversation, so its reports never name a transcript.
  const chat = jobReportPrompt(
    { session: 'chat', sessionFile: '/sessions/chat.jsonl' },
    { text: 'done', source: 'subagent-report', label: 'task', isSuperseded: () => false },
  );
  assert.equal(chat.resumeSessionFile, undefined);
});

test('a report is superseded once the starting session reads the settled result', () => {
  const reg = registry();
  const j = job(reg);
  j.backgrounded = true;

  reg.markResultRead(j, 'chat');
  assert.equal(reg.isReportSuperseded(j.id), false, 'a running job has no result to read yet');

  j.finish();
  assert.equal(reg.isReportSuperseded(j.id), false, 'settling alone does not supersede it');
  reg.markResultRead(j, 'chat');
  assert.equal(reg.isReportSuperseded(j.id), true);
});

test('a read from the other session leaves the report in place', () => {
  const reg = registry();
  const j = job(reg, 'background');
  j.finish();
  reg.markResultRead(j, 'chat');
  assert.equal(reg.isReportSuperseded(j.id), false);
  reg.markResultRead(j, 'background');
  assert.equal(reg.isReportSuperseded(j.id), true);
});

test('a report for a job the registry no longer knows is not superseded', () => {
  assert.equal(registry().isReportSuperseded('job_gone'), false);
});

test('the report prompt carries the check for when it is about to run', () => {
  let read = false;
  const prompt = jobReportPrompt(
    { session: 'chat' },
    { text: 'done', source: 'subagent-report', label: 'the task', isSuperseded: () => read },
  );
  assert.equal(prompt.isSuperseded?.(), false);
  read = true;
  assert.equal(prompt.isSuperseded?.(), true);
});

test('a backgrounded chat job shows progress that ends on its outcome before the report', async () => {
  const { reg, calls, reports } = progressRegistry();
  const j = job(reg);
  assert.equal(await reg.settleOrBackground(j, 5), true);
  j.finish();
  await reg.settled(j);
  assert.deepEqual(calls, [
    ['send', `${j.id} running`],
    ['edit', `${j.id} done`],
  ]);
  assert.deepEqual(reports, [`${j.id} after ${j.id} done`]);
});

test('a job that settles within the yield never gets a progress message', async () => {
  const { reg, calls } = progressRegistry();
  const j = job(reg);
  setTimeout(() => j.finish(), 1);
  assert.equal(await reg.settleOrBackground(j, 1_000), false);
  await reg.settled(j);
  assert.deepEqual(calls, []);
});

test('a job the background session started runs without a progress message', async () => {
  const { reg, calls } = progressRegistry();
  const j = job(reg, 'background');
  assert.equal(await reg.settleOrBackground(j, 5), true);
  j.finish();
  await reg.settled(j);
  assert.deepEqual(calls, []);
});

test('cancelling shows the stop even if the runner never settles in time', async () => {
  const { reg, calls, reports } = progressRegistry();
  const j = job(reg);
  assert.equal(await reg.settleOrBackground(j, 5), true);
  // A runner that ignores the signal, as at shutdown before the process exits.
  j.finish = () => {};
  await reg.cancel([j]);
  assert.deepEqual(calls.at(-1), ['edit', `${j.id} cancelled`]);
  assert.deepEqual(reports, []);
});

test('a wait returns when the job settles', async () => {
  const reg = registry();
  const j = job(reg);
  setTimeout(() => j.finish(), 5);
  assert.equal(await reg.waitFor(j, { timeoutMs: 1_000, session: 'chat' }), 'settled');
  assert.equal(await reg.waitFor(j, { timeoutMs: 1_000, session: 'chat' }), 'settled');
});

test('a wait gives up at its timeout while the job keeps running', async () => {
  const reg = registry();
  const j = job(reg);
  assert.equal(await reg.waitFor(j, { timeoutMs: 5, session: 'chat' }), 'timeout');
  assert.equal(j.status, 'running');
  j.finish();
});

test('a message steered into the waiting session ends the wait, and only that session', async () => {
  const reg = registry();
  const j = job(reg);
  const waiting = reg.waitFor(j, { timeoutMs: 1_000, session: 'chat' });
  notifySteeringMessage('background');
  const early = await Promise.race([waiting, new Promise((r) => setTimeout(() => r('still'), 10))]);
  assert.equal(early, 'still', 'a message to the other session is not for this turn');
  notifySteeringMessage('chat');
  assert.equal(await waiting, 'interrupted');
  j.finish();
});

test('aborting the turn ends the wait', async () => {
  const reg = registry();
  const j = job(reg);
  const controller = new AbortController();
  const waiting = reg.waitFor(j, { timeoutMs: 1_000, session: 'chat', signal: controller.signal });
  controller.abort();
  assert.equal(await waiting, 'aborted');
  j.finish();
});

test('a wait ends once its until condition holds, checked while it waits', async () => {
  const reg = registry();
  const j = job(reg);
  let ready = false;
  setTimeout(() => {
    ready = true;
  }, 5);
  const outcome = await reg.waitFor(j, {
    timeoutMs: 1_000,
    session: 'chat',
    until: () => ready,
    checkMs: 1,
  });
  assert.equal(outcome, 'matched');
  j.finish();
});

test('the origin records the session and the model the turn is on, when there is one', () => {
  const withModel = { model: { provider: 'test', id: 'm' } } as unknown as ExtensionContext;
  assert.deepEqual(captureJobOrigin(withModel, 'background'), {
    session: 'background',
    model: 'test/m',
  });
  const without = { model: undefined } as unknown as ExtensionContext;
  assert.deepEqual(captureJobOrigin(without, 'chat'), { session: 'chat' });
});

test('the origin records the transcript of the starting turn', () => {
  const context = {
    model: undefined,
    sessionManager: { getSessionFile: () => '/bg/run-a.jsonl' },
  } as unknown as ExtensionContext;
  assert.deepEqual(captureJobOrigin(context, 'background'), {
    session: 'background',
    sessionFile: '/bg/run-a.jsonl',
  });
});
