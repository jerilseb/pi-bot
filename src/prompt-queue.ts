import * as path from 'node:path';
import { cleanupAttachments } from './attachments.ts';
import { backgroundOutbox, deliverToChat } from './background-outbox.ts';
import type { ChatSession, ChatState } from './chat-session.ts';
import {
  HEARTBEAT_SESSIONS_DIR,
  MAX_QUEUED_PROMPTS,
  SCHEDULED_TASKS_SESSIONS_DIR,
} from './config.ts';
import type {
  ChannelRef,
  CoreEvent,
  Deliverable,
  PromptOrigin,
  Receipt,
  SubmitResult,
  TurnOutcome,
} from './contract.ts';
import { isSilentResponse } from './outbound.ts';
import type { RunTranscript } from './pi-session.ts';
import { backgroundReportNote } from './session-notes.ts';
import type { IncomingPrompt, PiPromptResult, SessionKind } from './types.ts';
import {
  errorMessage,
  isBackgroundPrompt,
  isJobReportPrompt,
  originLabel,
  summarizeError,
} from './util.ts';

/**
 * The queue behind every prompt, and the worker that drains it.
 *
 * Every prompt arrives here regardless of origin — user input from a channel,
 * a heartbeat or cron run, a post-restart task, a background-bash or sub-agent
 * completion report — so this is the one place that decides which session
 * handles a prompt and whether the queue has room for it. Slash commands never
 * get here: the core runs them before a message is submitted.
 *
 * Runs are serial per session. User input steers the active chat run;
 * startup/finishing races and background work use the FIFO queue. Steering uses
 * the existing run's subscription, never a second concurrent response collector.
 *
 * Nothing here talks to an interface. A turn is a series of events — its start,
 * every SDK event, its end with the reply or error — and each channel sends
 * what it shows in that order. What a background run reports is a delivery,
 * released by the background outbox once the chat has been idle.
 */

/** How long to wait before retrying a queue worker that crashed. */
const WORKER_RESTART_DELAY_MS = 1_000;

/** What the queue needs from the core: where its events and deliveries go. */
export interface QueueSink {
  emit(event: CoreEvent): void;
  /** Sends a delivery to every attached channel and returns their receipts. */
  deliver(item: Deliverable): Promise<Receipt[]>;
  /** Which channels an event about a prompt from `origin` should alert. */
  pingFor(origin: PromptOrigin): ChannelRef[];
  /** Emits the current state after something that may have changed it. */
  emitState(): void;
}

export interface PromptQueue {
  /** Routes a prompt to its session and queues it, or steers it into the chat run under way. */
  handleIncoming(prompt: IncomingPrompt): Promise<SubmitResult>;
  /** True while either session is processing or has queued work. */
  isAssistantBusy(): boolean;
}

export function createPromptQueue(options: {
  chatSession: ChatSession;
  backgroundSession: ChatSession;
  isRunning: () => boolean;
  sink: QueueSink;
}): PromptQueue {
  const { chatSession, backgroundSession, isRunning, sink } = options;
  let turnCounter = 0;
  // The turn each session is running, so its SDK events can say which turn they belong to.
  const activeTurn: Record<SessionKind, string | null> = { chat: null, background: null };
  for (const [kind, session] of [
    ['chat', chatSession],
    ['background', backgroundSession],
  ] as const) {
    session.onAgentEvent((event) =>
      sink.emit({ type: 'agent', turnId: activeTurn[kind], session: kind, event }),
    );
  }

  const handleIncoming = async (prompt: IncomingPrompt): Promise<SubmitResult> => {
    const kind: SessionKind = isBackgroundPrompt(prompt) ? 'background' : 'chat';
    const chat = (kind === 'background' ? backgroundSession : chatSession).get();
    if (!isRunning()) {
      cleanupAttachments(prompt);
      return { status: 'rejected', reason: 'shutting-down' };
    }
    // Anything headed for the chat restarts the cooldown held background messages wait out.
    if (kind === 'chat') backgroundOutbox()?.noteChatActivity();

    // A completion report is the tail of work the agent already started, so it is
    // delivered even when the queue is full.
    const bypassQueueLimit = isJobReportPrompt(prompt);
    if (
      !bypassQueueLimit &&
      chat.queue.length + chat.pi.pendingSteeringCount >= MAX_QUEUED_PROMPTS
    ) {
      cleanupAttachments(prompt);
      if (prompt.origin.kind !== 'user') {
        console.warn(`${originLabel(prompt.origin)} dropped: the ${kind} queue is full`);
      }
      return { status: 'rejected', reason: 'queue-full' };
    }

    // An unknown slash command is queued as text rather than steered into a turn.
    if (prompt.origin.kind === 'user' && chat.processing && !prompt.text.trim().startsWith('/')) {
      let steered: boolean;
      try {
        steered = await chat.pi.trySteer(prompt);
      } catch (error) {
        cleanupAttachments(prompt);
        return { status: 'rejected', reason: 'error', error: errorMessage(error) };
      }
      if (steered) {
        chat.messageCount++;
        emitInput(prompt, true);
        sink.emitState();
        return { status: 'steered' };
      }
    }

    chat.queue.push(prompt);
    chat.messageCount++;
    emitInput(prompt, false);
    startQueueProcessing(chat, kind);
    sink.emitState();
    return { status: 'queued' };
  };

  function emitInput(prompt: IncomingPrompt, steered: boolean): void {
    if (prompt.origin.kind !== 'user') return;
    sink.emit({
      type: 'input',
      from: prompt.origin.channel,
      text: prompt.text,
      attachments: prompt.attachments.map(
        (attachment) => attachment.filename ?? path.basename(attachment.path),
      ),
      steered,
    });
  }

  /**
   * Starts the worker if it is not already draining. A crash here must not leave
   * queued prompts stranded, so the worker is restarted while work remains.
   */
  function startQueueProcessing(chat: ChatState, kind: SessionKind): void {
    void processQueue(chat, kind).catch((error) => {
      console.error('queue worker failed unexpectedly:', errorMessage(error));
      chat.processing = false;

      if (isRunning() && chat.queue.length > 0) {
        setTimeout(() => startQueueProcessing(chat, kind), WORKER_RESTART_DELAY_MS);
      }
    });
  }

  async function processQueue(chat: ChatState, kind: SessionKind): Promise<void> {
    if (chat.processing) return;

    while (chat.queue.length > 0 && isRunning()) {
      const prompt = chat.queue.shift();
      if (!prompt) break;
      if (prompt.isSuperseded?.()) {
        console.log(
          `${originLabel(prompt.origin)} skipped, already handled: ${prompt.label ?? ''}`,
        );
        cleanupAttachments(prompt);
        continue;
      }
      chat.processing = true;

      const isBackground = kind === 'background';
      if (!isBackground) backgroundOutbox()?.noteChatActivity();
      const turnId = `${kind}-${++turnCounter}`;
      activeTurn[kind] = turnId;
      sink.emit({ type: 'turn_start', turnId, session: kind, origin: prompt.origin });
      sink.emitState();
      let ended = false;
      const endTurn = (outcome: TurnOutcome): void => {
        ended = true;
        if (activeTurn[kind] === turnId) activeTurn[kind] = null;
        sink.emit({
          type: 'turn_end',
          turnId,
          session: kind,
          ping: sink.pingFor(prompt.origin),
          ...outcome,
        });
      };
      let deferredSteers = 0;
      try {
        console.log(`${originLabel(prompt.origin)}: ${prompt.text.slice(0, 120)}`);
        if (prompt.model) await chat.pi.useModel(prompt.model);
        const response = await chat.pi.runPrompt(prompt.text, prompt.attachments, {
          ...(prompt.resumeSessionFile ? { resumeSessionFile: prompt.resumeSessionFile } : {}),
          ...(isBackground ? { transcript: backgroundRunTranscript(prompt) } : {}),
          ...(!isBackground
            ? {
                recoverTransportErrors: true,
                onAutoRecovery: () =>
                  sink.emit({
                    type: 'notice',
                    text: {
                      format: 'plain',
                      text: '🔄 Temporary model error. Continuing automatically...',
                    },
                    level: 'warn',
                    to: 'all',
                    ping: sink.pingFor(prompt.origin),
                  }),
              }
            : {}),
          onSteeringSettled: (steered, disposition) => {
            if (disposition === 'deferred') {
              // Requeue immediately so /abort during response delivery can still
              // discard these. They precede messages queued during shutdown.
              chat.queue.splice(deferredSteers++, 0, steered);
            } else cleanupAttachments(steered);
          },
        });
        const silent = isSilentResponse(response, prompt);
        if (silent) console.log(`${kind} turn completed with no user-visible update`);
        endTurn(
          silent
            ? { outcome: 'silent' }
            : {
                outcome: 'replied',
                // Only a reply that must be sent gets here blank: an unattended run's is silent.
                reply: { format: 'telegram-html', text: response.text || '(no response)' },
              },
        );
        if (isBackground && !silent) {
          // Held until the chat has been idle for the cooldown. The note goes
          // with the message, so the chat agent learns of it only once the
          // user has actually been sent it.
          await deliverToChat('background', originLabel(prompt.origin), () =>
            deliverBackgroundResponse(prompt, response),
          );
        }
        enqueuePendingNewSessionTask(chat, prompt);
      } catch (error) {
        const message = errorMessage(error);
        console.error('error:', message);
        // A chat turn's channels show the error with the turn; a background
        // run has no one watching, so its error waits in the outbox like a report.
        if (!ended) endTurn({ outcome: 'error', error: message });
        if (isBackground) {
          try {
            await deliverToChat('background', 'error', async () =>
              sink.emit({
                type: 'notice',
                text: { format: 'plain', text: `❌ ${summarizeError(message)}` },
                level: 'error',
                to: 'all',
                ping: sink.pingFor(prompt.origin),
              }),
            );
          } catch (notificationError) {
            console.error(
              'failed to send prompt error notification:',
              errorMessage(notificationError),
            );
          }
        }
      } finally {
        cleanupAttachments(prompt);
        if (activeTurn[kind] === turnId) activeTurn[kind] = null;
        chat.processing = false;
        // The cooldown counts from the end of the chat's last turn.
        if (!isBackground) backgroundOutbox()?.noteChatActivity();
        sink.emitState();
      }
    }
  }

  /**
   * Delivers a background run's report and, when a channel took it, writes the
   * note that tells the chat session about it. A background run sends its
   * message without the chat agent ever seeing it, so the next chat turn would
   * otherwise not know what the user was just sent. Throws when every channel
   * failed, as a failed send always has. Skipped during shutdown so a late
   * report cannot land after the restart note that marks a clean exit.
   */
  async function deliverBackgroundResponse(
    prompt: IncomingPrompt,
    response: PiPromptResult,
  ): Promise<void> {
    const receipts = await sink.deliver({
      kind: 'report',
      text: { format: 'telegram-html', text: response.text || '(no response)' },
      origin: prompt.origin,
      ...(prompt.label ? { label: prompt.label } : {}),
      ping: sink.pingFor(prompt.origin),
    });
    if (!receipts.some((receipt) => receipt.ok)) {
      const failures = receipts.filter((receipt) => !receipt.ok && !receipt.skipped);
      if (failures.length > 0) {
        throw new Error(failures.map((receipt) => receipt.error ?? 'delivery failed').join('; '));
      }
      console.warn(`background ${originLabel(prompt.origin)} reached no channel`);
      return;
    }
    if (!isRunning()) return;
    const note = backgroundReportNote({
      origin: prompt.origin,
      ...(prompt.label ? { label: prompt.label } : {}),
      ...(prompt.model ? { model: prompt.model } : {}),
      report: response.text,
    });
    if (note) await chatSession.get().pi.noteEvent(note.kind, note.text);
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
    origin: prompt.origin,
    ...(prompt.session ? { session: prompt.session } : {}),
  });
  chat.messageCount++;
}

/**
 * Where a background run's fresh transcript goes: heartbeat runs and scheduled
 * tasks each keep their own directory and ID prefix. A job report resumes the
 * file of the run that started the job, so this only applies to one whose file
 * is gone; such strays go with the scheduled tasks.
 */
function backgroundRunTranscript(prompt: IncomingPrompt): RunTranscript {
  if (prompt.origin.kind === 'heartbeat') {
    return { dir: HEARTBEAT_SESSIONS_DIR, prefix: 'telegram-heartbeat', name: 'heartbeat' };
  }
  return {
    dir: SCHEDULED_TASKS_SESSIONS_DIR,
    prefix: 'telegram-scheduled-task',
    name: prompt.label ?? 'scheduled task',
  };
}
