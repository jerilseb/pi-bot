import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { CRON_JOBS_PATH, FILES_DIR, getPrimaryTelegramChatId } from './config.ts';

export type CronJobKind = 'once' | 'interval' | 'cron';

export interface CronJob {
  id: string;
  chatId: string;
  enabled: boolean;
  kind: CronJobKind;
  title?: string;
  prompt: string;
  runAt?: string;
  intervalMs?: number;
  schedule?: string;
  timezone?: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCronJobInput {
  chatId: string;
  kind: CronJobKind;
  prompt: string;
  title?: string;
  runAt?: string;
  intervalMs?: number;
  schedule?: string;
  timezone?: string;
  enabled?: boolean;
}

export interface UpdateCronJobInput {
  enabled?: boolean;
  kind?: CronJobKind;
  prompt?: string;
  title?: string;
  runAt?: string;
  intervalMs?: number;
  schedule?: string;
  timezone?: string;
}

type CronJobsChangedListener = () => void;

const listeners = new Set<CronJobsChangedListener>();

export function ensureCronJobsFile(): void {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  if (!fs.existsSync(CRON_JOBS_PATH)) {
    writeCronJobsFile([]);
  }
}

export function readCronJobs(): CronJob[] {
  ensureCronJobsFile();
  const content = fs.readFileSync(CRON_JOBS_PATH, 'utf8').trim();
  if (!content) return [];

  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${CRON_JOBS_PATH} must contain a JSON array`);
  }

  const hasLegacyJobs = parsed.some((job) => !hasCronJobChatId(job));
  const legacyChatId = hasLegacyJobs ? getPrimaryTelegramChatId() : '';
  const jobs = parsed.map((job) => normalizeCronJob(job, legacyChatId));
  if (hasLegacyJobs) writeCronJobsFile(jobs);
  return jobs;
}

export function writeCronJobs(jobs: CronJob[], options: { notify?: boolean } = {}): void {
  writeCronJobsFile(jobs.map((job) => normalizeCronJob(job)));
  if (options.notify !== false) notifyCronJobsChanged();
}

export function createCronJob(input: CreateCronJobInput): CronJob {
  const now = new Date();
  const nowIso = now.toISOString();
  const job = normalizeCronJob({
    id: `job_${crypto.randomUUID()}`,
    chatId: input.chatId,
    enabled: input.enabled ?? true,
    kind: input.kind,
    ...(input.title ? { title: input.title } : {}),
    prompt: input.prompt,
    ...(input.runAt ? { runAt: input.runAt } : {}),
    ...(input.intervalMs ? { intervalMs: input.intervalMs } : {}),
    ...(input.schedule ? { schedule: input.schedule } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    nextRunAt: null,
    lastRunAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  job.nextRunAt = job.enabled ? computeNextRunAt(job, now) : null;
  if (job.enabled && job.kind === 'once' && !job.nextRunAt) {
    throw new Error('runAt must be in the future for one-time scheduled tasks');
  }
  return job;
}

export function addCronJob(input: CreateCronJobInput): CronJob {
  const jobs = readCronJobs();
  const job = createCronJob(input);
  jobs.push(job);
  writeCronJobs(jobs);
  return job;
}

export function updateCronJob(
  chatId: string,
  id: string,
  input: UpdateCronJobInput,
): CronJob {
  const jobs = readCronJobs();
  const index = jobs.findIndex((job) => job.id === id && job.chatId === chatId);
  if (index < 0) throw new Error(`No scheduled task found with id ${id}`);

  const existing = jobs[index];
  const updated = normalizeCronJob({
    ...existing,
    ...definedOnly(input),
    updatedAt: new Date().toISOString(),
  });
  updated.nextRunAt = updated.enabled ? computeNextRunAt(updated) : null;
  if (updated.enabled && updated.kind === 'once' && !updated.nextRunAt) {
    throw new Error('runAt must be in the future for one-time scheduled tasks');
  }
  jobs[index] = updated;
  writeCronJobs(jobs);
  return updated;
}

export function cancelCronJob(chatId: string, id: string): CronJob {
  return updateCronJob(chatId, id, { enabled: false });
}

export function onCronJobsChanged(listener: CronJobsChangedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyCronJobsChanged(): void {
  for (const listener of listeners) listener();
}

export function computeNextRunAt(job: CronJob, fromDate: Date = new Date()): string | null {
  if (!job.enabled) return null;

  if (job.kind === 'once') {
    const runAt = requireValidDate(job.runAt, 'runAt');
    return runAt.getTime() > fromDate.getTime() ? runAt.toISOString() : null;
  }

  if (job.kind === 'interval') {
    if (!job.intervalMs || !Number.isFinite(job.intervalMs) || job.intervalMs < 60_000) {
      throw new Error('intervalMs must be at least 60000');
    }
    return new Date(fromDate.getTime() + job.intervalMs).toISOString();
  }

  if (job.kind === 'cron') {
    if (!job.schedule) throw new Error('Cron jobs require schedule');
    const expression = CronExpressionParser.parse(job.schedule, {
      currentDate: fromDate,
      ...(job.timezone ? { tz: job.timezone } : {}),
    });
    return expression.next().toISOString();
  }

  throw new Error(`Unsupported scheduled task kind: ${job.kind}`);
}

export function markCronJobRan(job: CronJob, ranAt: Date = new Date()): CronJob {
  const updated: CronJob = {
    ...job,
    lastRunAt: ranAt.toISOString(),
    updatedAt: ranAt.toISOString(),
  };

  if (updated.kind === 'once') {
    updated.enabled = false;
    updated.nextRunAt = null;
    return updated;
  }

  updated.nextRunAt = computeNextRunAt(updated, ranAt);
  return updated;
}

export function deferCronJob(job: CronJob, delayMs: number, fromDate: Date = new Date()): CronJob {
  return {
    ...job,
    nextRunAt: new Date(fromDate.getTime() + delayMs).toISOString(),
    updatedAt: fromDate.toISOString(),
  };
}

export function formatCronJob(job: CronJob): string {
  const title = job.title ? `${job.title} ` : '';
  const schedule = formatCronSchedule(job);
  return `${job.id} — ${title}${job.enabled ? 'enabled' : 'disabled'}, chat: ${job.chatId}, ${schedule}, next: ${job.nextRunAt ?? 'none'}`;
}

function formatCronSchedule(job: CronJob): string {
  if (job.kind === 'once') return `once at ${job.runAt}`;
  if (job.kind === 'interval') {
    const minutes = Math.round((job.intervalMs ?? 0) / 60_000);
    return `every ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `cron ${job.schedule}${job.timezone ? ` (${job.timezone})` : ''}`;
}

function hasCronJobChatId(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('chatId' in value)) return false;
  return typeof value.chatId === 'string' && Boolean(value.chatId.trim());
}

function normalizeCronJob(value: unknown, legacyChatId = ''): CronJob {
  if (!value || typeof value !== 'object') {
    throw new Error('Scheduled task entries must be objects');
  }

  const record = value as Partial<CronJob>;
  if (!record.id || typeof record.id !== 'string') {
    throw new Error('Scheduled task requires string id');
  }
  if (record.kind !== 'once' && record.kind !== 'interval' && record.kind !== 'cron') {
    throw new Error(`Scheduled task ${record.id} has invalid kind`);
  }
  if (!record.prompt || typeof record.prompt !== 'string') {
    throw new Error(`Scheduled task ${record.id} requires prompt`);
  }

  const chatId = typeof record.chatId === 'string' ? record.chatId.trim() : legacyChatId.trim();
  if (!chatId) {
    throw new Error(`Scheduled task ${record.id} requires chatId`);
  }

  const job: CronJob = {
    id: record.id,
    chatId,
    enabled: record.enabled !== false,
    kind: record.kind,
    ...(record.title ? { title: String(record.title) } : {}),
    prompt: record.prompt,
    ...(record.runAt ? { runAt: requireValidDate(record.runAt, 'runAt').toISOString() } : {}),
    ...(record.intervalMs ? { intervalMs: Number(record.intervalMs) } : {}),
    ...(record.schedule ? { schedule: String(record.schedule) } : {}),
    ...(record.timezone ? { timezone: String(record.timezone) } : {}),
    nextRunAt: record.nextRunAt
      ? requireValidDate(record.nextRunAt, 'nextRunAt').toISOString()
      : null,
    lastRunAt: record.lastRunAt
      ? requireValidDate(record.lastRunAt, 'lastRunAt').toISOString()
      : null,
    createdAt: record.createdAt
      ? requireValidDate(record.createdAt, 'createdAt').toISOString()
      : new Date().toISOString(),
    updatedAt: record.updatedAt
      ? requireValidDate(record.updatedAt, 'updatedAt').toISOString()
      : new Date().toISOString(),
  };

  validateCronJob(job);
  return job;
}

function validateCronJob(job: CronJob): void {
  if (job.kind === 'once') {
    requireValidDate(job.runAt, 'runAt');
    return;
  }

  if (job.kind === 'interval') {
    if (!job.intervalMs || !Number.isFinite(job.intervalMs) || job.intervalMs < 60_000) {
      throw new Error(`Scheduled task ${job.id} intervalMs must be at least 60000`);
    }
    return;
  }

  if (!job.schedule) throw new Error(`Scheduled task ${job.id} requires schedule`);
  CronExpressionParser.parse(job.schedule, {
    ...(job.timezone ? { tz: job.timezone } : {}),
  });
}

function requireValidDate(value: string | undefined, field: string): Date {
  if (!value) throw new Error(`Missing required date field ${field}`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for ${field}: ${value}`);
  }
  return date;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function writeCronJobsFile(jobs: CronJob[]): void {
  fs.mkdirSync(path.dirname(CRON_JOBS_PATH), { recursive: true });
  const tmpPath = `${CRON_JOBS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(jobs, null, '\t')}\n`, 'utf8');
  fs.renameSync(tmpPath, CRON_JOBS_PATH);
}
