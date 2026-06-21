import { type Static, Type } from 'typebox';

/**
 * WebSocket protocol shared by the Node server and the browser client.
 *
 * Two layers are kept explicitly separate:
 *  - Live-only events animate the active run and are NEVER persisted.
 *  - Durable records are persisted to the replay buffer and are what a
 *    reconnecting client replays.
 *
 * Every server event is enveloped with a process-monotonic `seq` (the single
 * ordering authority for live + replayed events) and a `runId` (one per
 * runPrompt call) so concurrent runs on the same chat can be disambiguated.
 */

export interface AttachmentRef {
  assetId: string;
  url: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'file';
}

export interface MenuOptionRef {
  label: string;
  value: string;
}

export interface ServerEventPayloads {
  ready: {
    model: string;
    allowedModels: string[];
    vapidPublicKey: string | null;
    pushEnabled: boolean;
    status: string;
    serverSeq: number;
  };
  replay: { records: ServerEvent[] };
  run_start: { source: string };
  run_end: { source: string };
  assistant_delta: { text: string };
  thinking_delta: { text: string };
  tool_start: { toolCallId: string; name: string; label: string; args: unknown };
  tool_update: { toolCallId: string; partial: string };
  user_message: { text: string; attachments: AttachmentRef[] };
  assistant_message: { text: string };
  tool_record: {
    toolCallId: string;
    name: string;
    label: string;
    args: unknown;
    result: string;
    isError: boolean;
  };
  file: {
    assetId: string;
    url: string;
    name: string;
    mimeType: string;
    caption?: string;
    kind: 'image' | 'document';
  };
  voice: { assetId: string; url: string; mimeType: string };
  menu: { menuId: string; text: string; options: MenuOptionRef[]; allowCancel: boolean };
  model_changed: { model: string };
  notice: { text: string; level: 'info' | 'warn' | 'error' };
  error: { message: string };
}

export type ServerEventType = keyof ServerEventPayloads;

export interface Envelope<T extends ServerEventType = ServerEventType> {
  seq: number;
  runId?: string;
  chatId: string;
  ts: number;
  type: T;
  payload: ServerEventPayloads[T];
}

export type ServerEvent = { [K in ServerEventType]: Envelope<K> }[ServerEventType];

export type ServerEventInput = {
  [K in ServerEventType]: { type: K; payload: ServerEventPayloads[K]; runId?: string };
}[ServerEventType];

/** Durable records are persisted and rebuilt on replay. Everything else is live-only. */
export const DURABLE_EVENT_TYPES: ReadonlySet<ServerEventType> = new Set<ServerEventType>([
  'user_message',
  'assistant_message',
  'tool_record',
  'file',
  'voice',
  'menu',
  'model_changed',
  'notice',
]);

/** Durable records that should also fire a Web Push when no client is visible. */
export const PUSH_EVENT_TYPES: ReadonlySet<ServerEventType> = new Set<ServerEventType>([
  'assistant_message',
  'file',
  'voice',
  'menu',
]);

export function isDurable(type: ServerEventType): boolean {
  return DURABLE_EVENT_TYPES.has(type);
}

export function isPushWorthy(type: ServerEventType): boolean {
  return PUSH_EVENT_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// Normalized Pi stream events (emitted by pi-session, consumed by the gateway)
// ---------------------------------------------------------------------------

export type PiStreamEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'tool_start'; toolCallId: string; name: string; label: string; args: unknown }
  | { kind: 'tool_update'; toolCallId: string; partial: string }
  | {
      kind: 'tool_end';
      toolCallId: string;
      name: string;
      label: string;
      args: unknown;
      result: string;
      isError: boolean;
    };

// ---------------------------------------------------------------------------
// Client → server messages (validated at runtime against these schemas)
// ---------------------------------------------------------------------------

const PromptMessage = Type.Object(
  {
    type: Type.Literal('prompt'),
    text: Type.String({ maxLength: 200_000 }),
    uploadIds: Type.Optional(
      Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 }),
    ),
  },
  { additionalProperties: false },
);

const MenuSelectMessage = Type.Object(
  {
    type: Type.Literal('menu_select'),
    menuId: Type.String({ maxLength: 64 }),
    optionIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
    cancel: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const AbortMessage = Type.Object(
  { type: Type.Literal('abort') },
  { additionalProperties: false },
);

const NewSessionMessage = Type.Object(
  { type: Type.Literal('new') },
  { additionalProperties: false },
);

const SetModelMessage = Type.Object(
  { type: Type.Literal('set_model'), model: Type.String({ maxLength: 200 }) },
  { additionalProperties: false },
);

const VisibilityMessage = Type.Object(
  { type: Type.Literal('visibility'), visible: Type.Boolean() },
  { additionalProperties: false },
);

const AckMessage = Type.Object(
  { type: Type.Literal('ack'), lastSeq: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const ClientMessageSchema = Type.Union([
  PromptMessage,
  MenuSelectMessage,
  AbortMessage,
  NewSessionMessage,
  SetModelMessage,
  VisibilityMessage,
  AckMessage,
]);

export type ClientMessage = Static<typeof ClientMessageSchema>;
