import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { ALLOWED_CHAT_ID, CRON_JOBS_PATH, FILES_DIR } from './config.ts';
import { formatModelRef, parseModelRef, requireValidDate } from './util.ts';

export type CronJobKind = 'once' | 'interval' | 'cron';

export interface CronJob {
  id: string;
  /** Chat that created the job; cron refuses to fire jobs from a different chat. */
  chatId: string;
  enabled: boolean;
  kind: CronJobKind;
  title?: string;
  prompt: string;
  /** Model this task runs on, as provider/model. Pinned when the task is created. */
  model: string;
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
  kind: CronJobKind;
  prompt: string;
  title?: string;
  model: string;
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
  model?: string;
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

  return parsed.map((job) => normalizeCronJob(job));
}

export function writeCronJobs(jobs: CronJob[], options: { notify?: boolean } = {}): void {
  writeCronJobsFile(jobs.map((job) => normalizeCronJob(job)));
  if (options.notify !== false) notifyCronJobsChanged();
}

function createCronJob(input: CreateCronJobInput): CronJob {
  const now = new Date();
  const nowIso = now.toISOString();
  const job = normalizeCronJob({
    id: `job_${crypto.randomUUID()}`,
    chatId: ALLOWED_CHAT_ID,
    enabled: input.enabled ?? true,
    kind: input.kind,
    ...(input.title ? { title: input.title } : {}),
    prompt: input.prompt,
    model: input.model,
    ...(input.runAt ? { runAt: resolveRunAt(input.runAt, input.timezone).toISOString() } : {}),
    ...(input.intervalMs ? { intervalMs: input.intervalMs } : {}),
    ...(input.schedule ? { schedule: input.schedule } : {}),
    ...(input.timezone ? { timezone: requireTimeZone(input.timezone) } : {}),
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

export function updateCronJob(id: string, input: UpdateCronJobInput): CronJob {
  const jobs = readCronJobs();
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0) throw new Error(`No scheduled task found with id ${id}`);

  const timezone = input.timezone ? requireTimeZone(input.timezone) : jobs[index].timezone;
  const updated = normalizeCronJob({
    ...jobs[index],
    ...definedOnly(input),
    ...(input.runAt ? { runAt: resolveRunAt(input.runAt, timezone).toISOString() } : {}),
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

export function cancelCronJob(id: string): CronJob {
  return updateCronJob(id, { enabled: false });
}

export function onCronJobsChanged(listener: CronJobsChangedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyCronJobsChanged(): void {
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

/**
 * One line per task for the scheduling tools. Times are shown in the task's
 * timezone, or labelled UTC, so the agent can check a task fires when the user
 * meant rather than reading a bare UTC timestamp.
 */
export function formatCronJob(job: CronJob): string {
  const title = job.title ? `${job.title} ` : '';
  const schedule = formatCronSchedule(job);
  const next = job.nextRunAt ? formatLocalTime(job.nextRunAt, job.timezone) : 'none';
  return `${job.id} — ${title}${job.enabled ? 'enabled' : 'disabled'}, ${schedule}, model: ${job.model}, next: ${next}`;
}

function formatCronSchedule(job: CronJob): string {
  if (job.kind === 'once') {
    return `once at ${job.runAt ? formatLocalTime(job.runAt, job.timezone) : 'an unset time'}`;
  }
  if (job.kind === 'interval') {
    const minutes = Math.round((job.intervalMs ?? 0) / 60_000);
    return `every ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `cron ${job.schedule}${job.timezone ? ` (${job.timezone})` : ''}`;
}

function normalizeCronJob(value: unknown): CronJob {
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

  const chatId = typeof record.chatId === 'string' ? record.chatId.trim() : '';
  if (!chatId) {
    throw new Error(`Scheduled task ${record.id} requires chatId`);
  }
  if (!record.model || typeof record.model !== 'string') {
    throw new Error(`Scheduled task ${record.id} requires model`);
  }

  const job: CronJob = {
    id: record.id,
    chatId,
    enabled: record.enabled !== false,
    kind: record.kind,
    ...(record.title ? { title: String(record.title) } : {}),
    prompt: record.prompt,
    model: formatModelRef(parseModelRef(record.model)),
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

const EXPLICIT_OFFSET_RE = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const WALL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * The instant a one-time task's run_at means. A time with a UTC offset (or Z)
 * is taken as written. One without is the wall-clock time in `timezone`, and
 * with no timezone either it is rejected: the server runs on UTC, so reading it
 * there would fire the task hours away from what the user meant.
 */
export function resolveRunAt(runAt: string, timezone?: string): Date {
  const text = runAt.trim();
  if (EXPLICIT_OFFSET_RE.test(text)) return requireValidDate(text, 'runAt');
  if (!timezone) {
    throw new Error(
      `run_at ${runAt} has no UTC offset. Add one (2026-05-29T09:00:00+05:30) or pass timezone (Asia/Kolkata).`,
    );
  }
  const match = WALL_TIME_RE.exec(text);
  if (!match) {
    throw new Error(
      `run_at must be an ISO date and time such as 2026-05-29T09:00:00, got ${runAt}`,
    );
  }
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = Number(match[6] ?? 0);
  const ms = Number((match[7] ?? '0').padEnd(3, '0'));
  // Written as if it were UTC; Date.UTC rolls overflow over (Feb 30 -> Mar 2), so
  // reading the fields back catches a date or time that does not exist.
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (
    wall.getUTCMonth() !== month - 1 ||
    wall.getUTCDate() !== day ||
    wall.getUTCHours() !== hour ||
    wall.getUTCMinutes() !== minute
  ) {
    throw new Error(`run_at ${runAt} is not a valid date and time`);
  }
  const zone = requireTimeZone(timezone);
  // The zone's offset at a first guess, corrected once: that settles on the right
  // side of a daylight-saving change.
  const guess = wall.getTime() - zoneOffsetMs(wall.getTime(), zone);
  return new Date(wall.getTime() - zoneOffsetMs(guess, zone));
}

/** Returns the timezone if Intl knows it, so a typo fails when the task is saved. */
function requireTimeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`Unknown timezone ${timezone}; use an IANA name such as Asia/Kolkata`);
  }
  return timezone;
}

/** How far the clock in `timeZone` is ahead of UTC at `instant`. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

function zonedParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return {
    weekday: part('weekday'),
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
    second: Number(part('second')),
  };
}

/** `Fri 2026-09-25 09:00 (Asia/Kolkata)`; UTC when there is no usable timezone. */
export function formatLocalTime(iso: string, timezone?: string): string {
  let zone = timezone ?? 'UTC';
  let p: ReturnType<typeof zonedParts>;
  try {
    p = zonedParts(Date.parse(iso), zone);
  } catch {
    zone = 'UTC';
    p = zonedParts(Date.parse(iso), zone);
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  const seconds = p.second ? `:${pad(p.second)}` : '';
  return `${p.weekday} ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}${seconds} (${zone})`;
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
