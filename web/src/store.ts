import type { AttachmentRef, MenuOptionRef, ServerEvent } from './protocol.ts';

export type Entry =
  | { kind: 'user'; id: string; text: string; attachments: AttachmentRef[] }
  | { kind: 'assistant'; id: string; runId?: string; text: string; thinking: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      toolCallId: string;
      name: string;
      label: string;
      args: unknown;
      result: string;
      isError: boolean;
      status: 'running' | 'done';
    }
  | {
      kind: 'file';
      id: string;
      url: string;
      name: string;
      mimeType: string;
      fileKind: 'image' | 'document';
      caption?: string;
    }
  | { kind: 'voice'; id: string; url: string; mimeType: string }
  | { kind: 'menu'; id: string; menuId: string; text: string; options: MenuOptionRef[]; allowCancel: boolean; resolved: boolean }
  | { kind: 'notice'; id: string; text: string; level: 'info' | 'warn' | 'error' };

export interface ChatState {
  entries: Entry[];
  highSeq: number;
  model: string;
  allowedModels: string[];
  vapidPublicKey: string | null;
  pushEnabled: boolean;
  status: string;
  connected: boolean;
  running: boolean;
}

export const initialState: ChatState = {
  entries: [],
  highSeq: 0,
  model: '',
  allowedModels: [],
  vapidPublicKey: null,
  pushEnabled: false,
  status: '',
  connected: false,
  running: false,
};

export type Action =
  | { type: 'event'; event: ServerEvent }
  | { type: 'status'; connected: boolean }
  | { type: 'resolveMenu'; menuId: string };

function assistantId(runId: string | undefined): string {
  return `assistant-${runId ?? 'na'}`;
}

/** Applies a single event to the entry list. Pure on entries. */
function reduceEntries(entries: Entry[], event: ServerEvent): Entry[] {
  switch (event.type) {
    case 'user_message':
      return [
        ...entries,
        {
          kind: 'user',
          id: `u-${event.seq}`,
          text: event.payload.text,
          attachments: event.payload.attachments,
        },
      ];

    case 'assistant_delta': {
      const id = assistantId(event.runId);
      const existing = entries.find((e) => e.id === id && e.kind === 'assistant');
      if (existing && existing.kind === 'assistant') {
        return entries.map((e) =>
          e.id === id && e.kind === 'assistant'
            ? { ...e, text: e.text + event.payload.text, streaming: true }
            : e,
        );
      }
      return [
        ...entries,
        {
          kind: 'assistant',
          id,
          runId: event.runId,
          text: event.payload.text,
          thinking: '',
          streaming: true,
        },
      ];
    }

    case 'thinking_delta': {
      const id = assistantId(event.runId);
      const existing = entries.find((e) => e.id === id && e.kind === 'assistant');
      if (existing && existing.kind === 'assistant') {
        return entries.map((e) =>
          e.id === id && e.kind === 'assistant'
            ? { ...e, thinking: e.thinking + event.payload.text, streaming: true }
            : e,
        );
      }
      return [
        ...entries,
        {
          kind: 'assistant',
          id,
          runId: event.runId,
          text: '',
          thinking: event.payload.text,
          streaming: true,
        },
      ];
    }

    case 'assistant_message': {
      const id = assistantId(event.runId);
      const existing = entries.find((e) => e.id === id && e.kind === 'assistant');
      if (existing && existing.kind === 'assistant') {
        return entries.map((e) =>
          e.id === id && e.kind === 'assistant'
            ? { ...e, text: event.payload.text, streaming: false }
            : e,
        );
      }
      return [
        ...entries,
        {
          kind: 'assistant',
          id: `a-${event.seq}`,
          runId: event.runId,
          text: event.payload.text,
          thinking: '',
          streaming: false,
        },
      ];
    }

    case 'tool_start':
      if (entries.some((e) => e.kind === 'tool' && e.toolCallId === event.payload.toolCallId)) {
        return entries;
      }
      return [
        ...entries,
        {
          kind: 'tool',
          id: `tool-${event.payload.toolCallId}`,
          toolCallId: event.payload.toolCallId,
          name: event.payload.name,
          label: event.payload.label,
          args: event.payload.args,
          result: '',
          isError: false,
          status: 'running',
        },
      ];

    case 'tool_update':
      return entries.map((e) =>
        e.kind === 'tool' && e.toolCallId === event.payload.toolCallId
          ? { ...e, result: event.payload.partial }
          : e,
      );

    case 'tool_record': {
      const found = entries.some(
        (e) => e.kind === 'tool' && e.toolCallId === event.payload.toolCallId,
      );
      if (found) {
        return entries.map((e) =>
          e.kind === 'tool' && e.toolCallId === event.payload.toolCallId
            ? {
                ...e,
                args: event.payload.args,
                result: event.payload.result,
                isError: event.payload.isError,
                status: 'done',
              }
            : e,
        );
      }
      return [
        ...entries,
        {
          kind: 'tool',
          id: `tool-${event.payload.toolCallId}`,
          toolCallId: event.payload.toolCallId,
          name: event.payload.name,
          label: event.payload.label,
          args: event.payload.args,
          result: event.payload.result,
          isError: event.payload.isError,
          status: 'done',
        },
      ];
    }

    case 'file':
      return [
        ...entries,
        {
          kind: 'file',
          id: `f-${event.seq}`,
          url: event.payload.url,
          name: event.payload.name,
          mimeType: event.payload.mimeType,
          fileKind: event.payload.kind,
          ...(event.payload.caption ? { caption: event.payload.caption } : {}),
        },
      ];

    case 'voice':
      return [
        ...entries,
        { kind: 'voice', id: `v-${event.seq}`, url: event.payload.url, mimeType: event.payload.mimeType },
      ];

    case 'menu':
      return [
        ...entries,
        {
          kind: 'menu',
          id: `m-${event.seq}`,
          menuId: event.payload.menuId,
          text: event.payload.text,
          options: event.payload.options,
          allowCancel: event.payload.allowCancel,
          resolved: false,
        },
      ];

    case 'notice':
      return [
        ...entries,
        { kind: 'notice', id: `n-${event.seq}`, text: event.payload.text, level: event.payload.level },
      ];

    case 'model_changed':
      return [
        ...entries,
        {
          kind: 'notice',
          id: `mc-${event.seq}`,
          text: `Model changed to ${event.payload.model}`,
          level: 'info',
        },
      ];

    default:
      return entries;
  }
}

export function reducer(state: ChatState, action: Action): ChatState {
  if (action.type === 'status') {
    return { ...state, connected: action.connected };
  }

  if (action.type === 'resolveMenu') {
    return {
      ...state,
      entries: state.entries.map((e) =>
        e.kind === 'menu' && e.menuId === action.menuId ? { ...e, resolved: true } : e,
      ),
    };
  }

  const { event } = action;

  if (event.type === 'ready') {
    return {
      ...state,
      model: event.payload.model,
      allowedModels: event.payload.allowedModels,
      vapidPublicKey: event.payload.vapidPublicKey,
      pushEnabled: event.payload.pushEnabled,
      status: event.payload.status,
    };
  }

  if (event.type === 'replay') {
    let entries: Entry[] = [];
    for (const record of event.payload.records) entries = reduceEntries(entries, record);
    return { ...state, entries, highSeq: event.payload.records.at(-1)?.seq ?? state.highSeq };
  }

  if (event.type === 'error') {
    return {
      ...state,
      entries: [
        ...state.entries,
        { kind: 'notice', id: `e-${Date.now()}-${Math.random()}`, text: event.payload.message, level: 'error' },
      ],
    };
  }

  if (event.seq <= state.highSeq) return state;

  let next: ChatState = { ...state, highSeq: event.seq };

  if (event.type === 'run_start') next = { ...next, running: true };
  if (event.type === 'run_end') {
    next = {
      ...next,
      running: false,
      entries: next.entries.map((e) =>
        e.kind === 'assistant' && e.runId === event.runId ? { ...e, streaming: false } : e,
      ),
    };
    return next;
  }
  if (event.type === 'model_changed') next = { ...next, model: event.payload.model };

  return { ...next, entries: reduceEntries(next.entries, event) };
}
