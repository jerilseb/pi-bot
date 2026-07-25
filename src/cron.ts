import { CRON_JOBS_PATH, CRON_NOOP, isAllowedTelegramChat } from './config.ts';
import {
  computeNextRunAt,
  deferCronJob,
  ensureCronJobsFile,
  formatCronJob,
  markCronJobRan,
  onCronJobsChanged,
  readCronJobs,
  writeCronJobs,
  type CronJob,
} from './cron-store.ts';
import type { IncomingPrompt } from './types.ts';
import { errorMessage } from './util.ts';

const MAX_TIMER_MS = 60 * 1000;
const BUSY_DEFER_MS = 60 * 1000;

export interface CronController {
  start(): void;
  stop(): void;
}

export function createCronController(options: {
  handleIncoming: (prompt: IncomingPrompt) => Promise<void>;
  isChatBusy: () => boolean;
  isRunning: () => boolean;
}): CronController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let started = false;

  const scheduleNext = (): void => {
    if (!started) return;
    if (timer) clearTimeout(timer);
    timer = null;

    let jobs: CronJob[];
    try {
      jobs = refreshCronJobs();
    } catch (error) {
      console.error('Cron scheduler failed to read jobs:', errorMessage(error));
      timer = setTimeout(scheduleNext, MAX_TIMER_MS);
      return;
    }

    const nextRunAt = jobs
      .filter((job) => job.enabled && job.nextRunAt)
      .map((job) => new Date(job.nextRunAt as string).getTime())
      .sort((a, b) => a - b)[0];

    if (!nextRunAt) {
      timer = setTimeout(scheduleNext, MAX_TIMER_MS);
      return;
    }

    const delay = Math.min(Math.max(0, nextRunAt - Date.now()), MAX_TIMER_MS);
    timer = setTimeout(() => void runDueJobs(), delay);
  };

  const runDueJobs = async (): Promise<void> => {
    if (!options.isRunning()) return;

    const now = new Date();
    let jobs: CronJob[];
    try {
      jobs = refreshCronJobs(now);
    } catch (error) {
      console.error('Cron scheduler failed:', errorMessage(error));
      scheduleNext();
      return;
    }

    let changed = false;
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index];
      if (!job.enabled || !job.nextRunAt) continue;
      if (new Date(job.nextRunAt).getTime() > now.getTime()) continue;

      // A job persisted under a previous TELEGRAM_ALLOWED_CHAT_ID must not fire here.
      if (!isAllowedTelegramChat(job.chatId)) {
        console.warn(`disabling cron ${job.id}; it belongs to chat ${job.chatId}`);
        jobs[index] = disableCronJob(job, now);
        changed = true;
        continue;
      }

      if (options.isChatBusy()) {
        console.log(`cron ${job.id} deferred; chat is busy`);
        jobs[index] = deferCronJob(job, BUSY_DEFER_MS);
        changed = true;
        continue;
      }

      console.log(`cron ${job.id} due: ${job.title ?? job.prompt.slice(0, 80)}`);
      await options.handleIncoming({
        text: buildCronPrompt(job),
        attachments: [],
        source: 'cron',
        suppressNoop: true,
      });

      jobs[index] = markCronJobRan(job);
      changed = true;
    }

    if (changed) writeCronJobs(jobs, { notify: false });
    scheduleNext();
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      ensureCronJobsFile();
      unsubscribe = onCronJobsChanged(scheduleNext);
      console.log(`Cron scheduler: ${CRON_JOBS_PATH}`);
      scheduleNext();
    },

    stop(): void {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

export function cronStatusText(): string {
  try {
    const jobs = readCronJobs();
    const enabled = jobs.filter((job) => job.enabled).length;
    return `Cron: ${enabled}/${jobs.length} enabled (${CRON_JOBS_PATH})`;
  } catch (error) {
    return `Cron: error reading ${CRON_JOBS_PATH}: ${errorMessage(error)}`;
  }
}

function refreshCronJobs(fromDate: Date = new Date()): CronJob[] {
  const jobs = readCronJobs();
  let changed = false;

  const refreshed = jobs.map((job) => {
    if (!job.enabled || job.nextRunAt) return job;
    const nextRunAt = computeNextRunAt(job, fromDate);
    if (!nextRunAt) return job;
    changed = true;
    return { ...job, nextRunAt, updatedAt: fromDate.toISOString() };
  });

  if (changed) writeCronJobs(refreshed, { notify: false });
  return refreshed;
}

function disableCronJob(job: CronJob, now: Date): CronJob {
  return {
    ...job,
    enabled: false,
    nextRunAt: null,
    updatedAt: now.toISOString(),
  };
}

function buildCronPrompt(job: CronJob): string {
  return [
    'This is a scheduled task run for the Telegram assistant.',
    `Job ID: ${job.id}`,
    ...(job.title ? [`Title: ${job.title}`] : []),
    `Schedule: ${formatCronJob(job)}`,
    `Current time: ${new Date().toISOString()}`,
    ...(job.timezone ? [`Timezone: ${job.timezone}`] : []),
    '',
    'Run these scheduled instructions:',
    '<scheduled_task_instructions>',
    job.prompt,
    '</scheduled_task_instructions>',
    '',
    'Only notify the Telegram user when there is something important, actionable, or explicitly requested by the scheduled instructions.',
    `If there is nothing user-visible to report, respond exactly: ${CRON_NOOP}`,
  ].join('\n');
}
