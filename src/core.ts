import { backgroundOutbox } from './background-outbox.ts';
import type { ChatSession } from './chat-session.ts';
import { handleCommand } from './commands.ts';
import { ACTIVE_WINDOW_MS } from './config.ts';
import type {
  AgentCore,
  Channel,
  ChannelRef,
  CoreEvent,
  CoreSnapshot,
  CoreState,
  Deliverable,
  PromptOrigin,
  Receipt,
  SessionState,
  SubmitResult,
  UserInput,
} from './contract.ts';
import { createPromptQueue, type PromptQueue, type QueueSink } from './prompt-queue.ts';
import type { IncomingPrompt } from './types.ts';
import { errorMessage } from './util.ts';

/**
 * The agent core as the bot's own process hosts it: the one AgentCore every
 * channel is written against, whether it runs in this process (Telegram) or
 * reaches it from outside.
 *
 * It owns the prompt queue, fans events and deliveries out to the attached
 * channels, and remembers when each channel last acted, which decides where an
 * alert goes: a reply alerts the channel the input came from, and anything
 * unprompted alerts whichever channel was used within ACTIVE_WINDOW_MS, or
 * failing that every durable one.
 */

export interface LocalCoreOptions {
  chatSession: ChatSession;
  backgroundSession: ChatSession;
  /** Shuts the bot down and exits so systemd brings it back up, for /restart. */
  restart: () => Promise<void>;
  isRunning: () => boolean;
  now?: () => number;
  activeWindowMs?: number;
}

export class LocalCore implements AgentCore, QueueSink {
  private readonly options: LocalCoreOptions;
  private readonly queue: PromptQueue;
  private readonly channels = new Map<string, Channel>();
  private readonly lastActionAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly activeWindowMs: number;

  constructor(options: LocalCoreOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.activeWindowMs = options.activeWindowMs ?? ACTIVE_WINDOW_MS;
    this.queue = createPromptQueue({
      chatSession: options.chatSession,
      backgroundSession: options.backgroundSession,
      isRunning: options.isRunning,
      sink: this,
    });
  }

  submit(input: UserInput): Promise<SubmitResult> {
    this.noteAction(input.from);
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
    // A command is chat activity too, so held background messages keep waiting.
    backgroundOutbox()?.noteChatActivity();
    const { chatSession, backgroundSession, restart } = this.options;
    return handleCommand(
      { chat: chatSession.get(), session: chatSession, backgroundSession, restart },
      line.trim(),
    );
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
      state: this.readState(),
      channels: this.attachedRefs(),
    };
  }

  /** True while either session is processing or has queued work. */
  isAssistantBusy(): boolean {
    return this.queue.isAssistantBusy();
  }

  /** A notice from the bot itself, such as the startup message. Alerts like anything unprompted. */
  notice(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.emit({
      type: 'notice',
      text: { format: 'plain', text },
      level,
      to: 'all',
      ping: this.unpromptedPing(),
    });
  }

  emit(event: CoreEvent): void {
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

  async deliver(item: Deliverable): Promise<Receipt[]> {
    return Promise.all(
      [...this.channels.values()].map(async (channel): Promise<Receipt> => {
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

  private noteAction(from: ChannelRef): void {
    this.lastActionAt.set(from.id, this.now());
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
