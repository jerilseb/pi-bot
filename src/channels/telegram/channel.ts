import { MAX_QUEUED_PROMPTS, type ToolCallMode, toolCallMode } from '../../config.ts';
import type {
  AgentCore,
  Channel,
  ChannelCaps,
  ChannelRef,
  CoreEvent,
  Deliverable,
  Receipt,
  RichText,
  SubmitResult,
} from '../../contract.ts';
import { errorMessage } from '../../util.ts';
import { ingestTelegramMessage, type TelegramInput } from './inbound.ts';
import { pollTelegramUpdates } from './polling.ts';
import { sanitizeError, sendTelegramMessage, startTyping } from './telegram.ts';
import { escapeTelegramHtml } from './telegram-html.ts';
import { createToolNotifications, type ToolNotifications } from './tool-notification-batch.ts';
import { formatToolStartNotification } from './tool-notifications.ts';
import type { TelegramCallbackQuery, TelegramMessage } from './types.ts';

/**
 * Telegram as a channel of the agent core: the single allowed chat, reached by
 * long polling and the Bot API.
 *
 * Every send goes through one queue, in the order the core's events arrived,
 * since the core does not wait for any of them. A turn's tool notifications
 * batch on their own timer, but start only once the queue reaches the turn, and
 * the reply waits for them to finish: tool calls stay after the previous reply
 * and ahead of their own.
 *
 * Only chat turns are shown as they happen, with a typing indicator and tool
 * calls. A background run shows nothing until the background outbox releases
 * what it reported, which arrives here as a delivery.
 */

export const TELEGRAM_CHANNEL: ChannelRef = { id: 'telegram', kind: 'telegram' };

/** What a chat turn under way shows in Telegram. */
interface TurnView {
  typing: { stop(): void };
  tools: ToolNotifications;
}

export class TelegramChannel implements Channel {
  readonly ref = TELEGRAM_CHANNEL;
  readonly caps: ChannelCaps = {
    buttons: true,
    edits: true,
    files: true,
    voice: true,
    durable: true,
  };

  private readonly core: AgentCore;
  private readonly cwd: string;
  private readonly toolCallMode: () => ToolCallMode;
  private readonly turns = new Map<string, TurnView>();
  /** The tail of the send queue. Never rejects: each send logs its own failure. */
  private sending: Promise<void> = Promise.resolve();

  /** toolCallMode is read at the start of each turn; tests pass their own. */
  constructor(options: { core: AgentCore; cwd: string; toolCallMode?: () => ToolCallMode }) {
    this.core = options.core;
    this.cwd = options.cwd;
    this.toolCallMode = options.toolCallMode ?? toolCallMode;
  }

  onEvent(event: CoreEvent): void {
    switch (event.type) {
      case 'turn_start':
        if (event.session === 'chat') this.startTurn(event.turnId);
        return;
      case 'agent':
        if (event.turnId && event.event.type === 'tool_execution_start') {
          this.turns
            .get(event.turnId)
            ?.tools.notify(formatToolStartNotification(event.event, this.cwd));
        }
        return;
      case 'turn_end':
        if (event.session === 'chat') this.endTurn(event);
        return;
      case 'notice':
        void this.enqueue('notice', () => this.sendText(event.text, this.isPinged(event.ping)));
        return;
      default:
        // Input comes only from this channel so far, and state changes show nothing here.
        return;
    }
  }

  deliver(item: Deliverable): Promise<Receipt> {
    return this.enqueue('report', async (): Promise<Receipt> => {
      try {
        const body = toTelegramHtml(item.text);
        const text = item.origin.kind === 'cron' ? `⏰ <b>Scheduled report</b>\n\n${body}` : body;
        await sendTelegramMessage(text, { silent: !this.isPinged(item.ping) });
        return { channel: this.ref, ok: true };
      } catch (error) {
        return { channel: this.ref, ok: false, error: errorMessage(error) };
      }
    });
  }

  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // A send can queue another (a failed reply queues its error): wait until the queue holds still.
    let tail: Promise<void>;
    do {
      tail = this.sending;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await settlesWithin(tail, remaining))) {
        console.warn('Telegram sends still pending at shutdown');
        return;
      }
    } while (tail !== this.sending);
  }

  /** Long-polls for updates until the bot stops. Messages are ingested without blocking it. */
  poll(options: {
    isRunning: () => boolean;
    onCallbackQuery: (query: TelegramCallbackQuery) => Promise<void>;
  }): Promise<void> {
    return pollTelegramUpdates({
      isRunning: options.isRunning,
      onCallbackQuery: options.onCallbackQuery,
      onMessage: (message) => this.handleMessage(message),
    });
  }

  /** Submits a menu answer as the user's own message, so it can steer the turn under way. */
  async submitAnswer(text: string): Promise<void> {
    const result = await this.core.submit({ from: this.ref, text, attachments: [] });
    this.showSubmitResult(result);
  }

  /** Runs a slash command, or submits the message and shows what became of it. */
  async submitInput(input: TelegramInput): Promise<void> {
    const text = input.text.trim();
    if (input.attachments.length === 0 && text.startsWith('/')) {
      if (await this.core.command(text, this.ref)) return;
    }
    const result = await this.core.submit({
      from: this.ref,
      text: input.text,
      attachments: input.attachments,
    });
    this.showSubmitResult(result);
  }

  private handleMessage(message: TelegramMessage): void {
    // Media downloads and transcription can take minutes, so ingestion runs detached.
    void ingestTelegramMessage(message, (input) => this.submitInput(input));
  }

  private showSubmitResult(result: SubmitResult): void {
    if (result.status !== 'rejected') {
      // A failed acknowledgement must not retry or discard accepted work, so it is only logged.
      if (result.status === 'steered') {
        void this.enqueue('steering acknowledgement', () =>
          sendTelegramMessage('↪️ Steering current task.'),
        );
      }
      return;
    }
    switch (result.reason) {
      case 'queue-full':
        void this.enqueue('queue-full notice', () =>
          sendTelegramMessage(`⚠️ Queue full (${MAX_QUEUED_PROMPTS} pending). Wait or use /abort.`),
        );
        return;
      case 'error':
        void this.enqueue('error', () => sendTelegramMessage(`❌ ${sanitizeError(result.error)}`));
        return;
      case 'shutting-down':
        console.log('message ignored: the bot is shutting down');
        return;
    }
  }

  private startTurn(turnId: string): void {
    // Where the turn begins in the send queue: its tool calls wait for everything before it.
    const begun = this.enqueue('turn start', async () => {});
    this.turns.set(turnId, {
      typing: startTyping(),
      tools: createToolNotifications(this.toolCallMode(), { after: begun }),
    });
  }

  private endTurn(event: Extract<CoreEvent, { type: 'turn_end' }>): void {
    const turn = this.turns.get(event.turnId);
    this.turns.delete(event.turnId);
    const silent = !this.isPinged(event.ping);
    void this.enqueue('reply', async () => {
      try {
        // Flushed before the reply, so notifications cannot arrive after the answer they describe.
        await turn?.tools.finish();
        if (event.outcome === 'replied') {
          await this.sendReply(event.reply, silent);
        } else if (event.outcome === 'error') {
          await sendTelegramMessage(`❌ ${sanitizeError(event.error)}`, { silent });
        }
      } finally {
        turn?.typing.stop();
      }
    });
  }

  /** A reply that fails to send is replaced by the error, so the user knows one was lost. */
  private async sendReply(reply: RichText, silent: boolean): Promise<void> {
    try {
      await this.sendText(reply, silent);
    } catch (error) {
      console.error('failed to send reply:', errorMessage(error));
      await sendTelegramMessage(`❌ ${sanitizeError(errorMessage(error))}`, { silent });
    }
  }

  private sendText(text: RichText, silent: boolean): Promise<void> {
    return sendTelegramMessage(toTelegramHtml(text), { silent });
  }

  private isPinged(ping: ChannelRef[]): boolean {
    return ping.some((ref) => ref.id === this.ref.id);
  }

  /** Runs `task` after every send queued before it. The queue itself never rejects. */
  private enqueue<T>(label: string, task: () => Promise<T>): Promise<T> {
    const run = this.sending.then(task);
    this.sending = run.then(
      () => undefined,
      (error) => {
        console.error(`Telegram ${label} failed:`, errorMessage(error));
      },
    );
    return run;
  }
}

function toTelegramHtml(text: RichText): string {
  return text.format === 'plain' ? escapeTelegramHtml(text.text) : text.text;
}

async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
