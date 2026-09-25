import { randomBytes } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { CoreEvent, JobSnapshot } from './contract.ts';
import { currentModel } from './extension-models.ts';
import { onSteeringMessage } from './steering-signal.ts';
import type { IncomingPrompt, JobReportSource, SessionKind } from './types.ts';
import { errorMessage, formatDuration } from './util.ts';

/**
 * Bookkeeping for the bot's background-work registries: background bash
 * sessions (src/background-bash.ts) and sub-agent jobs (src/subagent.ts). The
 * shape is generic because it describes any job that starts as 'running',
 * settles into exactly one terminal status, and reports back to the agent that
 * started it when it finishes.
 *
 * This module owns the parts that are not specific to a kind of job — ID
 * allocation, the yield-then-background step, TTL pruning, cancellation, and
 * report delivery including where a report is routed and whether it is still
 * needed, and telling the channels how a job started from the chat is going —
 * while the caller keeps its own status vocabulary and user-facing wording, and
 * its own stop path for the user's Stop.
 *
 * Progress is a stream of `job` events carrying plain snapshots: one as the
 * job starts, one per change (bursts coalesced to one per tick), an urgent one
 * for the user's own stop, and a final one as it settles. Each channel paces
 * its own updates; no model call is involved.
 *
 * A registry lives at module level in src/ (imported once by Node), so it is
 * shared for the lifetime of the bot process. Jobs do not survive bot restarts;
 * main.ts stops them all on shutdown.
 */

export type JobEvent = Extract<CoreEvent, { type: 'job' }>;

let jobEventSink: ((event: JobEvent) => void) | null = null;

/** Where every registry's job events go: the core, installed once by main.ts; tests install their own. */
export function setJobEventSink(sink: ((event: JobEvent) => void) | null): void {
  jobEventSink = sink;
}

const snapshotSources = new Set<() => JobSnapshot[]>();

/** The running jobs the chat started, across every registry, for a channel that connects mid-job. */
export function runningJobSnapshots(): JobSnapshot[] {
  return [...snapshotSources].flatMap((source) => source());
}

function emitJobEvent(event: JobEvent): void {
  try {
    jobEventSink?.(event);
  } catch (error) {
    console.error('failed to announce job progress:', errorMessage(error));
  }
}

/** Where a job was started from, so its report can find its way back. */
export interface JobOrigin {
  session: SessionKind;
  /** Model the starting turn ran on, as provider/model, when the SDK exposed one. */
  model?: string;
  /**
   * Transcript of the starting turn. Background runs each get a fresh one, so a
   * report must name it to reach the run that started the job.
   */
  sessionFile?: string;
}

/** Records which session a tool call came from, the model it was on, and its transcript. */
export function captureJobOrigin(ctx: ExtensionContext, session: SessionKind): JobOrigin {
  const model = currentModel(ctx);
  const sessionFile = ctx.sessionManager?.getSessionFile();
  return { session, ...(model ? { model } : {}), ...(sessionFile ? { sessionFile } : {}) };
}

/**
 * The prompt that delivers a completion report, addressed to the session that
 * started the job. A report bound for the background session also names the
 * transcript of the run that started the job, since every background run starts
 * a fresh one, and pins the model that run was on, since the background session
 * has no default model. The chat session keeps whatever model the user has
 * selected since.
 */
export function jobReportPrompt(
  origin: JobOrigin,
  report: {
    text: string;
    source: JobReportSource;
    label: string;
    /** Whether the agent has already read the result, checked when the report is about to run. */
    isSuperseded: () => boolean;
  },
): IncomingPrompt {
  const { session, model, sessionFile } = origin;
  return {
    text: report.text,
    attachments: [],
    origin: { kind: 'job-report', source: report.source },
    session,
    suppressNoop: true,
    label: report.label,
    isSuperseded: report.isSuperseded,
    ...(session === 'background' && model ? { model } : {}),
    ...(session === 'background' && sessionFile ? { resumeSessionFile: sessionFile } : {}),
  };
}

/**
 * Why a wait returned: the job settled, the caller's `until` condition held, the
 * timeout passed, the user sent a message into the waiting turn, or the turn was
 * aborted.
 */
export type WaitOutcome = 'settled' | 'matched' | 'timeout' | 'interrupted' | 'aborted';

export interface WaitOptions {
  timeoutMs: number;
  /** The session the waiting turn runs in; a message steered into it ends the wait. */
  session: SessionKind;
  signal?: AbortSignal;
  /** Ends the wait early once true; checked every checkMs while the job runs. */
  until?: () => boolean;
  checkMs?: number;
}

/** 'running' plus the caller's terminal statuses. */
export type JobStatus<TTerminal extends string> = 'running' | TTerminal;

export interface Job<TTerminal extends string> {
  id: string;
  origin: JobOrigin;
  status: JobStatus<TTerminal>;
  statusDetail: string | null;
  startedAt: number;
  endedAt: number | null;
  /** True once start returned an ID to the agent; gates the completion report. */
  backgrounded: boolean;
  /**
   * True once cancel() stopped the job: the agent's own stop tools, or
   * shutdown. Such a job sends no report. A stop the user makes from the
   * progress message goes through the job's own stop path instead, and reports.
   */
  cancelled: boolean;
  /**
   * True once the session that started the job read its settled result. The
   * completion report is then redundant: it would only repeat what the agent
   * already acted on.
   */
  resultRead: boolean;
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
  /** Terminal status recorded when a job is cancelled by the agent or by shutdown. */
  cancelledStatus: TTerminal;
  /** Signals one running job to stop. */
  signalCancel: (job: TJob) => void;
  /** Renders a job's status for read/list output. */
  describeStatus: (job: TJob) => string;
  /** Projects a settled job into the report delivered to the chat agent. */
  buildReport: (job: TJob) => TReport;
  /**
   * The job as channels show it, for both the running and the final state.
   * Without it, jobs show no progress.
   */
  snapshot?: (job: TJob) => JobSnapshot;
}

export class JobRegistry<TTerminal extends string, TJob extends Job<TTerminal>, TReport> {
  private readonly jobs = new Map<string, TJob>();
  private readonly options: JobRegistryOptions<TTerminal, TJob, TReport>;
  private reportHandler: ((report: TReport) => Promise<void>) | null = null;
  /** Jobs whose progress the channels are shown, and the ones with an update pending this tick. */
  private readonly watched = new Map<string, TJob>();
  private readonly pending = new Set<string>();

  constructor(options: JobRegistryOptions<TTerminal, TJob, TReport>) {
    this.options = options;
    const { snapshot } = options;
    if (snapshot) snapshotSources.add(() => [...this.watched.values()].map(snapshot));
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

  /** Adds a job that has just started, and announces it. */
  register(job: TJob): void {
    this.jobs.set(job.id, job);
    this.startProgress(job);
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
   * forgotten, since its result goes back inline and no report follows; its
   * progress still ends on its final state. One still running is marked
   * backgrounded so its completion report is delivered. Returns true when the
   * job was backgrounded.
   */
  async settleOrBackground(job: TJob, yieldMs: number): Promise<boolean> {
    await settleWithin(job.done, yieldMs);
    if (job.status !== 'running') {
      this.remove(job.id);
      return false;
    }
    job.backgrounded = true;
    return true;
  }

  /**
   * Blocks the calling tool, not the model, until one of the WaitOptions ends
   * it. No model call is spent while it waits, and the job's progress keeps
   * the user informed meanwhile.
   */
  waitFor(job: TJob, options: WaitOptions): Promise<WaitOutcome> {
    if (job.status !== 'running') return Promise.resolve('settled');
    if (options.signal?.aborted) return Promise.resolve('aborted');
    if (options.until?.()) return Promise.resolve('matched');

    return new Promise((resolve) => {
      const cleanups: Array<() => void> = [];
      let finished = false;
      const finish = (outcome: WaitOutcome): void => {
        if (finished) return;
        finished = true;
        for (const cleanup of cleanups) cleanup();
        resolve(outcome);
      };

      void job.done.then(() => finish('settled'));
      const timer = setTimeout(() => finish('timeout'), options.timeoutMs);
      cleanups.push(() => clearTimeout(timer));
      cleanups.push(onSteeringMessage(options.session, () => finish('interrupted')));

      const { signal, until } = options;
      if (signal) {
        const onAbort = (): void => finish('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener('abort', onAbort));
      }
      if (until) {
        const check = setInterval(() => {
          if (until()) finish('matched');
        }, options.checkMs ?? 1_000);
        cleanups.push(() => clearInterval(check));
      }
    });
  }

  /**
   * Called once when a job reaches its terminal status, from the runner's
   * settle path: announces the final state, then delivers the report. In that
   * order, so a channel shows the outcome before the report's reply.
   */
  async settled(job: TJob): Promise<void> {
    this.finishProgress([job]);
    await this.reportEnd(job);
  }

  /** Announces that the job changed. Changes within one tick are coalesced into one event. */
  refreshProgress(job: TJob): void {
    if (!this.watched.has(job.id) || this.pending.has(job.id)) return;
    this.pending.add(job.id);
    setImmediate(() => {
      if (!this.pending.delete(job.id) || !this.watched.has(job.id)) return;
      this.announce(job, {});
    });
  }

  /** Announces the change at once and marks it urgent, for the user's own Stop. */
  refreshProgressNow(job: TJob): void {
    if (!this.watched.has(job.id)) return;
    this.pending.delete(job.id);
    this.announce(job, { urgent: true });
  }

  /**
   * Progress is shown only for jobs the chat started, from the moment they
   * start. A job from the background session belongs to an unattended run whose
   * own output is noted, not watched.
   */
  private startProgress(job: TJob): void {
    if (!this.options.snapshot || job.origin.session !== 'chat') return;
    this.watched.set(job.id, job);
    this.announce(job, {});
  }

  private finishProgress(jobs: TJob[]): void {
    for (const job of jobs) {
      if (!this.watched.delete(job.id)) continue;
      this.pending.delete(job.id);
      this.announce(job, { final: true });
    }
  }

  private announce(job: TJob, flags: { urgent?: boolean; final?: boolean }): void {
    const { snapshot } = this.options;
    if (!snapshot) return;
    emitJobEvent({ type: 'job', job: snapshot(job), ...flags });
  }

  /**
   * Marks each running job cancelled, signals it, then waits briefly for the
   * runners to settle. For the agent's own stop tools and shutdown: cancelled
   * jobs do not send a completion report.
   */
  async cancel(targets: TJob[]): Promise<number> {
    const running = targets.filter((job) => job.status === 'running');
    for (const job of running) {
      job.status = this.options.cancelledStatus;
      job.cancelled = true;
      this.options.signalCancel(job);
    }
    if (running.length > 0) {
      await settleWithin(
        Promise.allSettled(running.map((job) => job.done)),
        this.options.cancelWaitMs,
      );
    }
    // Here as well as on settle: at shutdown the process may exit before a
    // runner's settle path runs, and progress left saying "running" would be
    // wrong for good.
    this.finishProgress(running);
    return running.length;
  }

  cancelAll(): Promise<number> {
    return this.cancel([...this.jobs.values()]);
  }

  /**
   * Records that `reader` saw the job's final result. Only a settled job counts,
   * since a running one has no result yet, and only a read from the session the
   * report is addressed to: a result the other session read is still news there.
   */
  markResultRead(job: TJob, reader: SessionKind): void {
    if (job.status !== 'running' && reader === job.origin.session) job.resultRead = true;
  }

  /**
   * True when a queued report for this job need not run. Asked when the report
   * reaches the front of the queue rather than when it is sent: an agent polling
   * in the same turn usually reads the result after the report was queued. A
   * pruned job reads as false, so a report is only ever dropped on evidence.
   */
  isReportSuperseded(id: string): boolean {
    return this.jobs.get(id)?.resultRead ?? false;
  }

  /**
   * Delivers a settled job's report unless it was cancelled or never
   * backgrounded. A job the user stopped was not cancelled, so the agent still
   * hears how it ended.
   */
  private async reportEnd(job: TJob): Promise<void> {
    if (!job.backgrounded || job.cancelled) return;

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

/**
 * Waits for `promise` or `ms`, whichever comes first. The timer is cleared
 * either way: a plain race against sleep() would leave it pending and hold the
 * process open until it fired.
 */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
