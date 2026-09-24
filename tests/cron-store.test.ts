import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CronJob, formatCronJob, formatLocalTime, resolveRunAt } from '../src/cron-store.ts';

const base: CronJob = {
  id: 'job_1',
  chatId: '1',
  enabled: true,
  kind: 'interval',
  prompt: 'check',
  model: 'openai-codex/gpt-5.6-luna',
  intervalMs: 120_000,
  nextRunAt: '2026-09-15T10:00:00.000Z',
  lastRunAt: null,
  createdAt: '2026-09-15T09:00:00.000Z',
  updatedAt: '2026-09-15T09:00:00.000Z',
};

test('formatCronJob always shows the pinned model', () => {
  assert.equal(
    formatCronJob(base),
    'job_1 — enabled, every 2 minutes, model: openai-codex/gpt-5.6-luna, next: Tue 2026-09-15 10:00 (UTC)',
  );
});

test('formatCronJob includes the title and a per-task model', () => {
  assert.equal(
    formatCronJob({ ...base, title: 'Mail', model: 'openrouter/moonshotai/kimi-k2.6' }),
    'job_1 — Mail enabled, every 2 minutes, model: openrouter/moonshotai/kimi-k2.6, next: Tue 2026-09-15 10:00 (UTC)',
  );
});

test('formatCronJob shows a one-time task in its own timezone', () => {
  const once: CronJob = {
    ...base,
    kind: 'once',
    runAt: '2026-09-25T03:30:00.000Z',
    timezone: 'Asia/Kolkata',
    nextRunAt: '2026-09-25T03:30:00.000Z',
  };
  delete once.intervalMs;
  assert.equal(
    formatCronJob(once),
    'job_1 — enabled, once at Fri 2026-09-25 09:00 (Asia/Kolkata), model: openai-codex/gpt-5.6-luna, next: Fri 2026-09-25 09:00 (Asia/Kolkata)',
  );
});

const iso = (runAt: string, timezone?: string) => resolveRunAt(runAt, timezone).toISOString();

test('resolveRunAt reads a local run_at in the given timezone, not the server one', () => {
  // "Remind me at 9am tomorrow" once fired at 14:30 IST, read as UTC.
  assert.equal(iso('2026-09-25T09:00:00', 'Asia/Kolkata'), '2026-09-25T03:30:00.000Z');
  assert.equal(iso('2026-09-25T09:00', 'Asia/Kolkata'), '2026-09-25T03:30:00.000Z');
  assert.equal(iso('2026-09-25 09:00:30.5', 'Asia/Kolkata'), '2026-09-25T03:30:30.500Z');
});

test('resolveRunAt takes a run_at with an offset as written, whatever the timezone', () => {
  assert.equal(iso('2026-09-25T09:00:00+05:30'), '2026-09-25T03:30:00.000Z');
  assert.equal(iso('2026-09-25T09:00:00Z'), '2026-09-25T09:00:00.000Z');
  assert.equal(iso('2026-09-25T09:00:00-0400', 'Asia/Kolkata'), '2026-09-25T13:00:00.000Z');
});

test('resolveRunAt follows daylight saving, on either side of the change', () => {
  assert.equal(iso('2026-07-01T09:00:00', 'America/New_York'), '2026-07-01T13:00:00.000Z');
  assert.equal(iso('2026-12-01T09:00:00', 'America/New_York'), '2026-12-01T14:00:00.000Z');
  // New York springs forward at 02:00 on 2026-03-08.
  assert.equal(iso('2026-03-08T01:30:00', 'America/New_York'), '2026-03-08T06:30:00.000Z');
  assert.equal(iso('2026-03-08T03:30:00', 'America/New_York'), '2026-03-08T07:30:00.000Z');
});

test('resolveRunAt rejects a run_at it cannot place', () => {
  assert.throws(() => resolveRunAt('2026-09-25T09:00:00'), /no UTC offset.*timezone/);
  assert.throws(() => resolveRunAt('2026-09-25', 'Asia/Kolkata'), /ISO date and time/);
  assert.throws(() => resolveRunAt('2026-02-30T09:00:00', 'Asia/Kolkata'), /not a valid date/);
  assert.throws(() => resolveRunAt('2026-09-25T24:00:00', 'Asia/Kolkata'), /not a valid date/);
  assert.throws(() => resolveRunAt('2026-09-25T09:00:00', 'Asia/Bangalore'), /Unknown timezone/);
});

test('formatLocalTime labels its zone, shows seconds only when set, and falls back to UTC', () => {
  assert.equal(formatLocalTime('2026-09-25T03:30:00.000Z'), 'Fri 2026-09-25 03:30 (UTC)');
  assert.equal(
    formatLocalTime('2026-09-25T03:30:15.000Z', 'Asia/Kolkata'),
    'Fri 2026-09-25 09:00:15 (Asia/Kolkata)',
  );
  assert.equal(
    formatLocalTime('2026-09-24T18:30:00.000Z', 'Asia/Kolkata'),
    'Fri 2026-09-25 00:00 (Asia/Kolkata)',
  );
  assert.equal(
    formatLocalTime('2026-09-25T03:30:00.000Z', 'Not/AZone'),
    'Fri 2026-09-25 03:30 (UTC)',
  );
});
