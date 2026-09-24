import { jobStopCallbackData, type ProgressContent } from './job-progress.ts';
import type { InlineKeyboardButton } from './telegram.ts';
import { clipEscapedTelegramHtml } from './telegram-html.ts';
import { formatDuration } from './util.ts';

/**
 * The live progress message of a sub-agent job the chat started (one
 * subagent_run call), rendered from the job's plain state. Pure, so every state
 * it passes through can be tested; src/job-progress.ts keeps it current.
 *
 * Kept small by default: the agent's own reply carries the results, so the
 * message only has to say how the job is going. While it runs, each task is one
 * line (status, number, title, and a short detail), with a row of numbered Stop
 * buttons, one per unfinished task. Stopping ends that worker alone: the rest
 * of the job carries on. Once every task has ended, the message shrinks to a
 * one-line summary with the task lines folded into an expandable quote.
 *
 * With the `subagentToolCalls` setting on, each task's line is followed by an
 * expandable quote of its worker's recent tool calls, newest first, so the
 * folded quote shows what the worker is doing now. When the task finishes, its
 * result replaces them (or its error, if it failed).
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
  /** The worker's recent tool calls, oldest first, each one line of plain text. */
  toolCalls: readonly string[];
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

export interface SubagentProgressOptions {
  /** Show each worker's tool calls, then its result: the `subagentToolCalls` setting. */
  toolCalls?: boolean;
  now?: number;
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
const TOOL_CALL_MAX_CHARS = 56;
const MODEL_MAX_CHARS = 24;
const ERROR_MAX_CHARS = 160;
const RESULT_MAX_CHARS = 2_000;
/** A result squeezed below this is left out rather than shown as a stub. */
const RESULT_MIN_CHARS = 120;
const BUTTONS_PER_LINE = 4;
/** How many of a worker's tool calls its task keeps for the message. */
export const TOOL_CALLS_SHOWN = 8;

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
  options: SubagentProgressOptions = {},
): ProgressContent {
  const now = options.now ?? Date.now();
  const rows = job.tasks.map((task) => ({ task, state: rowState(job, task) }));
  // The detailed form falls back to the compact one when it cannot fit.
  const detailed = options.toolCalls ? renderDetailed(job, rows, now) : null;
  return { html: detailed ?? renderCompact(job, rows, now), keyboard: stopKeyboard(job, rows) };
}

function rowState(job: SubagentProgressJob, task: SubagentProgressTask): RowState {
  if (task.status !== 'queued' && task.status !== 'running') return task.status;
  // The job ended with this worker still winding down: it was stopped under it
  // (subagent_stop, shutdown), and the final message must not say "running".
  if (job.status !== 'running') return 'stopped';
  return task.stopRequested ? 'stopping' : task.status;
}

/** One line per task; once every task has ended, a summary with the lines folded. */
function renderCompact(job: SubagentProgressJob, rows: Row[], now: number): string {
  const [only] = rows;
  if (rows.length === 1 && only) return singleLine(job, only, now);
  const header = manyHeader(job, rows, now);
  const lines = taskLines(job, rows, now);
  if (allEnded(rows)) {
    // The agent's reply follows with the results: one line says the job is over,
    // and the task lines stay available folded.
    const room = MESSAGE_MAX_CHARS - header.length - QUOTE_OVERHEAD;
    return `${header}\n${quote(fitFirst(lines, room))}`;
  }
  return `${header}\n${fitFirst(lines, MESSAGE_MAX_CHARS - header.length - 1)}`;
}

/**
 * Each task's line followed by a folded quote: its worker's recent tool calls
 * while it runs, then its result or error. Results share the room the rest
 * leaves. Null when even the lines and tool calls do not fit, which only a job
 * with far more tasks than the default limit could reach.
 */
function renderDetailed(job: SubagentProgressJob, rows: Row[], now: number): string | null {
  const [only] = rows;
  const header = rows.length === 1 ? null : manyHeader(job, rows, now);
  const lines =
    rows.length === 1 && only ? [singleLine(job, only, now)] : taskLines(job, rows, now);
  const blocks = rows.map((row, i) => {
    const body = fixedQuoteBody(row);
    return body ? `${lines[i]}\n${quote(body)}` : `${lines[i]}`;
  });
  const join = (parts: string[]): string => (header ? [header, ...parts] : parts).join('\n');
  const base = join(blocks).length;
  if (base > MESSAGE_MAX_CHARS) return null;

  const results = rows.map(({ task, state }) =>
    state === 'succeeded' ? plainResult(task.result ?? '') : '',
  );
  const shown = results.filter(Boolean).length;
  if (shown === 0) return join(blocks);
  const allowance = Math.min(
    RESULT_MAX_CHARS,
    Math.floor((MESSAGE_MAX_CHARS - base) / shown) - QUOTE_OVERHEAD,
  );
  if (allowance < RESULT_MIN_CHARS) return join(blocks);
  return join(
    blocks.map((block, i) => {
      const result = results[i];
      return result ? `${block}\n${quote(clipEscapedTelegramHtml(result, allowance))}` : block;
    }),
  );
}

/** The quote a task keeps whatever the room: its tool calls while it runs, or its error. */
function fixedQuoteBody({ task, state }: Row): string | null {
  if ((state === 'running' || state === 'stopping') && task.toolCalls.length > 0) {
    return task.toolCalls
      .slice(-TOOL_CALLS_SHOWN)
      .reverse()
      .map((call) => clipEscapedTelegramHtml(oneLine(call), TOOL_CALL_MAX_CHARS))
      .join('\n');
  }
  if (state === 'failed' && task.error) {
    return clipEscapedTelegramHtml(oneLine(task.error), ERROR_MAX_CHARS);
  }
  return null;
}

/** The header of a job with several tasks: its clock while it runs, then a summary. */
function manyHeader(job: SubagentProgressJob, rows: Row[], now: number): string {
  if (!allEnded(rows)) return `🤖 <b>Sub-agents</b> · ${formatDuration(now - job.startedAt)}`;
  const total = formatDuration((job.endedAt ?? now) - job.startedAt);
  return `🤖 <b>Sub-agents</b> · ${summary(rows)} · ⏱ ${total}`;
}

function taskLines(job: SubagentProgressJob, rows: Row[], now: number): string[] {
  const showModels = new Set(rows.map(({ task }) => task.model)).size > 1;
  return rows.map((row) => renderRow(job, row, now, showModels));
}

/** A one-task job's line: the job and its task at once. */
function singleLine(job: SubagentProgressJob, row: Row, now: number): string {
  const { task, state } = row;
  const parts = [`${STATE_ICON[state]} <b>Sub-agent</b>`, title(task)];
  if (state === 'running') parts.push(formatDuration(now - job.startedAt));
  const detail = rowDetail(job, row, now) ?? (state === 'queued' ? 'queued' : null);
  if (detail) parts.push(detail);
  return parts.join(' · ');
}

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

function quote(html: string): string {
  return `<blockquote expandable>${html}</blockquote>`;
}

const QUOTE_OVERHEAD = `\n${quote('')}`.length;

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

function allEnded(rows: Row[]): boolean {
  return rows.every(({ state }) => isEnded(state));
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
