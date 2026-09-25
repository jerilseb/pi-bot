import {
  isAllowedTelegramChat,
  MAX_QUEUED_PROMPTS,
  showTranscriptsEnabled,
  subagentToolCallsEnabled,
  type ToolCallMode,
  toolCallMode,
} from '../../config.ts';
import type {
  AgentCore,
  Channel,
  ChannelCaps,
  ChannelRef,
  ChannelStatus,
  CommandInfo,
  CoreEvent,
  Deliverable,
  IngestionTicket,
  PromptOrigin,
  Receipt,
  RichText,
  SubmitResult,
} from '../../contract.ts';
import { errorMessage } from '../../util.ts';
import { type CallbackMenu, dispatchCallbackQuery } from './callback-menu.ts';
import { CHOICE_CALLBACK_PREFIX, choiceKeyboard, parseChoiceCallback } from './choices.ts';
import { TELEGRAM_COMMANDS } from './commands.ts';
import { ingestTelegramMessage, type TelegramInput } from './inbound.ts';
import type { ProgressMessageOptions } from './job-progress.ts';
import { jobStopCallbackAction } from './job-stop-action.ts';
import { TelegramJobProgress } from './jobs.ts';
import { markdownToTelegramHtml } from './markdown.ts';
import { sendTelegramDocument, sendTelegramImage, sendTelegramVoice } from './media.ts';
import { pollTelegramUpdates } from './polling.ts';
import { subagentToolCallCallbackMenu } from './subagent-tool-call-menu.ts';
import {
  answerTelegramCallbackQuery,
  editTelegramMessageHtml,
  registerBotCommands,
  sanitizeError,
  sendTelegramHtmlMessage,
  sendTelegramMessage,
  startTyping,
} from './telegram.ts';
import { escapeTelegramHtml } from './telegram-html.ts';
import { describeToolCallMode, toolCallCallbackMenu } from './tool-call-menu.ts';
import { createToolNotifications, type ToolNotifications } from './tool-notification-batch.ts';
import { formatToolStartNotification } from './tool-notifications.ts';
import { transcriptCallbackMenu } from './transcript-menu.ts';
import type { TelegramCallbackQuery, TelegramMessage } from './types.ts';

/**
 * Telegram as a channel of the agent core: the single allowed chat, reached by
 * long polling and the Bot API.
 *
 * Every send goes through one queue, in the order the core's events arrived,
 * since the core does not wait for any of them. A turn's tool notifications
 * batch on their own timer, but start only once the queue reaches the turn, and
 * the reply waits for them to finish: tool calls stay after the previous reply
 * and ahead of their own. A job's live progress message is edited on its own
 * schedule, but its last write joins the queue, so a job's report never lands
 * before the message shows how the job ended.
 *
 * Only chat turns are shown as they happen, with a typing indicator and tool
 * calls. A background run shows nothing until the background outbox releases
 * what it sent, which arrives here as deliveries.
 *
 * What someone types in another channel (a terminal) is mirrored here without
 * a notification, labelled with where it came from, and so is its turn: its
 * tool calls go out silently and its reply alerts only the channel it answers.
 * No typing indicator is shown for it, since nobody here is waiting.
 *
 * Menus from the core are inline keyboards whose taps go back to the core,
 * and every copy is edited once one is answered. Telegram's own display
 * settings are its own commands and menus.
 */

export const TELEGRAM_CHANNEL: ChannelRef = { id: 'telegram', kind: 'telegram' };

/** What a chat turn under way shows in Telegram. */
interface TurnView {
  typing: { stop(): void } | null;
  tools: ToolNotifications;
}

export interface TelegramChannelOptions {
  core: AgentCore;
  cwd: string;
  /** The `toolCalls` setting, read at the start of each turn; tests pass their own. */
  toolCallMode?: () => ToolCallMode;
  /** The `subagentToolCalls` setting, read at every render; tests pass their own. */
  subagentToolCalls?: () => boolean;
  /** The `showTranscripts` setting, for /status; tests pass their own. */
  showTranscripts?: () => boolean;
  /** Overrides the job progress transport, intervals and write gate; for tests. */
  progressOptions?: ProgressMessageOptions;
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
  readonly commands: readonly CommandInfo[] = TELEGRAM_COMMANDS.map(
    ({ handler: _handler, ...info }) => info,
  );

  private readonly core: AgentCore;
  private readonly cwd: string;
  private readonly toolCallMode: () => ToolCallMode;
  private readonly subagentToolCalls: () => boolean;
  private readonly showTranscripts: () => boolean;
  private readonly jobs: TelegramJobProgress;
  private readonly turns = new Map<string, TurnView>();
  /** The messages showing each open core menu, edited when it closes. */
  private readonly choiceCopies = new Map<string, number[]>();
  private readonly settingsMenus: CallbackMenu[] = [
    toolCallCallbackMenu,
    transcriptCallbackMenu,
    subagentToolCallCallbackMenu,
  ];
  /** The tail of the send queue. Never rejects: each send logs its own failure. */
  private sending: Promise<void> = Promise.resolve();

  constructor(options: TelegramChannelOptions) {
    this.core = options.core;
    this.cwd = options.cwd;
    this.toolCallMode = options.toolCallMode ?? toolCallMode;
    this.subagentToolCalls = options.subagentToolCalls ?? subagentToolCallsEnabled;
    this.showTranscripts = options.showTranscripts ?? showTranscriptsEnabled;
    this.jobs = new TelegramJobProgress({
      subagentToolCalls: this.subagentToolCalls,
      ...(options.progressOptions ? { progressOptions: options.progressOptions } : {}),
    });
  }

  status(): ChannelStatus {
    return {
      title: 'Telegram',
      settings: [
        { label: 'Sub-agent tool calls', on: this.subagentToolCalls() },
        { label: 'Voice transcripts', on: this.showTranscripts() },
        { label: '🛠 Tool calls', detail: describeToolCallMode(this.toolCallMode()) },
      ],
    };
  }

  onEvent(event: CoreEvent): void {
    switch (event.type) {
      case 'input':
        if (event.from.id !== this.ref.id) void this.enqueue('mirror', () => this.mirror(event));
        return;
      case 'turn_start':
        if (event.session === 'chat') this.startTurn(event.turnId, this.isMirrored(event.origin));
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
      case 'job': {
        const lastWrite = this.jobs.onJob(event);
        if (lastWrite) void this.enqueue('job progress', () => lastWrite);
        return;
      }
      case 'choice_closed':
        this.closeCopies(event.choiceId, event.text);
        return;
      default:
        // State, resets and the channel list change nothing shown here.
        return;
    }
  }

  deliver(item: Deliverable): Promise<Receipt> {
    return this.enqueue(`${item.kind} delivery`, async (): Promise<Receipt> => {
      try {
        await this.send(item);
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

  /** Registers the command menu: the core's commands and Telegram's own. */
  registerCommands(): Promise<void> {
    return registerBotCommands(
      this.core.commands(this.ref).map(({ name, description }) => ({ command: name, description })),
    );
  }

  /** Long-polls for updates until the bot stops. Messages are ingested without blocking it. */
  poll(options: { isRunning: () => boolean }): Promise<void> {
    return pollTelegramUpdates({
      isRunning: options.isRunning,
      onCallbackQuery: (query) => this.handleCallbackQuery(query),
      onMessage: (message) => this.handleMessage(message),
    });
  }

  /** Runs a slash command, or submits the message and shows what became of it. */
  async submitInput(input: TelegramInput & { ticket?: IngestionTicket }): Promise<void> {
    const text = input.text.trim();
    if (input.attachments.length === 0 && text.startsWith('/')) {
      const own = TELEGRAM_COMMANDS.find((command) => command.name === commandName(text));
      if (own) {
        void this.enqueue(`/${own.name}`, () => own.handler());
        return;
      }
      if (await this.core.command(text, this.ref)) return;
    }
    const result = await this.core.submit({
      from: this.ref,
      text: input.text,
      attachments: input.attachments,
      ...(input.ticket ? { ticket: input.ticket } : {}),
    });
    this.showSubmitResult(result);
  }

  /**
   * A tap on a button: a core menu's goes to the core, which closes every copy;
   * a Stop goes to the core as a job stop; Telegram's own settings menus are
   * handled here.
   */
  async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const data = query.data ?? '';
    if (data.startsWith(CHOICE_CALLBACK_PREFIX)) {
      await this.answerChoice(query, data.slice(CHOICE_CALLBACK_PREFIX.length));
      return;
    }
    await dispatchCallbackQuery(query, this.settingsMenus, [
      jobStopCallbackAction((jobId, task) => this.core.stopJob(jobId, task, this.ref)),
    ]);
  }

  private handleMessage(message: TelegramMessage): void {
    // Taken before a download starts, so a message cancelled meanwhile is turned away.
    const ticket = this.core.beginIngestion();
    void ingestTelegramMessage(message, async (input) =>
      this.submitInput({ ...input, ticket: await ticket }),
    );
  }

  private async answerChoice(query: TelegramCallbackQuery, value: string): Promise<void> {
    const message = query.message;
    const tap = parseChoiceCallback(value);
    if (!message || !isAllowedTelegramChat(String(message.chat.id)) || !tap) {
      await this.answerTap(query.id, 'This menu is no longer valid.');
      return;
    }
    // Tracked first, so the close the answer triggers edits this copy too.
    const copies = this.choiceCopies.get(tap.choiceId) ?? [];
    if (!copies.includes(message.message_id)) copies.push(message.message_id);
    this.choiceCopies.set(tap.choiceId, copies);

    const outcome = await this.core.choose(tap.choiceId, tap.option, this.ref);
    await this.answerTap(query.id, outcome.toast);
    if (!outcome.closed) {
      this.choiceCopies.delete(tap.choiceId);
      this.closeCopies(tap.choiceId, outcome.text, [message.message_id]);
    }
    if (outcome.submitted) this.showSubmitResult(outcome.submitted);
  }

  /** Replaces every copy of a menu with its closing text, which also drops its buttons. */
  private closeCopies(choiceId: string, text: RichText, copies?: number[]): void {
    const messages = copies ?? this.choiceCopies.get(choiceId) ?? [];
    this.choiceCopies.delete(choiceId);
    for (const messageId of messages) {
      void this.enqueue('menu close', () =>
        editTelegramMessageHtml(messageId, toTelegramHtml(text)),
      );
    }
  }

  private async answerTap(queryId: string, toast: string): Promise<void> {
    try {
      await answerTelegramCallbackQuery(queryId, toast);
    } catch (error) {
      console.error('failed to answer callback query:', errorMessage(error));
    }
  }

  private async send(item: Deliverable): Promise<void> {
    const silent = !this.isPinged(item.ping);
    switch (item.kind) {
      case 'report': {
        const body = toTelegramHtml(item.text);
        const text = item.origin.kind === 'cron' ? `⏰ <b>Scheduled report</b>\n\n${body}` : body;
        await sendTelegramMessage(text, { silent });
        return;
      }
      case 'image':
        await sendTelegramImage(item.path, { ...caption(item.caption), silent });
        return;
      case 'document':
        await sendTelegramDocument(item.path, { ...caption(item.caption), silent });
        return;
      case 'voice':
        // Speech is synthesized only when a channel plays it; without it, the text stands in.
        if (item.path) await sendTelegramVoice(item.path, { silent });
        else await sendTelegramMessage(`🔊 ${escapeTelegramHtml(item.text)}`, { silent });
        return;
      case 'choice': {
        const messageId = await sendTelegramHtmlMessage(toTelegramHtml(item.choice.text), {
          silent,
          keyboard: choiceKeyboard(item.choice),
        });
        const copies = this.choiceCopies.get(item.choice.id) ?? [];
        this.choiceCopies.set(item.choice.id, [...copies, messageId]);
        return;
      }
    }
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
      case 'stale':
        console.log('dropping message ingested before /abort or /new');
        return;
      case 'shutting-down':
        console.log('message ignored: the bot is shutting down');
        return;
    }
  }

  private startTurn(turnId: string, mirrored: boolean): void {
    // Where the turn begins in the send queue: its tool calls wait for everything before it.
    const begun = this.enqueue('turn start', async () => {});
    this.turns.set(turnId, {
      typing: mirrored ? null : startTyping(),
      tools: createToolNotifications(this.toolCallMode(), { after: begun, silent: mirrored }),
    });
  }

  /** Input typed in another channel, labelled with where, and sent without a notification. */
  private mirror(event: Extract<CoreEvent, { type: 'input' }>): Promise<void> {
    const where = event.from.kind === 'tui' ? '🖥 <i>From the terminal' : '<i>From elsewhere';
    const lines = [
      `${where}${event.steered ? ', steering the task under way' : ''}:</i>`,
      ...(event.text.trim() ? [escapeTelegramHtml(event.text)] : []),
      ...event.attachments.map((name) => `📎 ${escapeTelegramHtml(name)}`),
    ];
    return sendTelegramMessage(lines.join('\n'), { silent: true });
  }

  /** A turn that answers input from another channel. */
  private isMirrored(origin: PromptOrigin): boolean {
    return origin.kind === 'user' && origin.channel.id !== this.ref.id;
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
        turn?.typing?.stop();
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

export function toTelegramHtml(text: RichText): string {
  switch (text.format) {
    case 'plain':
      return escapeTelegramHtml(text.text);
    case 'markdown':
      return markdownToTelegramHtml(text.text);
    case 'telegram-html':
      return text.text;
  }
}

/** The command a line names, lowercased and without a `@botname` suffix or the slash. */
function commandName(line: string): string {
  const [first = ''] = line.split(/\s+/, 1);
  return first.toLowerCase().replace(/@.+$/, '').replace(/^\//, '');
}

function caption(text: string | undefined): { caption?: string } {
  return text ? { caption: text } : {};
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
