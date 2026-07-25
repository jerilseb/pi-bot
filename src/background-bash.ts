import * as path from 'node:path';
import {
  createLocalBashOperations,
  type ExtensionAPI,
  formatSize,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { BACKGROUND_BASH_NOOP } from './config.ts';
import { type Job, JobRegistry } from './job-registry.ts';
import { BoundedOutputBuffer } from './output-buffer.ts';
import { textResult } from './tool-result.ts';
import { clamp, errorMessage, formatDuration, sleep } from './util.ts';

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
 * Lifecycle bookkeeping (IDs, pruning, stopping, report delivery) lives in
 * src/job-registry.ts, shared with sub-agents.
 */

const DEFAULT_YIELD_TIME_MS = 4_000;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
const MAX_RUNTIME_CAP_MS = 24 * 60 * 60_000;
const MAX_RUNNING_SESSIONS = 12;
const COMPLETED_SESSION_TTL_MS = 30 * 60_000;
const STOP_WAIT_MS = 5_000;
const REPORT_OUTPUT_MAX_CHARS = 3_000;

type BackgroundBashTerminalStatus = 'exited' | 'stopped' | 'failed';

interface BackgroundBashSession extends Job<BackgroundBashTerminalStatus> {
  command: string;
  cwd: string;
  output: BoundedOutputBuffer;
  abort: AbortController;
  exitCode: number | null;
}

export interface BackgroundBashReport {
  sessionId: string;
  command: string;
  cwd: string;
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
  completedTtlMs: COMPLETED_SESSION_TTL_MS,
  cancelWaitMs: STOP_WAIT_MS,
  cancelledStatus: 'stopped',
  signalCancel: (session) => session.abort.abort(),
  describeStatus,
  buildReport: (session) => ({
    sessionId: session.id,
    command: session.command,
    cwd: session.cwd,
    outcome: describeReportOutcome(session),
    output: formatOutputReportPreview(session),
  }),
});

/** Wires completion reports into the bot's incoming-prompt pipeline. Called from main.ts. */
export function setBackgroundBashReportHandler(
  handler: (report: BackgroundBashReport) => Promise<void>,
): void {
  registry.setReportHandler(handler);
}

const StartParams = Type.Object({
  command: Type.String({ description: 'Bash command to run in the background.', minLength: 1 }),
  cwd: Type.Optional(
    Type.String({
      description: 'Working directory. Relative paths resolve against the bot cwd.',
    }),
  ),
  yield_time_ms: Type.Optional(
    Type.Number({
      description: `How long to wait for the command before backgrounding it (default ${DEFAULT_YIELD_TIME_MS}ms, max ${MAX_YIELD_TIME_MS}ms).`,
    }),
  ),
  max_runtime_ms: Type.Optional(
    Type.Number({
      description: `Kill the command after this long (default ${DEFAULT_MAX_RUNTIME_MS}ms).`,
    }),
  ),
});

const ReadParams = Type.Object({
  session_id: Type.String({
    description: 'Background session ID returned by background_bash_start.',
  }),
});

const StopParams = Type.Object({
  session_id: Type.String({
    description: 'Background session ID returned by background_bash_start.',
  }),
});

const ListParams = Type.Object({});

const StopAllParams = Type.Object({});

export function backgroundBashExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'background_bash_start',
    label: 'Background Bash',
    description:
      'Run a bash command in the background. Waits briefly; if the command finishes in time the full result is returned, otherwise it keeps running and a session ID is returned for polling with background_bash_read. Use for long-running commands: dev servers, watchers, long builds, tail -f. Use the normal bash tool for short commands.',
    promptSnippet:
      'Run long-lived shell commands (dev servers, watchers, long builds) with background_bash_start instead of blocking bash.',
    promptGuidelines: [
      'Use the normal bash tool for short commands that complete quickly; use background_bash_start for dev servers, file watchers, long builds, tail -f, or when the user asks to run something in the background.',
      'After starting a background command, keep the session ID and poll it with background_bash_read when you need progress or final output.',
      'Background commands have no stdin: anything that might prompt must use non-interactive flags (--yes, CI=true, DEBIAN_FRONTEND=noninteractive) or it will fail fast on stdin EOF.',
      'Stop background sessions with background_bash_stop when they are no longer needed.',
    ],
    parameters: StartParams,

    async execute(_toolCallId, params: Static<typeof StartParams>) {
      const runningCount = registry.runningCount();
      if (runningCount >= MAX_RUNNING_SESSIONS) {
        return textResult(
          `Too many background sessions running (${runningCount}/${MAX_RUNNING_SESSIONS}). Stop some with background_bash_stop or background_bash_stop_all first.`,
        );
      }

      const cwd = path.resolve(process.cwd(), params.cwd ?? '.');
      const maxRuntimeMs = clamp(
        params.max_runtime_ms ?? DEFAULT_MAX_RUNTIME_MS,
        1_000,
        MAX_RUNTIME_CAP_MS,
      );
      const yieldTimeMs = clamp(
        params.yield_time_ms ?? DEFAULT_YIELD_TIME_MS,
        0,
        MAX_YIELD_TIME_MS,
      );

      const session = startSession(params.command, cwd, maxRuntimeMs);
      await Promise.race([session.done, sleep(yieldTimeMs)]);

      if (session.status !== 'running') {
        registry.remove(session.id);
        return textResult(
          [describeCompletion(session), 'Output:', formatOutputSnapshot(session)].join('\n'),
        );
      }

      session.backgrounded = true;
      return textResult(
        [
          `Started background bash session ${session.id}`,
          `Command: ${session.command}`,
          `Cwd: ${session.cwd}`,
          `Status: running (max runtime ${formatDuration(maxRuntimeMs)})`,
          `Poll with background_bash_read using session_id "${session.id}"; an internal [background-bash-report] message with the result is delivered to the chat agent when it finishes.`,
          'Output so far:',
          formatOutputSnapshot(session),
        ].join('\n'),
      );
    },
  });

  pi.registerTool({
    name: 'background_bash_read',
    label: 'Read Background Bash',
    description:
      'Read the buffered output and status of a background bash session started with background_bash_start.',
    parameters: ReadParams,

    async execute(_toolCallId, params: Static<typeof ReadParams>) {
      const session = registry.get(params.session_id);
      if (!session) return textResult(registry.unknownJobMessage(params.session_id));

      return textResult(
        [
          `Session ${session.id}`,
          `Command: ${session.command}`,
          registry.statusLine(session),
          'Output:',
          formatOutputSnapshot(session),
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

function startSession(command: string, cwd: string, maxRuntimeMs: number): BackgroundBashSession {
  const session: BackgroundBashSession = {
    id: registry.allocateId(),
    command,
    cwd,
    startedAt: Date.now(),
    endedAt: null,
    output: new BoundedOutputBuffer('pi-background-bash'),
    abort: new AbortController(),
    exitCode: null,
    status: 'running',
    statusDetail: null,
    backgrounded: false,
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
      void registry.reportEnd(session);
    });

  registry.register(session);
  return session;
}

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

function describeStatus(session: BackgroundBashSession): string {
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

export function formatBackgroundBashReportPrompt(report: BackgroundBashReport): string {
  return [
    `[background-bash-report] Background bash ${report.sessionId} ${report.outcome}.`,
    '',
    'Command:',
    report.command,
    '',
    'Working directory:',
    report.cwd,
    '',
    'Output:',
    report.output || '(no output)',
    '',
    'This is an internal report from a background bash session you started earlier, not a message from the user.',
    'The user has not been notified separately. Review the result, continue any follow-up work yourself, and only send a user-visible message if it is useful.',
    `If no user-visible update is needed, reply exactly ${BACKGROUND_BASH_NOOP}.`,
  ].join('\n');
}

function formatOutputReportPreview(session: BackgroundBashSession): string {
  const snapshot = session.output.snapshot();
  const output =
    extractResultFromJsonOutput(snapshot.content.trimEnd()) ?? formatOutputSnapshot(session);
  if (output.length <= REPORT_OUTPUT_MAX_CHARS) return output;

  const head = output.slice(0, REPORT_OUTPUT_MAX_CHARS);
  return `${head}\n[Truncated for report: showing first ${head.length} chars. Use background_bash_read with session_id "${session.id}" for more.]`;
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
