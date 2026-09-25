import { type Component, type TUI, truncateToWidth } from '@earendil-works/pi-tui';
import type {
  BashJobSnapshot,
  JobSnapshot,
  SubagentJobSnapshot,
  SubagentTaskSnapshot,
} from '../contract.ts';
import { formatUptime } from '../status.ts';
import { dim } from './style.ts';

/**
 * The jobs the chat started, as the terminal shows them: a live block above
 * the editor while they run, one line per job and per sub-agent task, whose
 * clocks tick; and, once a job settles, a line in the chat saying how it
 * ended, since the agent's reply to its report comes after. /jobs stops one.
 */

/** Something /jobs can stop: a command, or one unfinished sub-agent task (1-based). */
export interface StoppableJob {
  label: string;
  jobId: string;
  task: number | undefined;
}

const TICK_MS = 1_000;

export class JobsWidget implements Component {
  private readonly jobs = new Map<string, JobSnapshot>();
  private readonly ui: TUI;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(ui: TUI, now: () => number = Date.now) {
    this.ui = ui;
    this.now = now;
  }

  get size(): number {
    return this.jobs.size;
  }

  /** Replaces every job, e.g. from a snapshot on connect. */
  load(jobs: JobSnapshot[]): void {
    this.jobs.clear();
    for (const job of jobs) this.jobs.set(job.id, job);
    this.tick();
  }

  /** A job's latest snapshot. A final one leaves the block. */
  update(job: JobSnapshot, final: boolean): void {
    if (final) this.jobs.delete(job.id);
    else this.jobs.set(job.id, job);
    this.tick();
  }

  stoppable(): StoppableJob[] {
    return [...this.jobs.values()].flatMap((job): StoppableJob[] => {
      if (job.kind === 'bash') {
        return job.status === 'running' && !job.stopRequested
          ? [{ label: `Command: ${job.command}`, jobId: job.id, task: undefined }]
          : [];
      }
      return job.tasks
        .filter((task) => isUnfinished(task) && !task.stopRequested)
        .map((task) => ({
          label: `Sub-agent ${task.index + 1}: ${task.description ?? task.task}`,
          jobId: job.id,
          task: task.index + 1,
        }));
    });
  }

  render(width: number): string[] {
    const now = this.now();
    const lines = [...this.jobs.values()].flatMap((job) => jobLines(job, now));
    if (lines.length === 0) return [];
    // Indented by one, like the text around it.
    return ['', ...lines.map((line) => truncateToWidth(` ${line}`, width))];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Keeps the clocks moving while anything runs. */
  private tick(): void {
    if (this.jobs.size > 0 && !this.timer) {
      this.timer = setInterval(() => this.ui.requestRender(), TICK_MS);
    } else if (this.jobs.size === 0) {
      this.dispose();
    }
    this.ui.requestRender();
  }
}

/** A running job as lines of the live block. */
export function jobLines(job: JobSnapshot, now: number): string[] {
  return job.kind === 'bash' ? bashLines(job, now) : subagentLines(job, now);
}

/** How a settled job ended, in one line for the chat. */
export function jobSummary(job: JobSnapshot, now: number): string {
  if (job.kind === 'bash') {
    return `${bashIcon(job)} Command ${job.statusText} after ${elapsed(job.startedAt, job.endedAt, now)}: ${job.command}`;
  }
  const done = job.tasks.filter((task) => task.status === 'succeeded').length;
  return `${jobIcon(job.status)} Sub-agents ${job.status}: ${done} of ${job.tasks.length} done after ${elapsed(job.startedAt, job.endedAt, now)}`;
}

function bashLines(job: BashJobSnapshot, now: number): string[] {
  const status = job.stopRequested && job.status === 'running' ? 'stopping…' : job.statusText;
  const lines = [
    `${bashIcon(job)} ${job.command} ${dim(`· ${status} · ${elapsed(job.startedAt, job.endedAt, now)}`)}`,
  ];
  if (job.lastLine) lines.push(dim(`   ${job.lastLine}`));
  return lines;
}

function subagentLines(job: SubagentJobSnapshot, now: number): string[] {
  const done = job.tasks.filter((task) => !isUnfinished(task)).length;
  const head = `${jobIcon(job.status)} Sub-agents ${dim(`· ${done} of ${job.tasks.length} done · ${elapsed(job.startedAt, job.endedAt, now)}`)}`;
  return [
    head,
    ...job.tasks.flatMap((task) => {
      const status = task.stopRequested && isUnfinished(task) ? 'stopping…' : task.status;
      const clock =
        task.startedAt !== null ? ` · ${elapsed(task.startedAt, task.endedAt, now)}` : '';
      const line = `   ${task.index + 1}. ${taskIcon(task)} ${task.description ?? task.task} ${dim(`· ${status}${clock}`)}`;
      const lastTool = task.status === 'running' ? task.toolCalls.at(-1) : undefined;
      return lastTool ? [line, dim(`      ↳ ${lastTool}`)] : [line];
    }),
  ];
}

function isUnfinished(task: SubagentTaskSnapshot): boolean {
  return task.status === 'queued' || task.status === 'running';
}

function bashIcon(job: BashJobSnapshot): string {
  if (job.status === 'running') return job.stopRequested ? '⏹' : '⏳';
  if (job.status === 'exited') return job.exitCode === 0 ? '✅' : '❌';
  if (job.status === 'stopped') return '⏹';
  return '❌';
}

function jobIcon(status: SubagentJobSnapshot['status']): string {
  if (status === 'running') return '⏳';
  if (status === 'succeeded') return '✅';
  if (status === 'stopped') return '⏹';
  return '❌';
}

function taskIcon(task: SubagentTaskSnapshot): string {
  switch (task.status) {
    case 'queued':
      return '⏸';
    case 'running':
      return task.stopRequested ? '⏹' : '⏳';
    case 'succeeded':
      return '✅';
    case 'stopped':
      return '⏹';
    case 'failed':
      return '❌';
  }
}

function elapsed(startedAt: number, endedAt: number | null, now: number): string {
  return formatUptime((endedAt ?? now) - startedAt);
}
