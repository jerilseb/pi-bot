import type { CoreEvent, JobSnapshot } from '../../contract.ts';
import { formatBashProgress } from './bash-progress.ts';
import {
  type ProgressContent,
  type ProgressMessage,
  type ProgressMessageOptions,
  startProgressMessage,
} from './job-progress.ts';
import { formatSubagentProgress } from './subagent-progress.ts';

type JobEvent = Extract<CoreEvent, { type: 'job' }>;

/**
 * The live progress message of every job the chat started, kept current from
 * the core's job events. The core announces every change; job-progress.ts
 * decides when Telegram is actually edited, which is what keeps the chat within
 * Telegram's rate limits.
 */
export class TelegramJobProgress {
  private readonly live = new Map<string, { latest: JobSnapshot; message: ProgressMessage }>();
  private readonly subagentToolCalls: () => boolean;
  private readonly progressOptions: ProgressMessageOptions | undefined;

  /**
   * subagentToolCalls is the `subagentToolCalls` setting, read at every render,
   * so a switch reaches running jobs too; tests pass their own.
   */
  constructor(options: {
    subagentToolCalls: () => boolean;
    progressOptions?: ProgressMessageOptions;
  }) {
    this.subagentToolCalls = options.subagentToolCalls;
    this.progressOptions = options.progressOptions;
  }

  /**
   * Takes one job event. A final one returns the last write, so the caller can
   * hold what follows (the job's report) until the message shows the outcome.
   */
  onJob(event: JobEvent): Promise<void> | null {
    const { id } = event.job;
    let entry = this.live.get(id);
    if (entry) {
      entry.latest = event.job;
    } else {
      const created = { latest: event.job, message: null as unknown as ProgressMessage };
      created.message = startProgressMessage(
        () => this.render(created.latest),
        this.progressOptions,
      );
      entry = created;
      this.live.set(id, entry);
    }
    if (event.final) {
      this.live.delete(id);
      return entry.message.finish();
    }
    if (event.urgent) entry.message.refreshNow();
    else entry.message.refresh();
    return null;
  }

  private render(job: JobSnapshot): ProgressContent {
    return job.kind === 'bash'
      ? formatBashProgress(job)
      : formatSubagentProgress(job, { toolCalls: this.subagentToolCalls() });
  }
}
