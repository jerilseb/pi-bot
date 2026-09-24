import { jobStopCallbackData, type ProgressContent } from './job-progress.ts';
import type { InlineKeyboardButton } from './telegram.ts';
import { clipEscapedTelegramHtml } from './telegram-html.ts';
import { formatDuration } from './util.ts';

/**
 * The live progress message of a sub-agent job the chat started (one
 * subagent_run call), rendered from the job's plain state. Pure, so every state
 * it passes through can be tested; src/job-progress.ts keeps it current.
 *
 * Kept small on purpose: the agent's own reply carries the results, so the
 * message only has to say how the job is going. While it runs, each task is one
 * line (status, number, title, and a short detail), followed by the latest tool
 * call any worker made, and a row of numbered Stop buttons, one per unfinished
 * task. Stopping ends that worker alone: the rest of the job carries on. Once
 * every task has ended, the message shrinks to a one-line summary with the
 * task lines folded into an expandable quote.
 */

export type SubagentTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped';

/** What the message shows of one task. src/subagent.ts's task record extends it. */
export interface SubagentProgressTask {
  /** 0-based; lines show it 1-based, and the number never changes. */
  index: number;
  task: string;
  /** The agent's short title for the task, if it gave one. */
  description: string | null;
  /** provider/model the worker runs on. */
  model: string;
  status: SubagentTaskStatus;
  /** The user tapped this task's Stop button; set before the abort. */
  stopRequested: boolean;
  /** The worker's latest tool call, as one line of plain text. */
  activity: string | null;
  /** When that tool call started, so the message can show the latest across workers. */
  activityAt: number | null;
  toolUses: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface SubagentProgressJob {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'stopped';
  startedAt: number;
  endedAt: number | null;
  tasks: readonly SubagentProgressTask[];
}

/** How a task's line reads. A stop in flight is its own state until the worker has ended. */
type RowState = 'queued' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped';

interface Row {
  task: SubagentProgressTask;
  state: RowState;
}

/**
 * Well under Telegram's 4096-character limit once escaped, so the message is
 * never split: an edit reaches only one message, and a split would leave the
 * buttons on a piece that is never updated.
 */
const MESSAGE_MAX_CHARS = 3_900;
const TITLE_MAX_CHARS = 40;
const ACTIVITY_MAX_CHARS = 56;
const MODEL_MAX_CHARS = 24;
const BUTTONS_PER_LINE = 4;

const STATE_ICON: Record<RowState, string> = {
  queued: '⏸',
  running: '⏳',
  stopping: '⏳',
  succeeded: '✅',
  failed: '❌',
  stopped: '⏹',
};

/** The summary's counts, in this order. */
const SUMMARY_ORDER: Array<[state: RowState, label: string]> = [
  ['succeeded', 'done'],
  ['failed', 'failed'],
  ['stopped', 'stopped'],
];

/** The message for a job: the HTML and the Stop buttons of its unfinished tasks. */
export function formatSubagentProgress(
  job: SubagentProgressJob,
  now: number = Date.now(),
): ProgressContent {
  const rows = job.tasks.map((task) => ({ task, state: rowState(job, task) }));
  const [only] = rows;
  const html =
    rows.length === 1 && only ? renderSingle(job, only, now) : renderMany(job, rows, now);
  return { html, keyboard: stopKeyboard(job, rows) };
}

function rowState(job: SubagentProgressJob, task: SubagentProgressTask): RowState {
  if (task.status !== 'queued' && task.status !== 'running') return task.status;
  // The job ended with this worker still winding down: it was stopped under it
  // (subagent_stop, shutdown), and the final message must not say "running".
  if (job.status !== 'running') return 'stopped';
  return task.stopRequested ? 'stopping' : task.status;
}

/** A one-task job is one line, plus what its worker is doing while it runs. */
function renderSingle(job: SubagentProgressJob, row: Row, now: number): string {
  const { task, state } = row;
  const parts = [`${STATE_ICON[state]} <b>Sub-agent</b>`, title(task)];
  if (state === 'running') parts.push(formatDuration(now - job.startedAt));
  const detail = rowDetail(job, row, now) ?? (state === 'queued' ? 'queued' : null);
  if (detail) parts.push(detail);
  const lines = [parts.join(' · ')];
  if (state === 'running' && task.activity) lines.push(activityLine(task.activity));
  return lines.join('\n');
}

function renderMany(job: SubagentProgressJob, rows: Row[], now: number): string {
  const showModels = new Set(rows.map(({ task }) => task.model)).size > 1;
  const lines = rows.map((row) => renderRow(job, row, now, showModels));
  if (rows.every(({ state }) => isEnded(state))) {
    // The agent's reply follows with the results: one line says the job is over,
    // and the task lines stay available folded.
    const total = formatDuration((job.endedAt ?? now) - job.startedAt);
    const header = `🤖 <b>Sub-agents</b> · ${summary(rows)} · ⏱ ${total}`;
    const room = MESSAGE_MAX_CHARS - header.length - QUOTE_OVERHEAD;
    return `${header}\n<blockquote expandable>${fitFirst(lines, room)}</blockquote>`;
  }
  const header = `🤖 <b>Sub-agents</b> · ${formatDuration(now - job.startedAt)}`;
  const latest = latestActivity(rows);
  const footer = latest ? activityLine(latest.activity, latest.number) : null;
  const room = MESSAGE_MAX_CHARS - header.length - 1 - (footer ? footer.length + 1 : 0);
  return [header, fitFirst(lines, room), ...(footer ? [footer] : [])].join('\n');
}

const QUOTE_OVERHEAD = '\n<blockquote expandable></blockquote>'.length;

function renderRow(job: SubagentProgressJob, row: Row, now: number, showModel: boolean): string {
  const { task, state } = row;
  const parts = [`${STATE_ICON[state]} ${task.index + 1}. ${title(task)}`];
  if (showModel) {
    parts.push(`<code>${clipEscapedTelegramHtml(modelName(task.model), MODEL_MAX_CHARS)}</code>`);
  }
  const detail = rowDetail(job, row, now);
  if (detail) parts.push(detail);
  return parts.join(' · ');
}

/**
 * The short detail after a task's title. A running task shows its tool count,
 * since the header carries the clock; a finished one how long it took, or how
 * it ended.
 */
function rowDetail(job: SubagentProgressJob, { task, state }: Row, now: number): string | null {
  const elapsed = (): string =>
    formatDuration((task.endedAt ?? job.endedAt ?? now) - (task.startedAt ?? job.startedAt));
  switch (state) {
    case 'queued':
      return null;
    case 'running':
      return task.toolUses > 0
        ? `${task.toolUses} ${task.toolUses === 1 ? 'tool' : 'tools'}`
        : null;
    case 'stopping':
      return 'stopping…';
    case 'succeeded':
      return elapsed();
    case 'failed':
      return `failed after ${elapsed()}`;
    case 'stopped':
      return task.stopRequested ? 'stopped by you' : 'stopped';
  }
}

function summary(rows: Row[]): string {
  return SUMMARY_ORDER.flatMap(([state, label]) => {
    const count = rows.filter((row) => row.state === state).length;
    return count > 0 ? [`${count} ${label}`] : [];
  }).join(' · ');
}

/** The most recent tool call among the tasks still running, with the task's number. */
function latestActivity(rows: Row[]): { activity: string; number: number } | null {
  let latest: { activity: string; number: number; at: number } | null = null;
  for (const { task, state } of rows) {
    if (state !== 'running' || !task.activity || task.activityAt === null) continue;
    if (!latest || task.activityAt > latest.at) {
      latest = { activity: task.activity, number: task.index + 1, at: task.activityAt };
    }
  }
  return latest;
}

function activityLine(activity: string, number?: number): string {
  const text = clipEscapedTelegramHtml(oneLine(activity), ACTIVITY_MAX_CHARS);
  return `<i>↳ ${number === undefined ? '' : `${number}: `}${text}</i>`;
}

/** Keeps the first lines that fit in `room`, noting how many were left out. */
function fitFirst(lines: string[], room: number): string {
  const all = lines.join('\n');
  if (all.length <= room) return all;
  const note = (count: number): string => `<i>+ ${count} more not shown</i>`;
  const kept: string[] = [];
  let used = note(lines.length).length;
  for (const line of lines) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  return [...kept, note(lines.length - kept.length)].join('\n');
}

/**
 * One numbered button per unfinished task, several to a line: the numbers match
 * the task lines, so a title would only repeat them. A lone task's button just
 * says Stop.
 */
function stopKeyboard(job: SubagentProgressJob, rows: Row[]): InlineKeyboardButton[][] {
  const targets = rows
    .filter(({ state }) => state === 'running' || state === 'queued')
    .map(({ task }) => task);
  if (rows.length === 1) {
    return targets.map((task) => [
      { text: '⏹ Stop', callback_data: jobStopCallbackData(job.id, task.index + 1) },
    ]);
  }
  const lines: InlineKeyboardButton[][] = [];
  for (let i = 0; i < targets.length; i += BUTTONS_PER_LINE) {
    lines.push(
      targets.slice(i, i + BUTTONS_PER_LINE).map((task) => ({
        text: `⏹ ${task.index + 1}`,
        callback_data: jobStopCallbackData(job.id, task.index + 1),
      })),
    );
  }
  return lines;
}

/** The agent's short title, or else the first line of the task itself, escaped and clipped. */
function title(task: SubagentProgressTask): string {
  const description = oneLine(task.description ?? '');
  const firstLine = task.task.split('\n').find((line) => line.trim()) ?? task.task;
  const text = description || oneLine(firstLine) || `Task ${task.index + 1}`;
  return clipEscapedTelegramHtml(text, TITLE_MAX_CHARS);
}

/** The model without its provider, e.g. `gpt-6-sol`, which is what tells tasks apart. */
function modelName(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1) || model;
}

function isEnded(state: RowState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'stopped';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
