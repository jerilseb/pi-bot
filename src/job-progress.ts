import {
  JOB_PROGRESS_GLOBAL_MIN_GAP_MS,
  JOB_PROGRESS_MIN_EDIT_MS,
  JOB_PROGRESS_UPDATE_MS,
} from './config.ts';
import {
  editTelegramMessageHtml,
  type InlineKeyboardButton,
  sendTelegramHtmlMessage,
} from './telegram.ts';
import { errorMessage } from './util.ts';

/**
 * A live Telegram message for one job started from the chat, kept current by
 * the bot itself. The user sees how a long command or sub-agent job is going
 * without the agent polling it: no model call is involved, so a refresh costs
 * one Telegram edit and no context. Its Stop buttons are handled in
 * src/job-stop-action.ts.
 *
 * - Every Telegram call runs through one chain, so an edit can never overtake
 *   the send it depends on, and the final state is always the last written.
 * - refresh() coalesces: however many changes arrive, at most one write goes
 *   out per minIntervalMs, rendering the state as it is when the write runs. A
 *   heartbeat re-renders anyway, to move the clock.
 * - Routine writes also queue for a gate every live message shares, so many
 *   jobs at once cannot flood the chat. A message's first send, a tap's refresh
 *   and the final state are one-offs per job: they go out at once, but count
 *   toward the gate's spacing.
 * - A render identical to what the chat already shows is not sent.
 * - Best-effort throughout. A failed write is retried after a heartbeat rather
 *   than at the next change, and after a run of failures (the user may have
 *   deleted the message) updates stop. finish() still tries the final state
 *   once: a finished job left reading "running" would be wrong for good.
 *   Nothing here ever rejects into the job.
 */

export interface ProgressContent {
  html: string;
  /** The buttons under the message; an empty keyboard shows none. */
  keyboard: InlineKeyboardButton[][];
}

export interface ProgressTransport {
  /** Sends the message and returns its ID. */
  send(content: ProgressContent): Promise<number>;
  edit(messageId: number, content: ProgressContent): Promise<void>;
}

const telegramTransport: ProgressTransport = {
  // Silent: progress is ambient, and the job's report is what warrants a ping.
  send: ({ html, keyboard }) =>
    sendTelegramHtmlMessage(html, { silent: true, ...(keyboard.length > 0 ? { keyboard } : {}) }),
  // The keyboard always goes along, even empty, so an edit keeps exactly the
  // buttons rendered and removes the rest.
  edit: (messageId, { html, keyboard }) => editTelegramMessageHtml(messageId, html, keyboard),
};

/** Spaces the routine writes of every live message that shares it. */
export interface WriteGate {
  /** Resolves once a routine write may go out, and books that turn. */
  wait(): Promise<void>;
  /** Counts a write that went out without waiting, so the next routine one keeps its distance. */
  record(): void;
}

export function createWriteGate(minGapMs: number): WriteGate {
  let nextAt = 0;
  return {
    wait() {
      const now = Date.now();
      const at = Math.max(now, nextAt);
      nextAt = at + minGapMs;
      if (at <= now) return Promise.resolve();
      return new Promise((resolve) => {
        setTimeout(resolve, at - now).unref?.();
      });
    },
    record() {
      nextAt = Math.max(nextAt, Date.now() + minGapMs);
    },
  };
}

const sharedGate = createWriteGate(JOB_PROGRESS_GLOBAL_MIN_GAP_MS);

export interface ProgressMessageOptions {
  transport?: ProgressTransport;
  /** Shortest gap between two routine writes of this message. */
  minIntervalMs?: number;
  /** How often to re-render with no change reported; also the wait after a failed write. */
  heartbeatMs?: number;
  /** Overrides the gate every live message shares; for tests. */
  gate?: WriteGate;
}

export interface ProgressMessage {
  /** Re-render soon: once this message's minimum interval has passed and the shared gate allows. */
  refresh(): void;
  /** Re-render now, for a change the user just made. */
  refreshNow(): void;
  /** Stops refreshing and writes the final render. Idempotent; never rejects. */
  finish(): Promise<void>;
}

/** Consecutive failed writes after which a message stops updating. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Sends render() straight away, then keeps it current until finish(). */
export function startProgressMessage(
  render: () => ProgressContent,
  options: ProgressMessageOptions = {},
): ProgressMessage {
  const transport = options.transport ?? telegramTransport;
  const minIntervalMs = options.minIntervalMs ?? JOB_PROGRESS_MIN_EDIT_MS;
  const heartbeatMs = options.heartbeatMs ?? JOB_PROGRESS_UPDATE_MS;
  const gate = options.gate ?? sharedGate;
  let messageId: number | null = null;
  let shown: string | null = null;
  /** No routine write before this: the minimum interval, or the wait after a failure. */
  let notBefore = 0;
  let failures = 0;
  let abandoned = false;
  let finishing: Promise<void> | null = null;
  /** A routine write is on its way: waiting out the interval, or its turn at the gate. */
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const stopTimers = (): void => {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    timer = null;
    heartbeat = null;
  };

  const write = async (final: boolean): Promise<void> => {
    if (abandoned && !final) return;
    const content = render();
    const snapshot = JSON.stringify(content);
    if (snapshot === shown) return;
    try {
      if (messageId === null) messageId = await transport.send(content);
      else await transport.edit(messageId, content);
      shown = snapshot;
      failures = 0;
      notBefore = Date.now() + minIntervalMs;
    } catch (error) {
      failures++;
      notBefore = Date.now() + heartbeatMs;
      if (failures < MAX_CONSECUTIVE_FAILURES || abandoned) {
        console.error('failed to update job progress message:', errorMessage(error));
      } else {
        abandoned = true;
        stopTimers();
        console.error(
          `failed to update job progress message ${failures} times in a row; stopping:`,
          errorMessage(error),
        );
      }
    } finally {
      gate.record();
    }
  };

  const enqueueWrite = (final: boolean): Promise<void> => {
    chain = chain
      .then(() => write(final))
      .catch((error) => {
        console.error('failed to render job progress:', errorMessage(error));
      });
    return chain;
  };

  const refresh = (): void => {
    if (finishing || abandoned || scheduled) return;
    scheduled = true;
    timer = setTimeout(
      async () => {
        timer = null;
        // The first send is a one-off like the final state; only edits queue at the gate.
        if (messageId !== null) await gate.wait();
        scheduled = false;
        if (!finishing && !abandoned) void enqueueWrite(false);
      },
      Math.max(0, notBefore - Date.now()),
    );
    timer.unref?.();
  };

  heartbeat = setInterval(refresh, heartbeatMs);
  heartbeat.unref?.();
  refresh();

  return {
    refresh,
    refreshNow(): void {
      if (finishing || abandoned) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
        scheduled = false;
      }
      void enqueueWrite(false);
    },
    finish(): Promise<void> {
      if (!finishing) {
        stopTimers();
        finishing = enqueueWrite(true);
      }
      return finishing;
    },
  };
}

/** Callback-data prefix of the Stop buttons on live progress messages. */
export const JOB_STOP_CALLBACK_PREFIX = 'stop:';

/**
 * A Stop button's callback data: the job ID, plus the task number for one
 * sub-agent task. `stop:sub_1a2b3c:2` is far under Telegram's 64-byte limit.
 */
export function jobStopCallbackData(jobId: string, taskNumber?: number): string {
  return `${JOB_STOP_CALLBACK_PREFIX}${jobId}${taskNumber === undefined ? '' : `:${taskNumber}`}`;
}

/** What a Stop button's callback data names, once its prefix is removed. */
export function parseJobStopCallback(value: string): { jobId: string; taskNumber?: number } | null {
  const match = /^([a-z]+_[0-9a-f]+)(?::(\d+))?$/.exec(value);
  if (!match?.[1]) return null;
  return { jobId: match[1], ...(match[2] ? { taskNumber: Number(match[2]) } : {}) };
}

/** How a Stop tap went, answered at once; the job ends on its own afterwards. */
export type JobStopOutcome = 'stopping' | 'already-stopping' | 'not-running';
