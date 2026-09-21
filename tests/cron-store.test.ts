import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CronJob, formatCronJob } from '../src/cron-store.ts';

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
    'job_1 — enabled, every 2 minutes, model: openai-codex/gpt-5.6-luna, next: 2026-09-15T10:00:00.000Z',
  );
});

test('formatCronJob includes the title and a per-task model', () => {
  assert.equal(
    formatCronJob({ ...base, title: 'Mail', model: 'openrouter/moonshotai/kimi-k2.6' }),
    'job_1 — Mail enabled, every 2 minutes, model: openrouter/moonshotai/kimi-k2.6, next: 2026-09-15T10:00:00.000Z',
  );
});
