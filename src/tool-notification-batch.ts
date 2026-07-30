import { TOOL_CALL_BATCH_MAX_ITEMS, TOOL_CALL_BATCH_MS } from './config.ts';
import { sendTelegramMessage } from './telegram.ts';
import type { IncomingPrompt } from './types.ts';
import { errorMessage, isBackgroundSource } from './util.ts';

/**
 * Batches tool-call notifications into single Telegram messages.
 *
 * Pi emits one event per tool call, which is far too chatty to forward
 * one-for-one: a turn that touches ten files would send ten messages and hit
 * Telegram's rate limits. Notifications accumulate here and flush when the batch
 * fills up, when TOOL_CALL_BATCH_MS elapses since the last one, or when the
 * prompt finishes.
 *
 * The batch is module-level state, which is correct because the bot serves one
 * Telegram chat: there is exactly one stream of notifications to coalesce.
 *
 * Formatting a single event into its notification string is a separate, pure
 * concern and lives in src/tool-notifications.ts.
 */

interface ToolNotificationBatch {
  notifications: string[];
  timer: ReturnType<typeof setTimeout> | null;
  sending: Promise<void> | null;
}

const batch: ToolNotificationBatch = { notifications: [], timer: null, sending: null };

/**
 * Queues one notification for delivery. Notifications from background sources
 * (heartbeat, cron) are dropped: nobody asked for that work, so narrating its
 * tool calls would be unprompted chatter.
 */
export function notifyToolCall(notification: string, source: IncomingPrompt['source']): void {
  if (isBackgroundSource(source)) return;

  batch.notifications.push(notification);

  if (batch.notifications.length >= TOOL_CALL_BATCH_MAX_ITEMS || TOOL_CALL_BATCH_MS <= 0) {
    void flushToolNotifications();
    return;
  }

  if (batch.timer) {
    clearTimeout(batch.timer);
  }
  batch.timer = setTimeout(() => {
    void flushToolNotifications();
  }, TOOL_CALL_BATCH_MS);
}

/**
 * Sends whatever is queued and resolves once it is delivered. Awaits any send
 * already in flight first, so batches cannot arrive out of order.
 */
export async function flushToolNotifications(): Promise<void> {
  if (batch.sending) await batch.sending;

  if (batch.timer) {
    clearTimeout(batch.timer);
    batch.timer = null;
  }

  const notifications = batch.notifications.splice(0);
  if (notifications.length === 0) return;

  batch.sending = sendTelegramMessage(notifications.join('\n'))
    .catch((error) => {
      console.error('failed to send tool notifications:', errorMessage(error));
    })
    .finally(() => {
      batch.sending = null;
    });

  await batch.sending;
}
