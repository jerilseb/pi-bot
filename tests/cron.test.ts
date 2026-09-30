import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planCronPass } from '../src/cron.ts';
import type { CronJob } from '../src/cron-store.ts';

/** What one scheduler pass fires, defers and disables; the controller writes it before firing. */

const now = new Date('2026-09-15T10:00:00.000Z');
const minutes = (n: number) => new Date(now.getTime() + n * 60_000).toISOString();

function task(id: string, nextRunAt: string | null, extra: Partial<CronJob> = {}): CronJob {
  return {
    id,
    chatId: 'ours',
    enabled: true,
    kind: 'interval',
    prompt: 'check',
    model: 'test/model',
    intervalMs: 3_600_000,
    nextRunAt,
    lastRunAt: null,
    createdAt: '2026-09-15T09:00:00.000Z',
    updatedAt: '2026-09-15T09:00:00.000Z',
    ...extra,
  };
}

function plan(jobs: CronJob[], backgroundBusy = false) {
  return planCronPass(jobs, { now, backgroundBusy, isAllowedChat: (chatId) => chatId === 'ours' });
}

test('a due task fires, and is already marked as run in what the pass writes', () => {
  const later = task('later', minutes(5));
  const pass = plan([task('due', minutes(-1)), later]);
  assert.equal(pass.due?.id, 'due');
  assert.equal(pass.changed, true);
  const [ran, untouched] = pass.jobs;
  assert.equal(ran.lastRunAt, now.toISOString());
  assert.ok(ran.nextRunAt && ran.nextRunAt > now.toISOString());
  assert.equal(untouched, later);
});

test('a one-time task that fires is disabled in the same write', () => {
  const pass = plan([task('once', minutes(-1), { kind: 'once', runAt: minutes(-1) })]);
  assert.equal(pass.due?.id, 'once');
  assert.equal(pass.jobs[0].enabled, false);
  assert.equal(pass.jobs[0].nextRunAt, null);
});

test('one task fires per pass, and the others due wait a minute', () => {
  const pass = plan([task('first', minutes(-2)), task('second', minutes(-1))]);
  assert.equal(pass.due?.id, 'first');
  assert.equal(pass.jobs[1].nextRunAt, minutes(1));
  assert.equal(pass.jobs[1].lastRunAt, null);
});

test('nothing fires while a background run is under way', () => {
  const pass = plan([task('due', minutes(-1))], true);
  assert.equal(pass.due, null);
  assert.equal(pass.jobs[0].nextRunAt, minutes(1));
  assert.equal(pass.changed, true);
});

test('a task from another chat is disabled, never fired', () => {
  const pass = plan([task('foreign', minutes(-1), { chatId: 'theirs' })]);
  assert.equal(pass.due, null);
  assert.equal(pass.jobs[0].enabled, false);
});

test('a pass with nothing due changes nothing, so nothing is written', () => {
  const jobs = [task('later', minutes(5)), task('off', minutes(-1), { enabled: false })];
  const pass = plan(jobs);
  assert.equal(pass.due, null);
  assert.equal(pass.changed, false);
  assert.deepEqual(pass.jobs, jobs);
});
