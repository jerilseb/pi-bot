import { randomBytes } from 'node:crypto';
import { errorMessage, formatDuration, sleep } from './util.ts';

/**
 * Bookkeeping for the bot's background-work registries. The only caller today is
 * background bash sessions (src/background-bash.ts); the shape stays generic
 * because it describes any job that starts as 'running', settles into exactly
 * one terminal status, and reports back to the chat agent when it finishes.
 *
 * This module owns the parts that are not specific to a kind of job — ID
 * allocation, TTL pruning, cancellation, and report delivery — while the caller
 * keeps its own status vocabulary and user-facing wording.
 *
 * A registry lives at module level in src/ (imported once by Node), so it is
 * shared for the lifetime of the bot process. Jobs do not survive bot restarts;
 * main.ts stops them all on shutdown.
 */

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
