import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { Attachment, JobReportSource, SessionKind } from './types.ts';

/**
 * The contract between the agent core and the interfaces that use it
 * ("channels": Telegram, and the terminal UI over a socket). Types only, and
 * the one core module a channel needs: a channel gives the core input through
 * AgentCore, and hears back through three kinds of output. Every call that
 * answers is async, so the core can as well be in another process: the
 * terminal UI reaches it through RemoteCore, a socket proxy of this interface.
 *
 * - Events go to every attached channel, in order: the conversation, job
 *   progress, closed menus, notices, and state. A channel keeps its own sends
 *   in that order.
 * - Return values go only to the channel that acted, such as whether a message
 *   was queued, steered, or turned away, or what a menu tap did. The channel
 *   shows its own feedback.
 * - Deliveries (files, voice notes, menus, background reports) go to every
 *   attached channel in their audience, and each returns a receipt, so a tool
 *   learns whether its upload arrived and the core whether anyone was actually
 *   sent a background report.
 *
 * The core never asks which channel it is talking to. What differs between
 * channels is declared in their capabilities, or is their own setting.
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
  /** The core's commands plus that channel's own, for its command menu and /help. */
  commands(from: ChannelRef): CommandInfo[];
  /** Answers an open menu. The first answer wins; every copy closes with it. */
  choose(choiceId: string, option: number | 'cancel', from: ChannelRef): Promise<ChoiceOutcome>;
  /** Stops a running job, or one task of a sub-agent job; its report says the user stopped it. */
  stopJob(jobId: string, task: number | undefined, from: ChannelRef): Promise<JobStopOutcome>;
  /**
   * Taken when a channel starts ingesting a message it may take a while to
   * submit (a download, a transcription). /abort and /new make every ticket
   * taken before them stale, and a submit with a stale ticket is turned away.
   * The ticket is dated when this is called, not when it resolves.
   */
  beginIngestion(): Promise<IngestionTicket>;
  /** Starts sending events and deliveries to a channel. Returns its detach. */
  attach(channel: Channel): () => void;
  /** Everything a channel needs to show the chat as it is, e.g. one that has just connected. */
  snapshot(): Promise<CoreSnapshot>;
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
  /** Commands the channel handles itself, listed with the core's. */
  readonly commands?: readonly CommandInfo[];
  /** The channel's own settings, for /status. */
  status?(): ChannelStatus;
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

export interface CommandInfo {
  /** Without the leading slash. */
  name: string;
  /** Short line for a command menu. */
  description: string;
  /** Longer line for /help. Falls back to description. */
  help?: string;
  /** Set only for commands deliberately kept out of /help. */
  hideFromHelp?: boolean;
}

export interface ChannelStatus {
  title: string;
  settings: Array<{ label: string; on?: boolean; detail?: string }>;
}

/** Opaque to channels. */
export interface IngestionTicket {
  readonly epoch: number;
}

export interface UserInput {
  from: ChannelRef;
  text: string;
  /** Local files. The core owns them once submitted, and deletes its temp files after use. */
  attachments: Attachment[];
  /** The ticket taken when ingestion began; a stale one is turned away. */
  ticket?: IngestionTicket;
}

export type SubmitResult =
  | { status: 'queued' | 'steered' }
  | { status: 'rejected'; reason: 'queue-full' | 'stale' | 'shutting-down' }
  | { status: 'rejected'; reason: 'error'; error: string };

/** How a turn ended. Silent means a noop sentinel or a blank unattended reply: nothing to show. */
export type TurnOutcome =
  | { outcome: 'replied'; reply: RichText }
  | { outcome: 'silent' }
  | { outcome: 'error'; error: string };

export type CoreEvent =
  /** User input the core accepted. `attachments` are the files' names, for showing. */
  | { type: 'input'; from: ChannelRef; text: string; attachments: string[]; steered: boolean }
  | { type: 'turn_start'; turnId: string; session: SessionKind; origin: PromptOrigin }
  /** An SDK event from a session. turnId is null for one that came between turns. */
  | { type: 'agent'; turnId: string | null; session: SessionKind; event: AgentSessionEvent }
  | ({ type: 'turn_end'; turnId: string; session: SessionKind; ping: ChannelRef[] } & TurnOutcome)
  /**
   * A job the chat started, whenever it changes: once as it starts, then as it
   * goes, urgently for the user's own stop, and a last time, final, as it
   * settles. Each channel paces its own updates.
   */
  | { type: 'job'; job: JobSnapshot; urgent?: boolean; final?: boolean }
  /**
   * A menu was answered, cancelled, refused or expired, and every copy of it
   * now reads `text`. Sent to every channel: one that never showed the menu may
   * show the text as a note, since it can report a change such as a new model.
   */
  | { type: 'choice_closed'; choiceId: string; text: RichText; by?: ChannelRef }
  | {
      type: 'notice';
      text: RichText;
      level: 'info' | 'warn' | 'error';
      to: 'all' | ChannelRef;
      ping: ChannelRef[];
    }
  | { type: 'state'; state: CoreState }
  /** /new started a fresh conversation. */
  | { type: 'reset' }
  | { type: 'channels'; attached: ChannelRef[] };

/**
 * Text as the core hands it over. The bot's own text is Markdown, which each
 * channel renders its own way; plain text is for the channel to escape. Model
 * replies are Telegram HTML, which is what the system prompt asks for.
 */
export interface RichText {
  format: 'plain' | 'markdown' | 'telegram-html';
  text: string;
}

/**
 * Something sent to the user outside the conversation's own messages. A
 * channel that cannot show a kind returns a receipt skipped as unsupported.
 */
export type Deliverable = (
  | { kind: 'image' | 'document'; path: string; caption?: string }
  /** `path` is unset when no attached channel plays voice notes, so none was synthesized. */
  | { kind: 'voice'; text: string; path?: string }
  /** Goes only to the channels in the menu's audience. */
  | { kind: 'choice'; choice: ChoiceView }
  /** A background run's report, released by the background outbox. */
  | { kind: 'report'; text: RichText; origin: PromptOrigin; label?: string }
) & { ping: ChannelRef[] };

export interface Receipt {
  channel: ChannelRef;
  ok: boolean;
  error?: string;
  skipped?: 'unsupported';
}

/** An open menu as a channel shows it. */
export interface ChoiceView {
  id: string;
  text: RichText;
  options: string[];
  columns: number;
  cancellable: boolean;
  expiresAt?: number;
  audience: 'all' | ChannelRef;
}

export interface ChoiceOutcome {
  /** A short acknowledgement for the one who tapped. */
  toast: string;
  /** What the menu now reads. */
  text: RichText;
  /** False when the menu was unknown or gone: only the tapped copy needs `text`. */
  closed: boolean;
  /** Set when the answer was submitted as the user's message, for the usual feedback. */
  submitted?: SubmitResult;
}

export type JobStopOutcome = 'stopping' | 'already-stopping' | 'not-running';

export type JobSnapshot = BashJobSnapshot | SubagentJobSnapshot;

export interface BashJobSnapshot {
  kind: 'bash';
  id: string;
  command: string;
  status: 'running' | 'exited' | 'stopped' | 'failed';
  /** The status as the user reads it, e.g. `exited with code 1` or `stopped by you`. */
  statusText: string;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** The user asked it to stop; it may not have ended yet. */
  stopRequested: boolean;
  /** The latest line of output, if any. */
  lastLine: string | null;
}

export type SubagentTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped';

export interface SubagentTaskSnapshot {
  /** 0-based; shown 1-based, and the number never changes. */
  index: number;
  task: string;
  /** The agent's short title for the task, if it gave one. */
  description: string | null;
  /** provider/model the worker runs on. */
  model: string;
  status: SubagentTaskStatus;
  /** The user asked this task to stop; set before the abort. */
  stopRequested: boolean;
  /** The worker's recent tool calls, oldest first, each one line of plain text. */
  toolCalls: readonly string[];
  toolUses: number;
  result: string | null;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface SubagentJobSnapshot {
  kind: 'subagent';
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'stopped';
  startedAt: number;
  endedAt: number | null;
  tasks: readonly SubagentTaskSnapshot[];
}

export interface SessionState {
  busy: boolean;
  queued: number;
  steering: number;
  model: string;
  /** The reasoning level, once the session is loaded; unknown before. */
  reasoning?: string;
}

export interface CoreState {
  chat: SessionState;
  background: SessionState;
  /** Background deliveries the outbox is holding until the chat is idle. */
  held: number;
}

export interface CoreSnapshot {
  /**
   * The chat conversation: the live session's messages, or those of the
   * transcript it would resume when none is loaded; empty after /new.
   */
  history: AgentMessage[];
  /** Jobs the chat started that are still running. */
  jobs: JobSnapshot[];
  /** Open menus, with their audience. */
  choices: ChoiceView[];
  state: CoreState;
  channels: ChannelRef[];
}
