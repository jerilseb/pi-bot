import type { BashJobSnapshot } from '../../contract.ts';
import { formatDuration, oneLineLabel } from '../../util.ts';
import { jobStopCallbackData, type ProgressContent } from './job-progress.ts';
import { clipEscapedTelegramHtml, escapeTelegramHtml } from './telegram-html.ts';

/**
 * Display widths in the progress message. The whole message stays well under
 * Telegram's 4096-char limit once escaped, so it is never split: an edit only
 * reaches one message, and a split would leave the Stop button on a piece that
 * is never updated. The command gets whatever room the other lines leave.
 */
const PROGRESS_MESSAGE_MAX_CHARS = 3_900;
const PROGRESS_OUTPUT_MAX_CHARS = 120;
const PROGRESS_COMMAND_WRAPPER = ['<blockquote expandable><code>', '</code></blockquote>'];

/**
 * The progress message of a command the chat started, as Telegram HTML: status
 * and runtime, the command in an expandable blockquote, and its latest line of
 * output, with a Stop button while it runs. The command keeps its line breaks,
 * so a multi-line script reads as written once expanded, while the folded quote
 * keeps the message short. Rendered for the final state too, so the same
 * message ends on the outcome.
 */
export function formatBashProgress(job: BashJobSnapshot, now = Date.now()): ProgressContent {
  const icon =
    job.status === 'running'
      ? '⏳'
      : job.status === 'exited' && job.exitCode === 0
        ? '✅'
        : job.status === 'stopped'
          ? '⏹'
          : '❌';
  const runtime = formatDuration((job.endedAt ?? now) - job.startedAt);
  const header = `${icon} <b>Background bash</b> · ${escapeTelegramHtml(job.statusText)} · ${runtime}`;
  const outputLine = job.lastLine
    ? `<i>${escapeTelegramHtml(oneLineLabel(job.lastLine, PROGRESS_OUTPUT_MAX_CHARS))}</i>`
    : null;

  const [open, close] = PROGRESS_COMMAND_WRAPPER;
  const others = [header, outputLine].filter((line) => line !== null);
  const room =
    PROGRESS_MESSAGE_MAX_CHARS -
    others.reduce((total, line) => total + line.length + 1, 0) -
    open.length -
    close.length;
  const command = `${open}${clipEscapedTelegramHtml(progressCommand(job.command), room)}${close}`;

  const stoppable = job.status === 'running' && !job.stopRequested;
  return {
    html: [header, command, ...(outputLine ? [outputLine] : [])].join('\n'),
    keyboard: stoppable ? [[{ text: '⏹ Stop', callback_data: jobStopCallbackData(job.id) }]] : [],
  };
}

/** The command as shown in the progress message: line breaks kept, trailing space dropped. */
function progressCommand(command: string): string {
  return command
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}
