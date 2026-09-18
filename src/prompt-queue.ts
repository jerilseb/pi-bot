import type { ChatSession, ChatState } from './chat-session.ts';
import { handleCommand } from './commands.ts';
import { MAX_QUEUED_PROMPTS } from './config.ts';
import { cleanupAttachments } from './inbound.ts';
import { sendPiResponse } from './outbound.ts';
import { sanitizeError, sendTelegramMessage, startTyping } from './telegram.ts';
import { createToolNotifications } from './tool-notification-batch.ts';
import type { IncomingPrompt } from './types.ts';
import { errorMessage, isBackgroundSource } from './util.ts';

/**
 * The bot's single entry point for work, and the worker that drains it.
 *
 * Every prompt arrives here regardless of origin — a Telegram message, a
 * heartbeat or cron run, a post-restart task, a background-bash completion
 * report — so this is the one place that decides which session handles a prompt,
 * whether it is a slash command, and whether the queue has room for it.
 *
 * Runs are serial per session. Ordinary Telegram messages steer the active run;
 * startup/finishing races and background work use the FIFO queue. Steering uses
 * the existing run's subscription, never a second concurrent response collector.
 */

/** How long to wait before retrying a queue worker that crashed. */
const WORKER_RESTART_DELAY_MS = 1_000;

export interface PromptQueue {
  /** Routes a prompt to a session and queues it, or runs it as a slash command. */
  handleIncoming(prompt: IncomingPrompt): Promise<void>;
  /** True while either session is processing or has queued work. */
  isAssistantBusy(): boolean;
}

export function createPromptQueue(options: {
  chatSession: ChatSession;
  backgroundSession: ChatSession;
  restart: () => Promise<void>;
  isRunning: () => boolean;
}): PromptQueue {
  const { chatSession, backgroundSession, isRunning } = options;

  const handleIncoming = async (prompt: IncomingPrompt): Promise<void> => {
    const session = isBackgroundSource(prompt.source) ? backgroundSession : chatSession;
    const chat = session.get();
    const trimmed = prompt.text.trim();

    if (prompt.attachments.length === 0 && trimmed.startsWith('/')) {
      const handled = await handleCommand(
        {
          chat,
          session: chatSession,
          backgroundSession,
          restart: options.restart,
        },
        trimmed,
      );
      if (handled) return;
    }

    // A completion report is the tail of work the agent already started, so it is
    // delivered even when the queue is full.
    const bypassQueueLimit = prompt.source === 'background-bash-report';
    if (
      !bypassQueueLimit &&
      chat.queue.length + chat.pi.pendingSteeringCount >= MAX_QUEUED_PROMPTS
    ) {
      cleanupAttachments(prompt);
      if (!isBackgroundSource(prompt.source)) {
        await sendTelegramMessage(
          `⚠️ Queue full (${MAX_QUEUED_PROMPTS} pending). Wait or use /abort.`,
        );
      }
      return;
    }

    const isTelegram = !prompt.source || prompt.source === 'telegram';
    if (isTelegram && chat.processing && !trimmed.startsWith('/')) {
      let steered: boolean;
      try {
        steered = await chat.pi.trySteer(prompt);
      } catch (error) {
        cleanupAttachments(prompt);
        await sendTelegramMessage(`❌ ${sanitizeError(errorMessage(error))}`);
        return;
      }
      if (steered) {
        chat.messageCount++;
        // A failed acknowledgement must not retry or discard accepted work.
        await sendTelegramMessage('↪️ Steering current task.').catch((error) => {
          console.error('failed to acknowledge steering:', errorMessage(error));
        });
        return;
      }
    }

    chat.queue.push(prompt);
    chat.messageCount++;
    startQueueProcessing(chat);
  };

  /**
   * Starts the worker if it is not already draining. A crash here must not leave
   * queued prompts stranded, so the worker is restarted while work remains.
   */
  function startQueueProcessing(chat: ChatState): void {
    void processQueue(chat).catch((error) => {
      console.error('queue worker failed unexpectedly:', errorMessage(error));
      chat.processing = false;

      if (isRunning() && chat.queue.length > 0) {
        setTimeout(() => startQueueProcessing(chat), WORKER_RESTART_DELAY_MS);
      }
    });
  }

  async function processQueue(chat: ChatState): Promise<void> {
    if (chat.processing) return;

    while (chat.queue.length > 0 && isRunning()) {
      const prompt = chat.queue.shift();
      if (!prompt) break;
      chat.processing = true;

      // Background runs have no user watching, so no typing indicator.
      const typing = isBackgroundSource(prompt.source) ? { stop: () => undefined } : startTyping();
      // Own state per prompt: background and foreground sessions can overlap.
      const toolNotifications = createToolNotifications(prompt.source);
      let deferredSteers = 0;
      try {
        const logLabel = prompt.source && prompt.source !== 'telegram' ? prompt.source : 'prompt';
        console.log(`${logLabel}: ${prompt.text.slice(0, 120)}`);
        if (prompt.model) await chat.pi.useModel(prompt.model);
        const response = await chat.pi.runPrompt(prompt.text, prompt.attachments, {
          onToolCall: toolNotifications.notify,
          onSteeringSettled: (steered, disposition) => {
            if (disposition === 'deferred') {
              // Requeue immediately so /abort during response delivery can still
              // discard these. They precede messages queued during shutdown.
              chat.queue.splice(deferredSteers++, 0, steered);
            } else cleanupAttachments(steered);
          },
        });
        // Flush before the response so notifications cannot arrive after the
        // answer they describe.
        await toolNotifications.finish();
        await sendPiResponse(response, {
          suppressNoop: prompt.suppressNoop,
          source: prompt.source,
        });
        enqueuePendingNewSessionTask(chat, prompt);
      } catch (error) {
        const message = errorMessage(error);
        console.error('error:', message);
        await toolNotifications.finish();
        try {
          await sendTelegramMessage(`❌ ${sanitizeError(message)}`);
        } catch (notificationError) {
          console.error(
            'failed to send prompt error notification:',
            errorMessage(notificationError),
          );
        }
      } finally {
        cleanupAttachments(prompt);
        typing.stop();
        chat.processing = false;
      }
    }
  }

  return {
    handleIncoming,

    isAssistantBusy(): boolean {
      return chatSession.isBusy() || backgroundSession.isBusy();
    },
  };
}

/**
 * A session swap requested mid-turn (start_new_session with a follow-up task)
 * runs next, ahead of anything queued behind it.
 */
function enqueuePendingNewSessionTask(chat: ChatState, prompt: IncomingPrompt): void {
  const task = chat.pi.consumePendingNewSessionTask();
  if (!task) return;

  chat.queue.unshift({
    text: task,
    attachments: [],
    ...(prompt.source ? { source: prompt.source } : {}),
  });
  chat.messageCount++;
}
