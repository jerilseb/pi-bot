import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  createLocalBashOperations,
  type ExtensionAPI,
  formatSize,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { BoundedOutputBuffer } from './output-buffer.ts';
import { escapeTelegramHtml, sendTelegramMessage } from './telegram.ts';
import { textResult } from './tool-result.ts';
import { errorMessage } from './util.ts';

/**
 * Background bash sessions for the Pi agent: start long-running shell commands
 * without blocking the agent turn, then poll, list, and stop them later.
 *
 * The registry lives at module level in src/ (imported once by Node), so it is
 * shared across all chats and Pi sessions for the lifetime of the bot process.
 * File extensions under extensions/ get fresh module state per Pi session and
 * cannot own running child processes. Sessions do not survive bot restarts;
 * main.ts stops them all on shutdown.
 */

const DEFAULT_YIELD_TIME_MS = 4_000;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
const MAX_RUNTIME_CAP_MS = 24 * 60 * 60_000;
const MAX_RUNNING_SESSIONS = 12;
const COMPLETED_SESSION_TTL_MS = 30 * 60_000;
const STOP_WAIT_MS = 5_000;
const NOTIFICATION_OUTPUT_MAX_CHARS = 3_000;

type BackgroundBashStatus = 'running' | 'exited' | 'stopped' | 'failed';

interface BackgroundBashSession {
  id: string;
  chatId: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  output: BoundedOutputBuffer;
  abort: AbortController;
  exitCode: number | null;
  status: BackgroundBashStatus;
  statusDetail: string | null;
  /** True once start returned a session ID; gates the exit notification. */
  backgrounded: boolean;
  done: Promise<void>;
}

const sessions = new Map<string, BackgroundBashSession>();

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

const ListParams = Type.Object({
  all_chats: Type.Optional(
    Type.Boolean({
      description: 'List sessions started from all Telegram chats, not just this one.',
    }),
  ),
});

const StopAllParams = Type.Object({
  all_chats: Type.Optional(
    Type.Boolean({
      description: 'Stop sessions started from all Telegram chats, not just this one.',
    }),
  ),
});

export function backgroundBashExtension(chatId: string): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
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
        pruneSessions();

        const runningCount = [...sessions.values()].filter((s) => s.status === 'running').length;
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

        const session = startSession(chatId, params.command, cwd, maxRuntimeMs);
        await Promise.race([session.done, sleep(yieldTimeMs)]);

        if (session.status !== 'running') {
          sessions.delete(session.id);
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
            `Poll with background_bash_read using session_id "${session.id}"; a Telegram notification is sent when it finishes.`,
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
        pruneSessions();
        const session = sessions.get(params.session_id.trim());
        if (!session) return textResult(unknownSessionMessage(params.session_id));

        return textResult(
          [
            `Session ${session.id}`,
            `Command: ${session.command}`,
            describeStatusLine(session),
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
        pruneSessions();
        const session = sessions.get(params.session_id.trim());
        if (!session) return textResult(unknownSessionMessage(params.session_id));

        if (session.status !== 'running') {
          return textResult(
            `Session ${session.id} is not running (${describeStatus(session)}). Nothing to stop.`,
          );
        }

        await stopSessions([session]);
        return textResult(
          [
            session.status === 'running'
              ? `Session ${session.id} was signalled to stop but has not exited yet; check it again with background_bash_read.`
              : `Stopped session ${session.id}.`,
            'Output:',
            formatOutputSnapshot(session),
          ].join('\n'),
        );
      },
    });

    pi.registerTool({
      name: 'background_bash_list',
      label: 'List Background Bash',
      description:
        'List background bash sessions for this chat (or all chats with all_chats=true), including status, runtime, and output size.',
      parameters: ListParams,

      async execute(_toolCallId, params: Static<typeof ListParams>) {
        pruneSessions();
        const visible = [...sessions.values()].filter(
          (session) => params.all_chats || session.chatId === chatId,
        );
        if (visible.length === 0) {
          return textResult(
            params.all_chats
              ? 'No background bash sessions.'
              : 'No background bash sessions for this chat. Use all_chats=true to list every chat.',
          );
        }

        return textResult(visible.map((session) => formatSessionListEntry(session)).join('\n\n'));
      },
    });

    pi.registerTool({
      name: 'background_bash_stop_all',
      label: 'Stop All Background Bash',
      description:
        'Stop all running background bash sessions for this chat (or all chats with all_chats=true).',
      parameters: StopAllParams,

      async execute(_toolCallId, params: Static<typeof StopAllParams>) {
        pruneSessions();
        const targets = [...sessions.values()].filter(
          (session) => params.all_chats || session.chatId === chatId,
        );
        const stopped = await stopSessions(targets);
        return textResult(
          stopped === 0
            ? 'No running background bash sessions to stop.'
            : `Stopped ${stopped} background bash session${stopped === 1 ? '' : 's'}.`,
        );
      },
    });
  };
}

/** Stops every background session regardless of chat. Called from main.ts on shutdown. */
export async function stopAllBackgroundSessions(): Promise<void> {
  await stopSessions([...sessions.values()]);
}

function startSession(
  chatId: string,
  command: string,
  cwd: string,
  maxRuntimeMs: number,
): BackgroundBashSession {
  const session: BackgroundBashSession = {
    id: allocateSessionId(),
    chatId,
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
    .then(({ exitCode }) => {
      session.exitCode = exitCode;
      session.status = 'exited';
    })
    .catch((error) => {
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
      void notifySessionEnd(session);
    });

  sessions.set(session.id, session);
  return session;
}

async function stopSessions(targets: BackgroundBashSession[]): Promise<number> {
  const running = targets.filter((session) => session.status === 'running');
  for (const session of running) {
    session.abort.abort();
  }
  if (running.length > 0) {
    await Promise.race([
      Promise.allSettled(running.map((session) => session.done)),
      sleep(STOP_WAIT_MS),
    ]);
  }
  return running.length;
}

async function notifySessionEnd(session: BackgroundBashSession): Promise<void> {
  if (!session.backgrounded || session.status === 'stopped') return;

  const ok = session.status === 'exited' && session.exitCode === 0;
  const summary =
    session.status === 'exited'
      ? `finished with exit code ${session.exitCode}`
      : `failed: ${session.statusDetail ?? 'unknown error'}`;
  try {
    await sendTelegramMessage(
      session.chatId,
      [
        `${ok ? '✅' : '❌'} Background bash <code>${session.id}</code> ${escapeTelegramHtml(summary)}`,
        'Output:',
        `<pre><code>${escapeTelegramHtml(formatOutputNotificationPreview(session))}</code></pre>`,
      ].join('\n'),
    );
  } catch (error) {
    console.error(
      `[${session.chatId}] failed to send background bash notification:`,
      errorMessage(error),
    );
  }
}

function pruneSessions(): void {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (
      session.status !== 'running' &&
      session.endedAt !== null &&
      now - session.endedAt > COMPLETED_SESSION_TTL_MS
    ) {
      sessions.delete(session.id);
    }
  }
}

function allocateSessionId(): string {
  for (;;) {
    const id = `bg_${randomBytes(3).toString('hex')}`;
    if (!sessions.has(id)) return id;
  }
}

function unknownSessionMessage(sessionId: string): string {
  return `Unknown background session "${sessionId}". It may have been pruned (completed sessions are kept for ${formatDuration(COMPLETED_SESSION_TTL_MS)}) or the bot may have restarted. Use background_bash_list to see current sessions.`;
}

function describeCompletion(session: BackgroundBashSession): string {
  if (session.status === 'exited') {
    return `Command completed in ${formatDuration(runtimeMs(session))}\nExit code: ${session.exitCode}`;
  }
  return `Command ${describeStatus(session)} after ${formatDuration(runtimeMs(session))}`;
}

function describeStatusLine(session: BackgroundBashSession): string {
  return `Status: ${describeStatus(session)}, ${session.status === 'running' ? 'running for' : 'ran for'} ${formatDuration(runtimeMs(session))}`;
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
    `  Chat: ${session.chatId}`,
    `  Runtime: ${formatDuration(runtimeMs(session))}`,
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

function formatOutputNotificationPreview(session: BackgroundBashSession): string {
  const snapshot = session.output.snapshot();
  const output = extractResultFromJsonOutput(snapshot.content.trimEnd()) ?? formatOutputSnapshot(session);
  if (output.length <= NOTIFICATION_OUTPUT_MAX_CHARS) return output;

  const head = output.slice(0, NOTIFICATION_OUTPUT_MAX_CHARS);
  return `${head}\n[Truncated for notification: showing first ${head.length} chars. Use background_bash_read with session_id "${session.id}" for more.]`;
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

function runtimeMs(session: BackgroundBashSession): number {
  return (session.endedAt ?? Date.now()) - session.startedAt;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
