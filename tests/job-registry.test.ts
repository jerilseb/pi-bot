import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { captureJobOrigin, type Job, JobRegistry, jobReportPrompt } from '../src/job-registry.ts';

/**
 * The parts of a background job that background bash and sub-agents share:
 * where a report goes back to, and the yield-then-background step that decides
 * whether a report is ever sent at all.
 */

type Terminal = 'done' | 'cancelled';
type TestJob = Job<Terminal> & { finish: () => void };

function registry() {
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
  });
}

function job(reg: JobRegistry<Terminal, TestJob, { id: string }>): TestJob {
  let resolve = () => {};
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const created: TestJob = {
    id: reg.allocateId(),
    status: 'running',
    statusDetail: null,
    startedAt: Date.now(),
    endedAt: null,
    backgrounded: false,
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
    { text: 'done', source: 'subagent-report', label: 'the task' },
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
    { text: 'done', source: 'background-bash-report', label: 'cmd' },
  );
  assert.equal(pinned.session, 'background');
  assert.equal(pinned.model, 'test/job');

  const unpinned = jobReportPrompt(
    { session: 'background' },
    { text: 'done', source: 'background-bash-report', label: 'cmd' },
  );
  assert.equal(unpinned.model, undefined);
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
