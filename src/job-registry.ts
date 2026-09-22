import { randomBytes } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { currentModel } from './extension-models.ts';
import type { IncomingPrompt, JobReportSource, SessionKind } from './types.ts';
import { errorMessage, formatDuration, sleep } from './util.ts';

/**
 * Bookkeeping for the bot's background-work registries: background bash
 * sessions (src/background-bash.ts) and sub-agent jobs (src/subagent.ts). The
 * shape is generic because it describes any job that starts as 'running',
 * settles into exactly one terminal status, and reports back to the agent that
 * started it when it finishes.
 *
 * This module owns the parts that are not specific to a kind of job — ID
 * allocation, the yield-then-background step, TTL pruning, cancellation, and
 * report delivery including where a report is routed — while the caller keeps
 * its own status vocabulary and user-facing wording.
 *
 * A registry lives at module level in src/ (imported once by Node), so it is
 * shared for the lifetime of the bot process. Jobs do not survive bot restarts;
 * main.ts stops them all on shutdown.
 */

/** Where a job was started from, so its report can find its way back. */
export interface JobOrigin {
  session: SessionKind;
  /** Model the starting turn ran on, as provider/model, when the SDK exposed one. */
  model?: string;
}

/** Records which session a tool call came from and the model it was on. */
export function captureJobOrigin(ctx: ExtensionContext, session: SessionKind): JobOrigin {
  const model = currentModel(ctx);
  return { session, ...(model ? { model } : {}) };
}

/**
 * The prompt that delivers a completion report, addressed to the session that
 * started the job. A report bound for the background session also pins the
 * model that session was on when it started the job, since that session has no
 * default model and a later scheduled task may have moved it elsewhere. The
 * chat session keeps whatever model the user has selected since.
 */
export function jobReportPrompt(
  origin: JobOrigin,
  report: { text: string; source: JobReportSource; label: string },
): IncomingPrompt {
  const { session, model } = origin;
  return {
    text: report.text,
    attachments: [],
    source: report.source,
    session,
    suppressNoop: true,
    label: report.label,
    ...(session === 'background' && model ? { model } : {}),
  };
}

/** 'running' plus the caller's terminal statuses. */
export type JobStatus<TTerminal extends string> = 'running' | TTerminal;

export interface Job<TTerminal extends string> {
  id: string;
  status: JobStatus<TTerminal>;
  statusDetail: string | null;
  startedAt: number;
  endedAt: number | null;
  /** True once start returned an ID to the agent; gates the completion report. */
  backgrounded: boolean;
  done: Promise<void>;
}

export interface JobRegistryOptions<
  TTerminal extends string,
  TJob extends Job<TTerminal>,
  TReport,
> {
  /** ID prefix; 'bash' produces IDs like `bash_1a2b3c`. */
  idPrefix: string;
  /** Noun used in agent-facing messages, e.g. 'background bash session'. */
  jobNoun: string;
  /** Plural of jobNoun, e.g. 'background bash sessions'. */
  jobNounPlural: string;
  /** Tool that lists jobs, named in "unknown job" messages. */
  listToolName: string;
  /** How long settled jobs stay readable before being pruned. */
  completedTtlMs: number;
  /** How long cancel() waits for signalled jobs to settle. */
  cancelWaitMs: number;
  /** Terminal status recorded when a job is cancelled by the user or by shutdown. */
  cancelledStatus: TTerminal;
  /** Signals one running job to stop. */
  signalCancel: (job: TJob) => void;
  /** Renders a job's status for read/list output. */
  describeStatus: (job: TJob) => string;
  /** Projects a settled job into the report delivered to the chat agent. */
  buildReport: (job: TJob) => TReport;
}

export class JobRegistry<TTerminal extends string, TJob extends Job<TTerminal>, TReport> {
  private readonly jobs = new Map<string, TJob>();
  private readonly options: JobRegistryOptions<TTerminal, TJob, TReport>;
  private reportHandler: ((report: TReport) => Promise<void>) | null = null;

  constructor(options: JobRegistryOptions<TTerminal, TJob, TReport>) {
    this.options = options;
  }

  /** Wires completion reports into the bot's incoming-prompt pipeline. Called from main.ts. */
  setReportHandler(handler: (report: TReport) => Promise<void>): void {
    this.reportHandler = handler;
  }

  /** Allocates an unused ID for a job the caller is about to register(). */
  allocateId(): string {
    for (;;) {
      const id = `${this.options.idPrefix}_${randomBytes(3).toString('hex')}`;
      if (!this.jobs.has(id)) return id;
    }
  }

  register(job: TJob): void {
    this.jobs.set(job.id, job);
  }

  /** Forgets a job, e.g. once it finished fast enough to be returned inline. */
  remove(id: string): void {
    this.jobs.delete(id);
  }

  /** Looks up a job by (possibly untrimmed) ID. */
  get(id: string): TJob | null {
    this.prune();
    return this.jobs.get(id.trim()) ?? null;
  }

  all(): TJob[] {
    this.prune();
    return [...this.jobs.values()];
  }

  runningCount(): number {
    return this.all().filter((job) => job.status === 'running').length;
  }

  /**
   * Waits up to yieldMs for a just-started job. A job that settles in time is
   * forgotten, since its result goes back inline and no report follows; one
   * still running is marked backgrounded so its completion report is delivered.
   * Returns true when the job was backgrounded.
   */
  async settleOrBackground(job: TJob, yieldMs: number): Promise<boolean> {
    await Promise.race([job.done, sleep(yieldMs)]);
    if (job.status !== 'running') {
      this.remove(job.id);
      return false;
    }
    job.backgrounded = true;
    return true;
  }

  /**
   * Marks each running job cancelled, signals it, then waits briefly for the
   * runners to settle. Cancelled jobs do not send a completion report.
   */
  async cancel(targets: TJob[]): Promise<number> {
    const running = targets.filter((job) => job.status === 'running');
    for (const job of running) {
      job.status = this.options.cancelledStatus;
      this.options.signalCancel(job);
    }
    if (running.length > 0) {
      await Promise.race([
        Promise.allSettled(running.map((job) => job.done)),
        sleep(this.options.cancelWaitMs),
      ]);
    }
    return running.length;
  }

  cancelAll(): Promise<number> {
    return this.cancel([...this.jobs.values()]);
  }

  /** Delivers a settled job's report unless it was cancelled or never backgrounded. */
  async reportEnd(job: TJob): Promise<void> {
    if (!job.backgrounded || job.status === this.options.cancelledStatus) return;

    if (!this.reportHandler) {
      console.error(`no ${this.options.jobNoun} report handler set; dropping report`);
      return;
    }

    try {
      await this.reportHandler(this.options.buildReport(job));
    } catch (error) {
      console.error(`failed to deliver ${this.options.jobNoun} report:`, errorMessage(error));
    }
  }

  runtimeMs(job: TJob): number {
    return (job.endedAt ?? Date.now()) - job.startedAt;
  }

  statusLine(job: TJob): string {
    const verb = job.status === 'running' ? 'running for' : 'ran for';
    return `Status: ${this.options.describeStatus(job)}, ${verb} ${formatDuration(this.runtimeMs(job))}`;
  }

  unknownJobMessage(id: string): string {
    const { jobNoun, jobNounPlural, listToolName, completedTtlMs } = this.options;
    return `Unknown ${jobNoun} "${id}". It may have been pruned (finished ${jobNounPlural} are kept for ${formatDuration(completedTtlMs)}) or the bot may have restarted. Use ${listToolName} to see current ${jobNounPlural}.`;
  }

  private prune(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (
        job.status !== 'running' &&
        job.endedAt !== null &&
        now - job.endedAt > this.options.completedTtlMs
      ) {
        this.jobs.delete(job.id);
      }
    }
  }
}
