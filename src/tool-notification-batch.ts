import {
  TOOL_CALL_BATCH_MAX_ITEMS,
  TOOL_CALL_BATCH_MS,
  TOOL_CALL_COLLAPSED_MAX_CHARS,
  type ToolCallMode,
  toolCallMode,
} from './config.ts';
import {
  editTelegramMessageHtml,
  sendTelegramHtmlMessage,
  sendTelegramMessage,
} from './telegram.ts';
import { renderCollapsedToolCalls } from './tool-notifications.ts';
import type { IncomingPrompt } from './types.ts';
import { errorMessage, isBackgroundSource } from './util.ts';

export interface ToolNotifications {
  notify(notification: string): void;
  flush(): Promise<void>;
  finish(): Promise<void>;
}

/**
 * One notification lifecycle per prompt, not per chat: a user prompt can run
 * while the separate background session is still processing. Each instance
 * owns its mode, timer, delivery promise and collapsed message. Background
 * instances are silent and cannot reset or flush a foreground instance.
 *
 * The mode is snapshotted at creation, so /toolcalls applies to the next prompt.
 * A fixed timer (not a debounce) or a full batch triggers delivery. Collapsed
 * mode edits one silent expandable message; stream sends one per batch.
 */
export function createToolNotifications(
  source: IncomingPrompt['source'],
  mode: ToolCallMode = toolCallMode(),
): ToolNotifications {
  const enabled = !isBackgroundSource(source) && mode !== 'off';
  const notifications: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending: Promise<void> | null = null;
  let closed = false;
  const collapsed: { messageId: number | null; lines: string[]; hidden: number } = {
    messageId: null,
    lines: [],
    hidden: 0,
  };

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function notify(notification: string): void {
    if (!enabled || closed) return;
    notifications.push(notification);

    if (notifications.length >= TOOL_CALL_BATCH_MAX_ITEMS || TOOL_CALL_BATCH_MS <= 0) {
      void flush();
      return;
    }

    if (timer) return;
    timer = setTimeout(() => {
      void flush();
    }, TOOL_CALL_BATCH_MS);
  }

  /**
   * Only one delivery may be in flight. Every waiter rechecks both the queue
   * and the current promise after waking: another waiter may have started a
   * new delivery while this one was suspended. An empty queue alone does not
   * mean delivery is complete.
   */
  async function flush(): Promise<void> {
    clearTimer();
    while (sending || notifications.length > 0) {
      if (!sending) {
        clearTimer();
        const pending = notifications.splice(0);
        sending = deliver(pending)
          .catch((error) => {
            console.error('failed to send tool notifications:', errorMessage(error));
          })
          .finally(() => {
            sending = null;
          });
      }
      await sending;
    }
  }

  /** Close intake, cancel the timer, and await all queued/in-flight delivery. */
  async function finish(): Promise<void> {
    closed = true;
    await flush();
  }

  async function deliver(pending: string[]): Promise<void> {
    if (mode !== 'collapsed') {
      await sendTelegramMessage(pending.join('\n'));
      return;
    }

    appendCollapsedLines(pending);
    const html = renderCollapsedToolCalls(collapsed.lines, collapsed.hidden);
    if (collapsed.messageId === null) {
      collapsed.messageId = await sendTelegramHtmlMessage(html, { silent: true });
      return;
    }

    try {
      await editTelegramMessageHtml(collapsed.messageId, html);
    } catch (error) {
      // The message may have been deleted. Preserve the run's calls in a new one.
      console.error('failed to edit tool notifications; sending anew:', errorMessage(error));
      collapsed.messageId = await sendTelegramHtmlMessage(html, { silent: true });
    }
  }

  /** Grow the collapsed body up to its character budget; count the rest. */
  function appendCollapsedLines(pending: string[]): void {
    let size = collapsed.lines.reduce((total, line) => total + line.length + 1, 0);
    for (const line of pending) {
      if (collapsed.hidden > 0 || size + line.length + 1 > TOOL_CALL_COLLAPSED_MAX_CHARS) {
        collapsed.hidden++;
        continue;
      }
      collapsed.lines.push(line);
      size += line.length + 1;
    }
  }

  return { notify, flush, finish };
}
