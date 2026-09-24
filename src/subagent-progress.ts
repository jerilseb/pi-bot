import { jobStopCallbackData, type ProgressContent } from './job-progress.ts';
import type { InlineKeyboardButton } from './telegram.ts';
import { clipEscapedTelegramHtml } from './telegram-html.ts';
import { formatDuration } from './util.ts';

/**
 * The live progress message of a sub-agent job the chat started (one
 * subagent_run call), rendered from the job's plain state. Pure, so every state
 * it passes through can be tested; src/job-progress.ts keeps it current.
 *
 * Each task is a numbered row with its status, elapsed time, tool count, and
 * what its worker is doing now; once it finishes, its result folds into an
 * expandable quote. Telegram buttons sit under a message, not beside a row, so
 * each running or queued task's Stop button names the row it stops. Stopping
 * ends that worker alone: the rest of the job carries on.
 */

export type SubagentTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped';

/** What the message shows of one task. src/subagent.ts's task record extends it. */
export interface SubagentProgressTask {
  /** 0-based; rows show it 1-based, and the number never changes. */
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
  toolUses: number;
  result: string | null;
  error: string | null;
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

/** How a row reads. A stop in flight is its own state until the worker has ended. */
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
const TITLE_MAX_CHARS = 48;
const COMPACT_TITLE_MAX_CHARS = 32;
const ACTIVITY_MAX_CHARS = 56;
const MODEL_MAX_CHARS = 40;
const ERROR_MAX_CHARS = 160;
const RESULT_MAX_CHARS = 2_000;
/** A result squeezed below this is left out rather than shown as a stub. */
const RESULT_MIN_CHARS = 120;
const RESULT_QUOTE_OVERHEAD = '\n<blockquote expandable></blockquote>'.length;
const BUTTON_TITLE_MAX_CHARS = 28;
/** Past this many stoppable tasks, Stop buttons shrink to numbers, several to a line. */
const FULL_BUTTONS_MAX = 3;
const COMPACT_BUTTONS_PER_LINE = 3;

const STATE_ICON: Record<RowState, string> = {
  queued: '⏸',
  running: '⏳',
  stopping: '⏳',
  succeeded: '✅',
  failed: '❌',
  stopped: '⏹',
};

const STATE_LABEL: Record<RowState, string> = {
  queued: 'queued',
  running: 'running',
  stopping: 'stopping',
  succeeded: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

/** The header's counts, in this order. A stop in flight counts as running. */
const HEADER_ORDER = ['running', 'queued', 'done', 'failed', 'stopped'];

/** The message for a job: the HTML and the Stop buttons of its unfinished tasks. */
export function formatSubagentProgress(
  job: SubagentProgressJob,
  now: number = Date.now(),
): ProgressContent {
  const rows = job.tasks.map((task) => ({ task, state: rowState(job, task) }));
  return { html: renderHtml(job, rows, now), keyboard: stopKeyboard(job, rows) };
}

function rowState(job: SubagentProgressJob, task: SubagentProgressTask): RowState {
  if (task.status !== 'queued' && task.status !== 'running') return task.status;
  // The job ended with this worker still winding down: it was stopped under it
  // (subagent_stop, shutdown), and the final message must not say "running".
  if (job.status !== 'running') return 'stopped';
  return task.stopRequested ? 'stopping' : task.status;
}

function renderHtml(job: SubagentProgressJob, rows: Row[], now: number): string {
  const header = renderHeader(job, rows, now);
  const showModels = new Set(rows.map(({ task }) => task.model)).size > 1;
  const blocks = rows.map((row) => renderRow(job, row, now, showModels));
  const length = [header, ...blocks].join('\n\n').length;
  if (length <= MESSAGE_MAX_CHARS) {
    return [header, ...withResults(rows, blocks, MESSAGE_MAX_CHARS - length)].join('\n\n');
  }
  // Too much for full rows: one line per task, as many as fit.
  const compact = rows.map((row) => renderCompactRow(job, row, now));
  return [header, fitFirst(compact, MESSAGE_MAX_CHARS - header.length - 2)].join('\n\n');
}

function renderHeader(job: SubagentProgressJob, rows: Row[], now: number): string {
  const [only] = rows;
  if (rows.length === 1 && only) return `🤖 <b>Sub-agent</b> · ${STATE_LABEL[only.state]}`;
  const counts = new Map<string, number>();
  for (const { state } of rows) {
    const label = STATE_LABEL[state === 'stopping' ? 'running' : state];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = HEADER_ORDER.filter((label) => counts.has(label)).map(
    (label) => `${counts.get(label)} ${label}`,
  );
  // Once every task has ended, the time the whole job took.
  if (rows.every(({ state }) => isEnded(state))) {
    parts.push(`⏱ ${formatDuration((job.endedAt ?? now) - job.startedAt)}`);
  }
  return `🤖 <b>Sub-agents</b> · ${parts.join(' · ')}`;
}

function renderRow(job: SubagentProgressJob, row: Row, now: number, showModel: boolean): string {
  const { task, state } = row;
  const title = clipEscapedTelegramHtml(taskTitle(task), TITLE_MAX_CHARS);
  const lines = [
    `${STATE_ICON[state]} <b>${task.index + 1}. ${title}</b>`,
    renderMeta(job, row, now, showModel),
  ];
  if ((state === 'running' || state === 'stopping') && task.startedAt !== null) {
    const activity = clipEscapedTelegramHtml(
      oneLine(task.activity ?? 'starting…'),
      ACTIVITY_MAX_CHARS,
    );
    lines.push(`↳ <i>${activity}</i>`);
  }
  if (state === 'failed' && task.error) {
    lines.push(`<i>${clipEscapedTelegramHtml(oneLine(task.error), ERROR_MAX_CHARS)}</i>`);
  }
  return lines.join('\n');
}

function renderMeta(job: SubagentProgressJob, row: Row, now: number, showModel: boolean): string {
  const { task, state } = row;
  const parts: string[] = [];
  if (showModel) parts.push(`<code>${clipEscapedTelegramHtml(task.model, MODEL_MAX_CHARS)}</code>`);
  if (task.startedAt === null) {
    // Never got a worker: no clock or tools to show.
    if (state === 'queued') parts.push('waiting for a free worker');
    else if (state === 'stopping') parts.push('stopping…');
    else parts.push(`${stoppedBy(task)} before it started`);
    return parts.join(' · ');
  }
  const elapsed = formatDuration((task.endedAt ?? job.endedAt ?? now) - task.startedAt);
  if (state === 'failed') parts.push(`failed after ${elapsed}`);
  else if (state === 'stopped') parts.push(`${stoppedBy(task)} after ${elapsed}`);
  else parts.push(elapsed);
  if (task.toolUses > 0) parts.push(`${task.toolUses} ${task.toolUses === 1 ? 'tool' : 'tools'}`);
  if (state === 'stopping') parts.push('stopping…');
  return parts.join(' · ');
}

function stoppedBy(task: SubagentProgressTask): string {
  return task.stopRequested ? 'stopped by you' : 'stopped';
}

function renderCompactRow(job: SubagentProgressJob, { task, state }: Row, now: number): string {
  const title = clipEscapedTelegramHtml(taskTitle(task), COMPACT_TITLE_MAX_CHARS);
  const clock =
    task.startedAt === null
      ? STATE_LABEL[state]
      : formatDuration((task.endedAt ?? job.endedAt ?? now) - task.startedAt);
  return `${STATE_ICON[state]} <b>${task.index + 1}.</b> ${title} · ${clock}`;
}

/** Folds each result into its row, sharing out the room left under the message limit. */
function withResults(rows: Row[], blocks: string[], room: number): string[] {
  const result = ({ task, state }: Row): string =>
    state === 'succeeded' ? plainResult(task.result ?? '') : '';
  const shown = rows.filter((row) => result(row)).length;
  if (shown === 0) return blocks;
  const allowance = Math.min(RESULT_MAX_CHARS, Math.floor(room / shown) - RESULT_QUOTE_OVERHEAD);
  if (allowance < RESULT_MIN_CHARS) return blocks;
  return rows.map((row, i) => {
    const block = blocks[i] ?? '';
    const text = result(row);
    if (!text) return block;
    return `${block}\n<blockquote expandable>${clipEscapedTelegramHtml(text, allowance)}</blockquote>`;
  });
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

function stopKeyboard(job: SubagentProgressJob, rows: Row[]): InlineKeyboardButton[][] {
  const targets = rows
    .filter(({ state }) => state === 'running' || state === 'queued')
    .map(({ task }) => task);
  if (targets.length <= FULL_BUTTONS_MAX) {
    return targets.map((task) => [
      {
        text: `⏹ Stop ${task.index + 1} · ${clip(taskTitle(task), BUTTON_TITLE_MAX_CHARS)}`,
        callback_data: jobStopCallbackData(job.id, task.index + 1),
      },
    ]);
  }
  const lines: InlineKeyboardButton[][] = [];
  for (let i = 0; i < targets.length; i += COMPACT_BUTTONS_PER_LINE) {
    lines.push(
      targets.slice(i, i + COMPACT_BUTTONS_PER_LINE).map((task) => ({
        text: `⏹ Stop ${task.index + 1}`,
        callback_data: jobStopCallbackData(job.id, task.index + 1),
      })),
    );
  }
  return lines;
}

/** The agent's short title, or else the first line of the task itself. */
function taskTitle(task: SubagentProgressTask): string {
  const description = oneLine(task.description ?? '');
  if (description) return description;
  const firstLine = task.task.split('\n').find((line) => line.trim()) ?? task.task;
  return oneLine(firstLine) || `Task ${task.index + 1}`;
}

function isEnded(state: RowState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'stopped';
}

/** Results arrive as Markdown; inside a quote they read better as plain text. */
function plainResult(text: string): string {
  return text
    .replace(/^```.*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Plain text on one line of at most `max` characters, cut on a character boundary. */
function clip(text: string, max: number): string {
  const chars = Array.from(oneLine(text));
  if (chars.length <= max) return chars.join('');
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}
