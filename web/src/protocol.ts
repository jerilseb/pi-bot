// Frontend copy of the server protocol types (kept in sync with src/web/protocol.ts).

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

export type ClientMessage =
  | { type: 'prompt'; text: string; uploadIds?: string[] }
  | { type: 'menu_select'; menuId: string; optionIndex?: number; cancel?: boolean }
  | { type: 'abort' }
  | { type: 'new' }
  | { type: 'set_model'; model: string }
  | { type: 'visibility'; visible: boolean }
  | { type: 'ack'; lastSeq: number };
