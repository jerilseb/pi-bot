import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  ChannelCaps,
  ChannelRef,
  ChoiceOutcome,
  CommandInfo,
  CoreEvent,
  CoreSnapshot,
  Deliverable,
  IngestionTicket,
  JobStopOutcome,
  SubmitResult,
} from '../../contract.ts';
import type { Attachment } from '../../types.ts';
import { isRecord } from '../../util.ts';

/**
 * The terminal UI's wire protocol: the AgentCore contract carried over a Unix
 * socket, one JSON record per line (jsonl.ts), after the conventions of Pi's
 * RPC mode. Not Pi's own RPC commands, which drive a bare session and would
 * go around the bot's queue, menus and jobs.
 *
 * - The client opens with `hello`, carrying the protocol version, its
 *   capabilities and its own commands. The answer names the channel it is
 *   attached as (`tui:<n>`), the commands it can use, and a snapshot of the
 *   chat; every event after that answer is newer than the snapshot.
 * - Requests `{ id, type, … }` mirror AgentCore's calls and get a response
 *   `{ type: 'response', id, ok, result | error }`. The server acts as the
 *   connection's channel whatever a request says.
 * - Events come as `{ type: 'event', event }`, in the core's order.
 * - Deliveries come as `{ type: 'deliver', id, item }`, and the client answers
 *   each with `{ type: 'receipt', id, ok, error?, skipped? }` within the
 *   receipt timeout, or the delivery counts as failed.
 *
 * What does not cross: image bytes (a terminal shows an image's name, and a
 * transcript of screenshots would be megabytes per connect), and the partial
 * message inside a streaming update, which repeats the message it carries.
 */

export const PROTOCOL_VERSION = 1;

export interface Welcome {
  ref: ChannelRef;
  /** The core's commands, then the client's own. */
  commands: CommandInfo[];
  snapshot: CoreSnapshot;
}

export type ClientRequest =
  | { type: 'hello'; protocol: number; caps: ChannelCaps; commands: CommandInfo[] }
  | { type: 'submit'; text: string; attachments: Attachment[]; ticket?: IngestionTicket }
  | { type: 'command'; line: string }
  | { type: 'choose'; choiceId: string; option: number | 'cancel' }
  | { type: 'stopJob'; jobId: string; task?: number }
  | { type: 'beginIngestion' }
  | { type: 'snapshot' };

/** What each request answers with. */
export interface RequestResults {
  hello: Welcome;
  submit: SubmitResult;
  command: boolean;
  choose: ChoiceOutcome;
  stopJob: JobStopOutcome;
  beginIngestion: IngestionTicket;
  snapshot: CoreSnapshot;
}

export interface ClientReceipt {
  type: 'receipt';
  id: number;
  ok: boolean;
  error?: string;
  skipped?: 'unsupported';
}

export type ClientMessage = (ClientRequest & { id: number }) | ClientReceipt;

export type ServerMessage =
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: string }
  | { type: 'event'; event: CoreEvent }
  | { type: 'deliver'; id: number; item: Deliverable };

/** A client's record, checked field by field; null for anything malformed. */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !isId(value.id)) return null;
  const { id } = value;
  switch (value.type) {
    case 'receipt':
      if (typeof value.ok !== 'boolean') return null;
      return {
        type: 'receipt',
        id,
        ok: value.ok,
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
        ...(value.skipped === 'unsupported' ? { skipped: 'unsupported' as const } : {}),
      };
    case 'hello': {
      const caps = parseCaps(value.caps);
      const commands = parseCommands(value.commands);
      if (typeof value.protocol !== 'number' || !caps || !commands) return null;
      return { id, type: 'hello', protocol: value.protocol, caps, commands };
    }
    case 'submit': {
      const attachments = parseAttachments(value.attachments);
      if (typeof value.text !== 'string' || !attachments) return null;
      const ticket =
        isRecord(value.ticket) && typeof value.ticket.epoch === 'number'
          ? { ticket: { epoch: value.ticket.epoch } }
          : {};
      return { id, type: 'submit', text: value.text, attachments, ...ticket };
    }
    case 'command':
      return typeof value.line === 'string' ? { id, type: 'command', line: value.line } : null;
    case 'choose': {
      const { choiceId, option } = value;
      if (typeof choiceId !== 'string') return null;
      if (option !== 'cancel' && !Number.isInteger(option)) return null;
      return { id, type: 'choose', choiceId, option: option as number | 'cancel' };
    }
    case 'stopJob': {
      if (typeof value.jobId !== 'string') return null;
      if (value.task !== undefined && !Number.isInteger(value.task)) return null;
      return {
        id,
        type: 'stopJob',
        jobId: value.jobId,
        ...(value.task !== undefined ? { task: value.task as number } : {}),
      };
    }
    case 'beginIngestion':
    case 'snapshot':
      return { id, type: value.type };
    default:
      return null;
  }
}

/** The server's record, checked only for its shape: the client trusts what the bot says. */
export function parseServerMessage(value: unknown): ServerMessage | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'response':
      return isId(value.id) && typeof value.ok === 'boolean' ? (value as ServerMessage) : null;
    case 'event':
      return isRecord(value.event) && typeof value.event.type === 'string'
        ? (value as ServerMessage)
        : null;
    case 'deliver':
      return isId(value.id) && isRecord(value.item) ? (value as ServerMessage) : null;
    default:
      return null;
  }
}

/**
 * JSON.stringify's replacer for everything the server sends: an image's bytes
 * become empty, keeping its type, so the client knows one was there.
 */
export function wireReplacer(this: unknown, key: string, value: unknown): unknown {
  if (key === 'data' && typeof value === 'string' && isRecord(this) && this.type === 'image') {
    return '';
  }
  return value;
}

/** An event as it goes over the wire: a streaming update without the partial it repeats. */
export function wireEvent(event: CoreEvent): CoreEvent {
  if (event.type !== 'agent' || event.event.type !== 'message_update') return event;
  const { partial: _partial, ...update } = event.event.assistantMessageEvent as {
    partial?: unknown;
  };
  return {
    ...event,
    event: {
      ...event.event,
      assistantMessageEvent: update as typeof event.event.assistantMessageEvent,
    },
  };
}

/**
 * The latest `max` messages, starting at a user message so no turn is shown
 * from its middle: a tool result without its call, say. All of them when that
 * would leave nothing.
 */
export function recentHistory(messages: AgentMessage[], max: number): AgentMessage[] {
  if (messages.length <= max) return messages;
  const recent = messages.slice(messages.length - max);
  const start = recent.findIndex((message) => message.role === 'user');
  return start > 0 ? recent.slice(start) : recent;
}

function isId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseCaps(value: unknown): ChannelCaps | null {
  if (!isRecord(value)) return null;
  const keys = ['buttons', 'edits', 'files', 'voice', 'durable'] as const;
  if (!keys.every((key) => typeof value[key] === 'boolean')) return null;
  return {
    buttons: value.buttons as boolean,
    edits: value.edits as boolean,
    files: value.files as boolean,
    voice: value.voice as boolean,
    durable: value.durable as boolean,
  };
}

function parseCommands(value: unknown): CommandInfo[] | null {
  if (!Array.isArray(value)) return null;
  const commands: CommandInfo[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.description !== 'string'
    ) {
      return null;
    }
    if (!/^[a-z0-9_]{1,32}$/.test(entry.name)) return null;
    commands.push({
      name: entry.name,
      description: entry.description,
      ...(typeof entry.help === 'string' ? { help: entry.help } : {}),
      ...(entry.hideFromHelp === true ? { hideFromHelp: true } : {}),
    });
  }
  return commands;
}

/** Local files, by absolute path: the client and the bot share one filesystem. */
function parseAttachments(value: unknown): Attachment[] | null {
  if (!Array.isArray(value)) return null;
  const attachments: Attachment[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || (entry.type !== 'image' && entry.type !== 'file')) return null;
    if (typeof entry.path !== 'string' || !entry.path.startsWith('/')) return null;
    attachments.push({
      type: entry.type,
      path: entry.path,
      ...(typeof entry.filename === 'string' ? { filename: entry.filename } : {}),
      ...(typeof entry.mimeType === 'string' ? { mimeType: entry.mimeType } : {}),
      ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
    });
  }
  return attachments;
}
