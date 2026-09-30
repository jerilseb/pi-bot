import { buildAgentEnvelope } from './agent-envelope.ts';
import {
  BOT_SETTINGS_PATH,
  CRON_JOBS_ENABLED,
  CRON_JOBS_PATH,
  CRON_NOOP,
  isAllowedTelegramChat,
} from './config.ts';
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
import type { SubmitResult } from './contract.ts';
import type { IncomingPrompt } from './types.ts';
import { errorMessage } from './util.ts';

const MAX_TIMER_MS = 60 * 1000;
const BUSY_DEFER_MS = 60 * 1000;

export interface CronController {
  start(): void;
  stop(): void;
}

export function createCronController(options: {
  handleIncoming: (prompt: IncomingPrompt) => Promise<SubmitResult>;
  /** True while the background session is running or has queued a prompt. */
  isBackgroundBusy: () => boolean;
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
    try {
      await fireDueJob();
    } catch (error) {
      // Nothing fired. Tried again a minute later rather than at once, since a
      // file that cannot be read or written now would fail again straight away.
      console.error('Cron scheduler failed:', errorMessage(error));
      if (!started) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(scheduleNext, MAX_TIMER_MS);
      return;
    }
    scheduleNext();
  };

  /** Throws when the tasks file cannot be read or written, before anything fires. */
  const fireDueJob = async (): Promise<void> => {
    const now = new Date();
    const pass = planCronPass(refreshCronJobs(now), {
      now,
      backgroundBusy: options.isBackgroundBusy(),
      isAllowedChat: isAllowedTelegramChat,
    });
    // Recorded before the task fires, so one whose run cannot be recorded does
    // not fire again every time the scheduler retries.
    if (pass.changed) writeCronJobs(pass.jobs, { notify: false });

    const job = pass.due;
    if (!job) return;
    console.log(`cron ${job.id} due on ${job.model}: ${job.title ?? job.prompt.slice(0, 80)}`);
    const result = await options.handleIncoming({
      text: buildCronPrompt(job),
      attachments: [],
      origin: { kind: 'cron', taskId: job.id },
      suppressNoop: true,
      model: job.model,
      label: job.title ?? job.id,
    });
    if (result.status === 'rejected') {
      console.warn(`cron ${job.id} was recorded as run but not queued: ${result.reason}`);
    }
  };

  return {
    start(): void {
      if (!CRON_JOBS_ENABLED || started) return;
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
  if (!CRON_JOBS_ENABLED) {
    return `Cron: off (set "cronJobs": true in ${BOT_SETTINGS_PATH})`;
  }

  try {
    const jobs = readCronJobs();
    const enabled = jobs.filter((job) => job.enabled).length;
    return `Cron: ${enabled}/${jobs.length} enabled (${CRON_JOBS_PATH})`;
  } catch (error) {
    return `Cron: error reading ${CRON_JOBS_PATH}: ${errorMessage(error)}`;
  }
}

/**
 * One scheduler pass over the tasks at `now`. Of the tasks that are due, one
 * from another chat is disabled, and the first of the rest is marked as run
 * and returned to fire. Background runs go one at a time, so the others, or
 * all of them while a background run is under way, wait BUSY_DEFER_MS. The
 * chat is not waited for: what a run sends is held by the background outbox
 * until the chat is idle.
 */
export function planCronPass(
  jobs: readonly CronJob[],
  context: { now: Date; backgroundBusy: boolean; isAllowedChat: (chatId: string) => boolean },
): { jobs: CronJob[]; due: CronJob | null; changed: boolean } {
  const { now } = context;
  const planned = [...jobs];
  let due: CronJob | null = null;
  let changed = false;
  for (let index = 0; index < planned.length; index++) {
    const job = planned[index];
    if (!job.enabled || !job.nextRunAt) continue;
    if (new Date(job.nextRunAt).getTime() > now.getTime()) continue;
    changed = true;

    // A job persisted under a previous TELEGRAM_ALLOWED_CHAT_ID must not fire here.
    if (!context.isAllowedChat(job.chatId)) {
      console.warn(`disabling cron ${job.id}; it belongs to chat ${job.chatId}`);
      planned[index] = disableCronJob(job, now);
      continue;
    }

    if (context.backgroundBusy || due) {
      console.log(`cron ${job.id} deferred; background session is busy`);
      planned[index] = deferCronJob(job, BUSY_DEFER_MS, now);
      continue;
    }

    due = job;
    planned[index] = markCronJobRan(job, now);
  }
  return { jobs: planned, due, changed };
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
  return buildAgentEnvelope({
    preamble: 'This is a scheduled task run for the assistant.',
    meta: [
      ['Task ID', job.id],
      ['Title', job.title],
      ['Schedule', formatCronJob(job)],
      ['Current time', new Date().toISOString()],
      ['Timezone', job.timezone],
    ],
    sections: [
      {
        intro: 'Run these scheduled instructions:',
        tag: 'scheduled_task_instructions',
        body: job.prompt,
      },
    ],
    guidance: [
      'Only notify the user when there is something important, actionable, or explicitly requested by the scheduled instructions.',
    ],
    noopSentinel: CRON_NOOP,
  });
}
