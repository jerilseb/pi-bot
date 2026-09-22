import * as path from 'node:path';
import {
  createLocalBashOperations,
  type ExtensionAPI,
  formatSize,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { buildAgentEnvelope } from './agent-envelope.ts';
import {
  BACKGROUND_JOB_END_TURN_AFTER_MS,
  BACKGROUND_BASH_COMPLETED_TTL_MS,
  BACKGROUND_BASH_DEFAULT_MAX_RUNTIME_MS,
  BACKGROUND_BASH_DEFAULT_YIELD_MS,
  BACKGROUND_BASH_MAX_RUNNING,
  BACKGROUND_BASH_MAX_RUNTIME_CAP_MS,
  BACKGROUND_BASH_MAX_YIELD_MS,
  BACKGROUND_BASH_NOOP,
  BACKGROUND_BASH_REPORT_OUTPUT_MAX_CHARS,
  BACKGROUND_BASH_STOP_WAIT_MS,
  BACKGROUND_BASH_WAIT_OUTPUT_MAX_CHARS,
  BACKGROUND_WAIT_CHECK_MS,
  BACKGROUND_WAIT_MAX_MS,
} from './config.ts';
import {
  captureJobOrigin,
  type Job,
  type JobOrigin,
  JobRegistry,
  jobReportPrompt,
  type WaitOutcome,
} from './job-registry.ts';
import { BoundedOutputBuffer, type OutputSnapshot } from './output-buffer.ts';
import { escapeTelegramHtml } from './telegram-html.ts';
import { textResult } from './tool-result.ts';
import type { IncomingPrompt, SessionKind } from './types.ts';
import { clamp, errorMessage, formatDuration, oneLineLabel } from './util.ts';

/**
 * Background bash sessions for the Pi agent: start long-running shell commands
 * without blocking the agent turn, then poll, list, stop, and report their
 * completion back to the main chat agent later.
 *
 * Sessions live in a module-level registry in src/ (imported once by Node), so
 * they are shared across Pi sessions for the lifetime of the bot process. File
 * extensions under extensions/ get fresh module state per Pi session and cannot
 * own running child processes.
 *
 * Both Pi sessions can start commands, so each session records which one did
 * and the model it was on. The completion report is routed back there: a
 * command a scheduled task started reports to the background session that
 * remembers starting it, not to the chat.
 *
 * Lifecycle bookkeeping (IDs, yield-then-background, pruning, stopping, report
 * routing and delivery) lives in src/job-registry.ts. Tuning knobs live in
 * src/config.ts under "Background work".
 */

type BackgroundBashTerminalStatus = 'exited' | 'stopped' | 'failed';

interface BackgroundBashSession extends Job<BackgroundBashTerminalStatus> {
  command: string;
  cwd: string;
  output: BoundedOutputBuffer;
  /** Output position the agent has seen up to, so reads and waits return only what is new. */
  outputSeen: number;
  /** When outputSeen last moved, for "no new output since…". */
  outputSeenAt: number;
  abort: AbortController;
  exitCode: number | null;
}

export interface BackgroundBashReport {
  sessionId: string;
  command: string;
  cwd: string;
  origin: JobOrigin;
  outcome: string;
  output: string;
}

const registry = new JobRegistry<
  BackgroundBashTerminalStatus,
  BackgroundBashSession,
  BackgroundBashReport
>({
  idPrefix: 'bg',
  jobNoun: 'background session',
  jobNounPlural: 'background sessions',
  listToolName: 'background_bash_list',
  completedTtlMs: BACKGROUND_BASH_COMPLETED_TTL_MS,
  cancelWaitMs: BACKGROUND_BASH_STOP_WAIT_MS,
  cancelledStatus: 'stopped',
  signalCancel: (session) => session.abort.abort(),
  describeStatus,
  renderProgress: (session) => formatBackgroundBashProgress(session),
  buildReport: (session) => ({
    sessionId: session.id,
    command: session.command,
    cwd: session.cwd,
    origin: session.origin,
    outcome: describeReportOutcome(session),
    output: formatReportOutput(session.output.snapshot(), session.id),
  }),
});

/** Wires completion reports into the bot's incoming-prompt pipeline. Called from main.ts. */
export function setBackgroundBashReportHandler(
  handler: (report: BackgroundBashReport) => Promise<void>,
): void {
  registry.setReportHandler(handler);
}

/** The end-your-turn threshold, as the agent reads it (e.g. "3m"). */
const END_TURN_AFTER = formatDuration(BACKGROUND_JOB_END_TURN_AFTER_MS);

const StartParams = Type.Object({
  command: Type.String({ description: 'Bash command to run in the background.', minLength: 1 }),
  cwd: Type.Optional(
    Type.String({
      description: 'Working directory. Relative paths resolve against the bot cwd.',
    }),
  ),
  yield_time_ms: Type.Optional(
    Type.Number({
      description: `How long to wait for the command before backgrounding it (default ${BACKGROUND_BASH_DEFAULT_YIELD_MS}ms, max ${BACKGROUND_BASH_MAX_YIELD_MS}ms).`,
    }),
  ),
  max_runtime_ms: Type.Optional(
    Type.Number({
      description: `Kill the command after this long (default ${BACKGROUND_BASH_DEFAULT_MAX_RUNTIME_MS}ms).`,
    }),
  ),
});

const ReadParams = Type.Object({
  session_id: Type.String({
    description: 'Background session ID returned by background_bash_start.',
  }),
  mode: Type.Optional(
    Type.Union([Type.Literal('new'), Type.Literal('tail')], {
      description:
        '"new" (default): only output you have not seen yet. "tail": the whole buffered tail, e.g. to re-read output from earlier in this conversation.',
    }),
  ),
});

const WaitParams = Type.Object({
  session_id: Type.String({
    description: 'Background session ID returned by background_bash_start.',
  }),
  timeout_ms: Type.Optional(
    Type.Number({
      description: `Longest to wait (default and max ${BACKGROUND_WAIT_MAX_MS}ms).`,
    }),
  ),
  until: Type.Optional(
    Type.String({
      description:
        'Regular expression; the wait also ends once new output matches it, e.g. a server\'s "listening on" line.',
    }),
  ),
});

const StopParams = Type.Object({
  session_id: Type.String({
    description: 'Background session ID returned by background_bash_start.',
  }),
});

const ListParams = Type.Object({});

const StopAllParams = Type.Object({});

/**
 * Registers the background bash tools for one of the bot's sessions. `session`
 * names which one, so every command started here reports back to it.
 */
export function backgroundBashExtension(session: SessionKind): (pi: ExtensionAPI) => void {
  return (pi) => registerBackgroundBashTools(pi, session);
}

function registerBackgroundBashTools(pi: ExtensionAPI, originSession: SessionKind): void {
  pi.registerTool({
    name: 'background_bash_start',
    label: 'Background Bash',
    description:
      'Run a bash command in the background. Waits briefly; if the command finishes in time the full result is returned, otherwise it keeps running, a session ID is returned, and a completion report is delivered to you when it finishes. Use for long-running commands: dev servers, watchers, long builds, tail -f. Use the normal bash tool for short commands.',
    promptSnippet:
      'Run long-lived shell commands (dev servers, watchers, long builds) with background_bash_start instead of blocking bash.',
    promptGuidelines: [
      'Use the normal bash tool for short commands that complete quickly; use background_bash_start for dev servers, file watchers, long builds, tail -f, or when the user asks to run something in the background.',
      `If a background command may run longer than ${END_TURN_AFTER} in total, or is still running after that, end your turn instead of waiting: tell the user briefly what is running and what you will do once it finishes, then stop. The [background-bash-report] resumes you in this conversation with the result; continue the remaining steps then.`,
      `To wait for a command expected to finish within ${END_TURN_AFTER}, call background_bash_wait: it blocks without polling until the command finishes, its new output matches \`until\`, or the user sends a message, and returns only output you have not seen yet. If the wait times out with the command still running, end your turn as above.`,
      'Never wait by polling background_bash_read or by sleeping in bash; background_bash_read is for inspecting output, and returns only output you have not seen unless you pass mode "tail". Once a read or a wait has shown the finished result, no completion report follows.',
      'The user sees a live progress message for background commands started from the chat, so do not post progress updates yourself.',
      'Background commands have no stdin: anything that might prompt must use non-interactive flags (--yes, CI=true, DEBIAN_FRONTEND=noninteractive) or it will fail fast on stdin EOF.',
      'Stop background sessions with background_bash_stop when they are no longer needed.',
    ],
    parameters: StartParams,

    async execute(_toolCallId, params: Static<typeof StartParams>, _signal, _onUpdate, ctx) {
      const runningCount = registry.runningCount();
      if (runningCount >= BACKGROUND_BASH_MAX_RUNNING) {
        return textResult(
          `Too many background sessions running (${runningCount}/${BACKGROUND_BASH_MAX_RUNNING}). Stop some with background_bash_stop or background_bash_stop_all first.`,
        );
      }

      const cwd = path.resolve(process.cwd(), params.cwd ?? '.');
      const maxRuntimeMs = clamp(
        params.max_runtime_ms ?? BACKGROUND_BASH_DEFAULT_MAX_RUNTIME_MS,
        1_000,
        BACKGROUND_BASH_MAX_RUNTIME_CAP_MS,
      );
      const yieldTimeMs = clamp(
        params.yield_time_ms ?? BACKGROUND_BASH_DEFAULT_YIELD_MS,
        0,
        BACKGROUND_BASH_MAX_YIELD_MS,
      );

      const session = startSession(
        params.command,
        cwd,
        maxRuntimeMs,
        captureJobOrigin(ctx, originSession),
      );
      const backgrounded = await registry.settleOrBackground(session, yieldTimeMs);

      if (!backgrounded) {
        return textResult(
          [describeCompletion(session), 'Output:', formatOutputSnapshot(session)].join('\n'),
        );
      }

      const soFar = formatOutputSnapshot(session);
      markOutputSeen(session);
      return textResult(
        [
          `Started background bash session ${session.id}`,
          `Command: ${session.command}`,
          `Cwd: ${session.cwd}`,
          `Status: running (max runtime ${formatDuration(maxRuntimeMs)})`,
          `If it should finish within ${END_TURN_AFTER}, wait for it with background_bash_wait using session_id "${session.id}". If it may run longer, end your turn now: an internal [background-bash-report] message with the result resumes you when it finishes.`,
          'Output so far:',
          soFar,
        ].join('\n'),
      );
    },
  });

  pi.registerTool({
    name: 'background_bash_read',
    label: 'Read Background Bash',
    description:
      'Read the status and output of a background bash session started with background_bash_start: only output you have not seen yet, or the whole buffered tail with mode "tail". For inspecting output or diagnosing a problem; to wait for the command, use background_bash_wait.',
    parameters: ReadParams,

    async execute(_toolCallId, params: Static<typeof ReadParams>) {
      const session = registry.get(params.session_id);
      if (!session) return textResult(registry.unknownJobMessage(params.session_id));
      // Either mode leaves the agent having seen the output a report would carry:
      // the whole tail, or what is new on top of what it already saw.
      registry.markResultRead(session, originSession);
      const tail = params.mode === 'tail';
      const output = tail ? formatOutputSnapshot(session) : formatUnseenOutput(session);
      markOutputSeen(session);

      return textResult(
        [
          `Session ${session.id}: ${oneLineLabel(session.command, HEADER_COMMAND_MAX_CHARS)}`,
          registry.statusLine(session),
          tail ? 'Output:' : 'New output since you last saw it:',
          output,
        ].join('\n'),
      );
    },
  });

  pi.registerTool({
    name: 'background_bash_wait',
    label: 'Wait for Background Bash',
    description: `Wait for a background bash session without polling. Returns as soon as the command finishes, its new output matches \`until\`, the user sends a message, or the timeout passes (default and max ${END_TURN_AFTER}), with the status and only the output you have not seen yet.`,
    parameters: WaitParams,

    async execute(_toolCallId, params: Static<typeof WaitParams>, signal) {
      const session = registry.get(params.session_id);
      if (!session) return textResult(registry.unknownJobMessage(params.session_id));

      let pattern: RegExp | null = null;
      if (params.until) {
        try {
          pattern = new RegExp(params.until, 'm');
        } catch (error) {
          return textResult(`Invalid until pattern: ${errorMessage(error)}`);
        }
      }
      const timeoutMs = clamp(
        params.timeout_ms ?? BACKGROUND_WAIT_MAX_MS,
        1_000,
        BACKGROUND_WAIT_MAX_MS,
      );
      const until = pattern;
      const outcome = await registry.waitFor(session, {
        timeoutMs,
        session: originSession,
        ...(signal ? { signal } : {}),
        ...(until
          ? {
              until: () => until.test(session.output.textSince(session.outputSeen).text),
              checkMs: BACKGROUND_WAIT_CHECK_MS,
            }
          : {}),
      });

      // Only takes effect once the command has finished: the unseen output below
      // is then everything a report would add.
      registry.markResultRead(session, originSession);
      const unseen = formatUnseenOutput(session);
      markOutputSeen(session);
      return textResult(
        [
          `Session ${session.id}: ${describeWaitOutcome(outcome, timeoutMs)}`,
          registry.statusLine(session),
          'New output since you last saw it:',
          unseen,
        ].join('\n'),
      );
    },
  });

  pi.registerTool({
    name: 'background_bash_stop',
    label: 'Stop Background Bash',
    description:
      'Stop a running background bash session. Kills the whole process tree, not just the shell.',
    parameters: StopParams,

    async execute(_toolCallId, params: Static<typeof StopParams>) {
      const session = registry.get(params.session_id);
      if (!session) return textResult(registry.unknownJobMessage(params.session_id));

      if (session.status !== 'running') {
        return textResult(
          `Session ${session.id} is not running (${describeStatus(session)}). Nothing to stop.`,
        );
      }

      await registry.cancel([session]);
      return textResult(
        [`Stopped session ${session.id}.`, 'Output:', formatOutputSnapshot(session)].join('\n'),
      );
    },
  });

  pi.registerTool({
    name: 'background_bash_list',
    label: 'List Background Bash',
    description:
      'List background bash sessions started in this bot process, including status, runtime, and output size.',
    parameters: ListParams,

    async execute() {
      const all = registry.all();
      if (all.length === 0) return textResult('No background bash sessions.');

      return textResult(all.map((session) => formatSessionListEntry(session)).join('\n\n'));
    },
  });

  pi.registerTool({
    name: 'background_bash_stop_all',
    label: 'Stop All Background Bash',
    description: 'Stop all running background bash sessions.',
    parameters: StopAllParams,

    async execute() {
      const stopped = await registry.cancel(registry.all());
      return textResult(
        stopped === 0
          ? 'No running background bash sessions to stop.'
          : `Stopped ${stopped} background bash session${stopped === 1 ? '' : 's'}.`,
      );
    },
  });
}

/** Stops every background session regardless of chat. Called from main.ts on shutdown. */
export async function stopAllBackgroundSessions(): Promise<void> {
  await registry.cancelAll();
}

function startSession(
  command: string,
  cwd: string,
  maxRuntimeMs: number,
  origin: JobOrigin,
): BackgroundBashSession {
  const session: BackgroundBashSession = {
    id: registry.allocateId(),
    command,
    cwd,
    origin,
    startedAt: Date.now(),
    endedAt: null,
    output: new BoundedOutputBuffer('pi-background-bash'),
    outputSeen: 0,
    outputSeenAt: Date.now(),
    abort: new AbortController(),
    exitCode: null,
    status: 'running',
    statusDetail: null,
    backgrounded: false,
    resultRead: false,
    done: Promise.resolve(),
  };

  session.done = createLocalBashOperations()
    .exec(command, cwd, {
      onData: (data) => session.output.append(data),
      signal: session.abort.signal,
      timeout: Math.max(1, Math.ceil(maxRuntimeMs / 1000)),
    })
    // A session stopped through the registry is already terminal; leave it alone.
    .then(({ exitCode }) => {
      if (session.status !== 'running') return;
      session.exitCode = exitCode;
      session.status = 'exited';
    })
    .catch((error) => {
      if (session.status !== 'running') return;
      const message = errorMessage(error);
      if (message === 'aborted') {
        session.status = 'stopped';
      } else if (message.startsWith('timeout:')) {
        session.status = 'failed';
        session.statusDetail = `killed after exceeding the ${formatDuration(maxRuntimeMs)} max runtime`;
      } else {
        session.status = 'failed';
        session.statusDetail = message;
      }
    })
    .finally(() => {
      session.endedAt = Date.now();
      session.output.finish();
      void registry.settled(session);
    });

  registry.register(session);
  return session;
}

function describeWaitOutcome(outcome: WaitOutcome, timeoutMs: number): string {
  switch (outcome) {
    case 'settled':
      return 'finished.';
    case 'matched':
      return 'the new output matched `until`; the command is still running.';
    case 'timeout':
      return `still running after waiting ${formatDuration(timeoutMs)}. End your turn now, saying what you will do once it finishes; the [background-bash-report] resumes you then. Do not wait again unless the output shows it is about to finish.`;
    case 'interrupted':
      return 'the user sent a message, which follows this result; the command is still running. Answer the user, then wait again or end your turn.';
    case 'aborted':
      return 'the wait was aborted; the command is still running.';
  }
}

/**
 * The output the agent has not seen yet, keeping the end when it is long, since
 * that is where a build or test run puts its outcome. Any cut is announced first.
 */
function formatUnseenOutput(session: BackgroundBashSession): string {
  const { text: raw, missed } = session.output.textSince(session.outputSeen);
  const text = raw.trimEnd();
  const total = raw.length + missed;
  if (!text && missed === 0) {
    return `(no new output since you last looked, ${formatDuration(Date.now() - session.outputSeenAt)} ago)`;
  }
  if (!text) return unseenCutNotice(session, 0, total);

  const tail = tailChars(text, BACKGROUND_BASH_WAIT_OUTPUT_MAX_CHARS);
  if (tail.length === text.length && missed === 0) return tail;
  return `${unseenCutNotice(session, tail.length, total)}\n${tail}`;
}

function unseenCutNotice(session: BackgroundBashSession, shown: number, total: number): string {
  const fullOutput = session.output.snapshot().fullOutputPath;
  return `[Showing the last ${shown} of ${total} new chars. Use background_bash_read with mode "tail" for the buffered tail${fullOutput ? `, or read the full output at ${fullOutput}` : ''}.]`;
}

/** Records that the agent has now seen all output so far. */
function markOutputSeen(session: BackgroundBashSession): void {
  session.outputSeen = session.output.position;
  session.outputSeenAt = Date.now();
}

/** Width of the command in a read's one-line header; the full command is in the start result. */
const HEADER_COMMAND_MAX_CHARS = 80;

function describeCompletion(session: BackgroundBashSession): string {
  const runtime = formatDuration(registry.runtimeMs(session));
  if (session.status === 'exited') {
    return `Command completed in ${runtime}\nExit code: ${session.exitCode}`;
  }
  return `Command ${describeStatus(session)} after ${runtime}`;
}

function describeReportOutcome(session: BackgroundBashSession): string {
  const runtime = formatDuration(registry.runtimeMs(session));
  if (session.status === 'exited') {
    return `finished with exit code ${session.exitCode} in ${runtime}`;
  }
  return `${describeStatus(session)} after ${runtime}`;
}

/** Display widths in the progress message. */
const PROGRESS_COMMAND_MAX_CHARS = 80;
const PROGRESS_OUTPUT_MAX_CHARS = 120;

/**
 * The progress message of a backgrounded command, as Telegram HTML: status and
 * runtime, the command, and its latest line of output. Rendered for the final
 * state too, so the same message ends on the outcome.
 */
export function formatBackgroundBashProgress(
  session: Pick<
    BackgroundBashSession,
    'command' | 'status' | 'exitCode' | 'statusDetail' | 'startedAt' | 'endedAt'
  > & { output: Pick<BoundedOutputBuffer, 'lastLine'> },
): string {
  const icon =
    session.status === 'running'
      ? '⏳'
      : session.status === 'exited' && session.exitCode === 0
        ? '✅'
        : session.status === 'stopped'
          ? '⏹'
          : '❌';
  const runtime = formatDuration((session.endedAt ?? Date.now()) - session.startedAt);
  const lines = [
    `${icon} <b>Background bash</b> · ${escapeTelegramHtml(describeStatus(session))} · ${runtime}`,
    `<code>${escapeTelegramHtml(oneLineLabel(session.command, PROGRESS_COMMAND_MAX_CHARS))}</code>`,
  ];
  const lastLine = session.output.lastLine();
  if (lastLine) {
    lines.push(`<i>${escapeTelegramHtml(oneLineLabel(lastLine, PROGRESS_OUTPUT_MAX_CHARS))}</i>`);
  }
  return lines.join('\n');
}

function describeStatus(
  session: Pick<BackgroundBashSession, 'status' | 'exitCode' | 'statusDetail'>,
): string {
  switch (session.status) {
    case 'running':
      return 'running';
    case 'exited':
      return `exited with code ${session.exitCode}`;
    case 'stopped':
      return 'stopped';
    case 'failed':
      return `failed (${session.statusDetail ?? 'unknown error'})`;
  }
}

function formatSessionListEntry(session: BackgroundBashSession): string {
  const snapshot = session.output.snapshot();
  return [
    `${session.id} — ${describeStatus(session)}`,
    `  Command: ${session.command}`,
    `  Cwd: ${session.cwd}`,
    `  Runtime: ${formatDuration(registry.runtimeMs(session))}`,
    `  Output: ${snapshot.totalLines} lines, ${formatSize(snapshot.totalBytes)}`,
  ].join('\n');
}

function formatOutputSnapshot(session: BackgroundBashSession): string {
  const snapshot = session.output.snapshot();
  const text = snapshot.content.trimEnd() || '(no output)';
  if (!snapshot.truncated) return text;

  const shownLines = text.split('\n').length;
  const notice = `[Truncated: showing last ${shownLines} of ${snapshot.totalLines} lines (${formatSize(snapshot.totalBytes)} total)${snapshot.fullOutputPath ? `. Full output: ${snapshot.fullOutputPath}` : ''}]`;
  return `${text}\n\n${notice}`;
}

/** The prompt that delivers a completion report to the session that started the command. */
export function backgroundBashReportPrompt(report: BackgroundBashReport): IncomingPrompt {
  return jobReportPrompt(report.origin, {
    text: formatBackgroundBashReportPrompt(report),
    source: 'background-bash-report',
    label: oneLineLabel(report.command, REPORT_LABEL_MAX_CHARS),
    isSuperseded: () => registry.isReportSuperseded(report.sessionId),
  });
}

const REPORT_LABEL_MAX_CHARS = 80;

function formatBackgroundBashReportPrompt(report: BackgroundBashReport): string {
  return buildAgentEnvelope({
    preamble: `[background-bash-report] Background bash ${report.sessionId} ${report.outcome}.`,
    sections: [
      { intro: 'Command:', body: report.command },
      { intro: 'Working directory:', body: report.cwd },
      { intro: 'Output:', body: report.output, fallback: '(no output)' },
    ],
    guidance: [
      'This is an internal report from a background bash session you started earlier, not a message from the user.',
      'The user has not been notified separately. Review the result, continue any follow-up work yourself, and only send a user-visible message if it is useful.',
    ],
    noopSentinel: BACKGROUND_BASH_NOOP,
  });
}

/**
 * The output section of a completion report. Keeps the end of the output: a
 * failed build or test run puts its error last, so the tail is what tells the
 * agent what happened. Empty output is left to the envelope's fallback.
 *
 * The snapshot is already the buffer's bounded tail; the report clips it
 * further to its own budget. Any cut is announced up front, before the agent
 * reads a line that may start mid-way.
 */
export function formatReportOutput(snapshot: OutputSnapshot, sessionId: string): string {
  const content = snapshot.content.trimEnd();
  const output = extractResultFromJsonOutput(content) ?? content;
  if (!output) return '';

  const tail = tailChars(output, BACKGROUND_BASH_REPORT_OUTPUT_MAX_CHARS);
  const clipped = tail.length < output.length;
  if (!clipped && !snapshot.truncated) return output;

  const details: string[] = [];
  if (clipped) details.push(`showing the last ${tail.length} of ${output.length} chars`);
  if (snapshot.truncated) {
    details.push(`${snapshot.totalLines} lines, ${formatSize(snapshot.totalBytes)} in total`);
    if (snapshot.fullOutputPath) details.push(`full output: ${snapshot.fullOutputPath}`);
  }
  const notice = `[Truncated for report: ${details.join('; ')}. Use background_bash_read with session_id "${sessionId}" and mode "tail" for more.]`;
  return `${notice}\n${tail}`;
}

/**
 * The last maxChars of text. Starts on a whole line when one begins within the
 * first half of the window, so a partial first line is only kept for output
 * that is one enormous line. Never splits a surrogate pair.
 */
function tailChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  let start = text.length - maxChars;
  const newline = text.indexOf('\n', start);
  if (newline !== -1 && newline + 1 < text.length && newline - start < maxChars / 2) {
    start = newline + 1;
  }
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start++;
  return text.slice(start);
}

function extractResultFromJsonOutput(output: string): string | null {
  if (!output.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(output) as { result?: unknown };
    return typeof parsed.result === 'string' && parsed.result.trim() ? parsed.result.trim() : null;
  } catch {
    return null;
  }
}
