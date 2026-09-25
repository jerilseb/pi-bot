import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { Attachment, JobReportSource, SessionKind } from './types.ts';

/**
 * The contract between the agent core and the interfaces that use it
 * ("channels": Telegram today, a terminal UI later). Types only, and the one
 * core module a channel needs: a channel gives the core input through
 * AgentCore, and hears back through three kinds of output.
 *
 * - Events go to every attached channel, in order: the conversation, notices,
 *   and state. A channel keeps its own sends in that order.
 * - Return values go only to the channel that acted, such as whether a message
 *   was queued, steered, or turned away. The channel shows its own feedback.
 * - Deliveries go to every attached channel, and each returns a receipt, so the
 *   core knows whether anyone was actually sent a background report.
 *
 * The core never asks which channel it is talking to. What differs between
 * channels is declared in their capabilities, or is their own setting.
 *
 * Not here yet: the command list, choices (menus), job progress and stop,
 * tickets that discard downloads made stale by /abort or /new, and file and
 * voice deliveries. Until those move behind the contract, the modules behind
 * them still talk to Telegram directly.
 */

export interface ChannelRef {
  /** Unique among attached channels, e.g. 'telegram' or 'tui:2'. */
  id: string;
  kind: 'telegram' | 'tui';
}

/** Where a prompt came from. Only user input may steer a chat turn already under way. */
export type PromptOrigin =
  | { kind: 'user'; channel: ChannelRef }
  | { kind: 'heartbeat' }
  | { kind: 'cron'; taskId: string }
  | { kind: 'post-restart'; taskId: string }
  | { kind: 'job-report'; source: JobReportSource };

export interface AgentCore {
  /** Queues user input, or steers it into the chat turn under way. */
  submit(input: UserInput): Promise<SubmitResult>;
  /** Runs a slash command. False when the line is not one the core knows. */
  command(line: string, from: ChannelRef): Promise<boolean>;
  /** Starts sending events and deliveries to a channel. Returns its detach. */
  attach(channel: Channel): () => void;
  snapshot(): CoreSnapshot;
}

export interface ChannelCaps {
  buttons: boolean;
  edits: boolean;
  files: boolean;
  voice: boolean;
  /** Keeps what it is sent while nobody is looking, e.g. Telegram's chat history. */
  durable: boolean;
}

export interface Channel {
  readonly ref: ChannelRef;
  readonly caps: ChannelCaps;
  /**
   * Called for every event, in order. Must return at once and never throw: a
   * channel queues its sends internally, since the core does not wait for them.
   */
  onEvent(event: CoreEvent): void;
  /** Sends one delivery, after anything this channel already queued. */
  deliver(item: Deliverable): Promise<Receipt>;
  /** Finishes pending sends, or gives up after timeoutMs. Called at shutdown. */
  drain(timeoutMs: number): Promise<void>;
}

export interface UserInput {
  from: ChannelRef;
  text: string;
  /** Local files. The core owns them once submitted, and deletes its temp files after use. */
  attachments: Attachment[];
}

export type SubmitResult =
  | { status: 'queued' | 'steered' }
  | { status: 'rejected'; reason: 'queue-full' | 'shutting-down' }
  | { status: 'rejected'; reason: 'error'; error: string };

/** How a turn ended. Silent means a noop sentinel or a blank unattended reply: nothing to show. */
export type TurnOutcome =
  | { outcome: 'replied'; reply: RichText }
  | { outcome: 'silent' }
  | { outcome: 'error'; error: string };

export type CoreEvent =
  | { type: 'input'; from: ChannelRef; text: string; steered: boolean }
  | { type: 'turn_start'; turnId: string; session: SessionKind; origin: PromptOrigin }
  /** An SDK event from a session. turnId is null for one that came between turns. */
  | { type: 'agent'; turnId: string | null; session: SessionKind; event: AgentSessionEvent }
  | ({ type: 'turn_end'; turnId: string; session: SessionKind; ping: ChannelRef[] } & TurnOutcome)
  | {
      type: 'notice';
      text: RichText;
      level: 'info' | 'warn' | 'error';
      to: 'all' | ChannelRef;
      ping: ChannelRef[];
    }
  | { type: 'state'; state: CoreState }
  | { type: 'channels'; attached: ChannelRef[] };

/**
 * Text as the core hands it over. Plain text is for the channel to escape.
 * Model replies are Telegram HTML, which is what the system prompt asks for.
 */
export interface RichText {
  format: 'plain' | 'telegram-html';
  text: string;
}

/** A background run's report, released by the background outbox. */
export type Deliverable = {
  kind: 'report';
  text: RichText;
  origin: PromptOrigin;
  label?: string;
  ping: ChannelRef[];
};

export interface Receipt {
  channel: ChannelRef;
  ok: boolean;
  error?: string;
  skipped?: 'unsupported';
}

export interface SessionState {
  busy: boolean;
  queued: number;
  steering: number;
  model: string;
}

export interface CoreState {
  chat: SessionState;
  background: SessionState;
  /** Background deliveries the outbox is holding until the chat is idle. */
  held: number;
}

export interface CoreSnapshot {
  /** The live chat session's messages; empty until its transcript is loaded. */
  history: AgentMessage[];
  state: CoreState;
  channels: ChannelRef[];
}
