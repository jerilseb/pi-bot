import { cleanupAttachments } from './attachments.ts';
import { backgroundOutbox, deliverToChat } from './background-outbox.ts';
import { stopBackgroundBashByUser } from './background-bash.ts';
import type { ChatSession } from './chat-session.ts';
import { ChoiceRegistry, type ChoiceSpec } from './choices.ts';
import {
  type CommandContext,
  coreCommands,
  defineCommandChoices,
  handleCommand,
} from './commands.ts';
import { ACTIVE_WINDOW_MS } from './config.ts';
import type {
  AgentCore,
  Channel,
  ChannelCaps,
  ChannelRef,
  ChannelStatus,
  ChoiceOutcome,
  ChoiceView,
  CommandInfo,
  CoreEvent,
  CoreSnapshot,
  CoreState,
  Deliverable,
  IngestionTicket,
  JobSnapshot,
  JobStopOutcome,
  PromptOrigin,
  Receipt,
  SessionState,
  SubmitResult,
  UserInput,
} from './contract.ts';
import { beginIngestion, isStaleTicket } from './ingestion.ts';
import { createPromptQueue, type PromptQueue, type QueueSink } from './prompt-queue.ts';
import { stopSubagentTask } from './subagent.ts';
import type { DeliveryDraft, DeliveryResult, ToolHost } from './tool-host.ts';
import type { IncomingPrompt, SessionKind } from './types.ts';
import { errorMessage } from './util.ts';

/**
 * The agent core as the bot's own process hosts it: the one AgentCore every
 * channel is written against, whether it runs in this process (Telegram) or
 * reaches it from outside.
 *
 * It owns the prompt queue, the commands and the open menus, fans events and
 * deliveries out to the attached channels, and remembers when each channel
 * last acted, which decides where an alert goes: a reply, or anything sent
 * during a chat turn, alerts the channel the turn's input came from; anything
 * unprompted alerts whichever channel was used within ACTIVE_WINDOW_MS, or
 * failing that every durable one.
 *
 * It is also how the agent's tools reach the user (`toolHost`): their files,
 * voice notes and menus go out as deliveries, through the background outbox
 * when a background run sends them.
 */

export interface LocalCoreOptions {
  chatSession: ChatSession;
  backgroundSession: ChatSession;
  /** Shuts the bot down and exits so systemd brings it back up, for /restart. */
  restart: () => Promise<void>;
  isRunning: () => boolean;
  now?: () => number;
  activeWindowMs?: number;
  /** The jobs the chat started that are still running, for snapshots. */
  runningJobs?: () => JobSnapshot[];
}

export class LocalCore implements AgentCore, QueueSink {
  /** The agent's tools' way to the user; main.ts installs it with setToolHost. */
  readonly toolHost: ToolHost;
  private readonly options: LocalCoreOptions;
  private readonly queue: PromptQueue;
  private readonly choices: ChoiceRegistry;
  private readonly channels = new Map<string, Channel>();
  private readonly lastActionAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly activeWindowMs: number;
  /** Where the chat turn under way came from, so what it sends alerts the same channel. */
  private chatTurnOrigin: PromptOrigin | null = null;

  constructor(options: LocalCoreOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.activeWindowMs = options.activeWindowMs ?? ACTIVE_WINDOW_MS;
    this.choices = new ChoiceRegistry((event) => this.emit(event), this.now);
    defineCommandChoices(this.choices, options.chatSession);
    this.queue = createPromptQueue({
      chatSession: options.chatSession,
      backgroundSession: options.backgroundSession,
      isRunning: options.isRunning,
      sink: this,
    });
    this.toolHost = {
      deliver: (session, label, draft, after) => this.deliverFrom(session, label, draft, after),
      openChoice: (spec) => this.choices.add(spec),
      closeChoice: (id) => this.choices.remove(id),
      submit: (input) => this.submit(input),
      anyChannelCan: (capability) => this.anyChannelCan(capability),
      notice: (markdown, level) => this.notice(markdown, level),
    };
  }

  async submit(input: UserInput): Promise<SubmitResult> {
    this.noteAction(input.from);
    if (input.ticket && isStaleTicket(input.ticket)) {
      cleanupAttachments(input);
      return { status: 'rejected', reason: 'stale' };
    }
    return this.queue.handleIncoming({
      text: input.text,
      attachments: input.attachments,
      origin: { kind: 'user', channel: input.from },
    });
  }

  /** Work the bot gives itself: heartbeat and cron runs, post-restart tasks, job reports. */
  enqueue(prompt: IncomingPrompt): Promise<SubmitResult> {
    return this.queue.handleIncoming(prompt);
  }

  async command(line: string, from: ChannelRef): Promise<boolean> {
    this.noteAction(from);
    return handleCommand(this.commandContext(from), line.trim());
  }

  commands(from: ChannelRef): CommandInfo[] {
    return [...coreCommands(), ...(this.channels.get(from.id)?.commands ?? [])];
  }

  async choose(
    choiceId: string,
    option: number | 'cancel',
    from: ChannelRef,
  ): Promise<ChoiceOutcome> {
    this.noteAction(from);
    return this.choices.choose(choiceId, option, from);
  }

  stopJob(jobId: string, task: number | undefined, from: ChannelRef): JobStopOutcome {
    this.noteAction(from);
    if (jobId.startsWith('bg_') && task === undefined) return stopBackgroundBashByUser(jobId);
    if (jobId.startsWith('sub_') && task !== undefined) return stopSubagentTask(jobId, task);
    return 'not-running';
  }

  beginIngestion(): IngestionTicket {
    return beginIngestion();
  }

  attach(channel: Channel): () => void {
    const { id } = channel.ref;
    if (this.channels.has(id)) throw new Error(`A channel with ID ${id} is already attached`);
    this.channels.set(id, channel);
    this.emit({ type: 'channels', attached: this.attachedRefs() });
    return () => {
      if (this.channels.get(id) !== channel) return;
      this.channels.delete(id);
      this.lastActionAt.delete(id);
      this.emit({ type: 'channels', attached: this.attachedRefs() });
    };
  }

  snapshot(): CoreSnapshot {
    return {
      history: this.options.chatSession.existing()?.pi.messages ?? [],
      jobs: this.options.runningJobs?.() ?? [],
      choices: this.choices.views(),
      state: this.readState(),
      channels: this.attachedRefs(),
    };
  }

  /** True while either session is processing or has queued work. */
  isAssistantBusy(): boolean {
    return this.queue.isAssistantBusy();
  }

  /** True while at least one channel is attached; the outbox holds deliveries until then. */
  hasChannels(): boolean {
    return this.channels.size > 0;
  }

  /**
   * A notice in Markdown from the bot itself, such as the startup message. It
   * alerts like anything sent during the chat turn under way, if there is one.
   */
  notice(markdown: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.emit({
      type: 'notice',
      text: { format: 'markdown', text: markdown },
      level,
      to: 'all',
      ping: this.chatTurnPing(),
    });
  }

  emit(event: CoreEvent): void {
    if (event.type === 'turn_start' && event.session === 'chat') this.chatTurnOrigin = event.origin;
    if (event.type === 'turn_end' && event.session === 'chat') this.chatTurnOrigin = null;
    for (const channel of [...this.channels.values()]) {
      if (event.type === 'notice' && event.to !== 'all' && event.to.id !== channel.ref.id) {
        continue;
      }
      try {
        channel.onEvent(event);
      } catch (error) {
        console.error(`channel ${channel.ref.id} failed on ${event.type}:`, errorMessage(error));
      }
    }
  }

  /** Sends a delivery to every attached channel in its audience, and returns their receipts. */
  async deliver(item: Deliverable): Promise<Receipt[]> {
    const audience = item.kind === 'choice' ? item.choice.audience : 'all';
    const targets = [...this.channels.values()].filter(
      (channel) => audience === 'all' || audience.id === channel.ref.id,
    );
    return Promise.all(
      targets.map(async (channel): Promise<Receipt> => {
        try {
          return await channel.deliver(item);
        } catch (error) {
          return { channel: channel.ref, ok: false, error: errorMessage(error) };
        }
      }),
    );
  }

  pingFor(origin: PromptOrigin): ChannelRef[] {
    if (origin.kind === 'user') {
      const channel = this.channels.get(origin.channel.id);
      if (channel) return [channel.ref];
    }
    return this.unpromptedPing();
  }

  emitState(): void {
    this.emit({ type: 'state', state: this.readState() });
  }

  /** Waits for every channel to finish its pending sends, each for at most timeoutMs. */
  async drain(timeoutMs: number): Promise<void> {
    await Promise.all(
      [...this.channels.values()].map((channel) =>
        channel.drain(timeoutMs).catch((error) => {
          console.error(`channel ${channel.ref.id} failed to drain:`, errorMessage(error));
        }),
      ),
    );
  }

  /**
   * A tool's delivery: at once from the chat session, alerting like the turn it
   * came from, and through the background outbox from the background session,
   * alerting like anything unprompted when it is released.
   */
  private async deliverFrom(
    session: SessionKind,
    label: string,
    draft: () => DeliveryDraft,
    after?: (receipts: Receipt[], item: DeliveryDraft) => void,
  ): Promise<DeliveryResult> {
    const send = async (ping: ChannelRef[]): Promise<Receipt[]> => {
      const item = draft();
      const receipts = await this.deliver({ ...item, ping } as Deliverable);
      after?.(receipts, item);
      return receipts;
    };
    if (session === 'chat') {
      return { outcome: 'delivered', receipts: await send(this.chatTurnPing()) };
    }

    let receipts: Receipt[] | null = null;
    await deliverToChat('background', label, async () => {
      const sent = await send(this.unpromptedPing());
      receipts = sent;
      if (!sent.some((receipt) => receipt.ok)) {
        const reasons = sent.map((receipt) => receipt.error ?? 'not shown');
        throw new Error(reasons.join('; ') || 'no channel is attached');
      }
    });
    return receipts ? { outcome: 'delivered', receipts } : { outcome: 'held' };
  }

  private anyChannelCan(capability: keyof ChannelCaps): boolean {
    return [...this.channels.values()].some((channel) => channel.caps[capability]);
  }

  private commandContext(from: ChannelRef): CommandContext {
    const { chatSession, backgroundSession, restart } = this.options;
    return {
      from,
      chat: chatSession.get(),
      session: chatSession,
      backgroundSession,
      restart,
      reply: (markdown, options) =>
        this.emit({
          type: 'notice',
          text: { format: 'markdown', text: markdown },
          level: 'info',
          to: options?.to === 'all' ? 'all' : from,
          ping: [from],
        }),
      offer: (choice) => this.offer(choice, from),
      announceReset: () => this.emit({ type: 'reset' }),
      commandList: () => this.commands(from),
      channelStatuses: () =>
        [...this.channels.values()].flatMap((channel): ChannelStatus[] =>
          channel.status ? [channel.status()] : [],
        ),
    };
  }

  /** Opens a menu for one channel; one it could not be shown on is forgotten. */
  private async offer(choice: ChoiceSpec, to: ChannelRef): Promise<void> {
    const view: ChoiceView = this.choices.add({ ...choice, audience: to });
    const receipts = await this.deliver({ kind: 'choice', choice: view, ping: [to] });
    if (!receipts.some((receipt) => receipt.ok)) this.choices.remove(view.id);
  }

  /** Any user action counts as chat activity, so held background messages keep waiting. */
  private noteAction(from: ChannelRef): void {
    this.lastActionAt.set(from.id, this.now());
    backgroundOutbox()?.noteChatActivity();
  }

  /** Who something sent during the chat turn under way alerts; unprompted when there is none. */
  private chatTurnPing(): ChannelRef[] {
    return this.chatTurnOrigin ? this.pingFor(this.chatTurnOrigin) : this.unpromptedPing();
  }

  /** The channel used most recently within the active window, or every durable one. */
  private unpromptedPing(): ChannelRef[] {
    const now = this.now();
    let recent: { ref: ChannelRef; at: number } | null = null;
    for (const channel of this.channels.values()) {
      const at = this.lastActionAt.get(channel.ref.id);
      if (at === undefined || now - at > this.activeWindowMs) continue;
      if (!recent || at > recent.at) recent = { ref: channel.ref, at };
    }
    if (recent) return [recent.ref];
    return [...this.channels.values()]
      .filter((channel) => channel.caps.durable)
      .map((channel) => channel.ref);
  }

  private attachedRefs(): ChannelRef[] {
    return [...this.channels.values()].map((channel) => channel.ref);
  }

  private readState(): CoreState {
    const { chatSession, backgroundSession } = this.options;
    return {
      chat: sessionState(chatSession),
      background: sessionState(backgroundSession),
      held: backgroundOutbox()?.heldCount ?? 0,
    };
  }
}

/** Read without creating the session's state, so a snapshot has no side effects. */
function sessionState(session: ChatSession): SessionState {
  const state = session.existing();
  return {
    busy: session.isBusy(),
    queued: state?.queue.length ?? 0,
    steering: state?.pi.pendingSteeringCount ?? 0,
    model: state?.pi.modelName ?? '',
  };
}
