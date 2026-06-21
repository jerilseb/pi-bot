import type { WebSocket } from 'ws';
import { errorMessage } from '../util.ts';
import { append as historyAppend, nextSeq, readRecords } from './history-buffer.ts';
import {
  type Envelope,
  isDurable,
  isPushWorthy,
  type PiStreamEvent,
  type ServerEvent,
  type ServerEventInput,
} from './protocol.ts';
import { type PushPayload, sendPush } from './push.ts';

/**
 * The central client gateway: the single seam that owns all browser I/O. It is
 * the only module that knows about WebSocket/push. Pi events stream through it
 * live; durable records are also written to the replay buffer and (when no
 * client is visible) fire a Web Push.
 */

interface ClientConn {
  ws: WebSocket;
  chatId: string;
  visible: boolean;
}

const WS_OPEN = 1;

const conns = new Map<WebSocket, ClientConn>();
const activeRun = new Map<string, string>();

function clientsFor(chatId: string): ClientConn[] {
  const out: ClientConn[] = [];
  for (const conn of conns.values()) {
    if (conn.chatId === chatId) out.push(conn);
  }
  return out;
}

function sendRaw(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState !== WS_OPEN) return;
  try {
    ws.send(JSON.stringify(event));
  } catch (error) {
    console.error('Gateway send failed:', errorMessage(error));
  }
}

export function addClient(ws: WebSocket, chatId: string): void {
  conns.set(ws, { ws, chatId, visible: true });
}

export function removeClient(ws: WebSocket): void {
  conns.delete(ws);
}

export function setVisibility(ws: WebSocket, visible: boolean): void {
  const conn = conns.get(ws);
  if (conn) conn.visible = visible;
}

export function hasVisibleClient(chatId: string): boolean {
  return clientsFor(chatId).some((conn) => conn.visible);
}

/** Replays retained durable records to a single freshly connected client. */
export function replayTo(ws: WebSocket, chatId: string): void {
  const records = readRecords(chatId);
  const maxSeq = records.length ? records[records.length - 1].seq : 0;
  const event: Envelope<'replay'> = {
    seq: maxSeq,
    chatId,
    ts: Date.now(),
    type: 'replay',
    payload: { records },
  };
  sendRaw(ws, event);
}

/** Sends a one-off event to a single client (used for `ready`). */
export function sendTo(ws: WebSocket, input: ServerEventInput, chatId: string): void {
  const event = {
    seq: nextSeq(),
    chatId,
    ts: Date.now(),
    type: input.type,
    payload: input.payload,
    ...(input.runId ? { runId: input.runId } : {}),
  } as ServerEvent;
  sendRaw(ws, event);
}

function pushPayloadFor(event: ServerEvent): PushPayload | null {
  switch (event.type) {
    case 'assistant_message': {
      const text = event.payload.text.replace(/\s+/g, ' ').trim();
      return { title: 'J-Rex', body: text.length > 180 ? `${text.slice(0, 180)}…` : text || '…' };
    }
    case 'file':
      return { title: 'J-Rex', body: `Sent a file: ${event.payload.name}` };
    case 'voice':
      return { title: 'J-Rex', body: 'Sent a voice note' };
    case 'menu':
      return { title: 'J-Rex', body: event.payload.text || 'Choose an option' };
    default:
      return null;
  }
}

/** Core emit: envelope, broadcast live, persist if durable, push if unseen. */
export function emit(chatId: string, input: ServerEventInput): ServerEvent {
  const runId = input.runId ?? activeRun.get(chatId);
  const event = {
    seq: nextSeq(),
    chatId,
    ts: Date.now(),
    type: input.type,
    payload: input.payload,
    ...(runId ? { runId } : {}),
  } as ServerEvent;

  for (const conn of clientsFor(chatId)) sendRaw(conn.ws, event);

  if (isDurable(event.type)) historyAppend(event);

  if (isPushWorthy(event.type) && !hasVisibleClient(chatId)) {
    const payload = pushPayloadFor(event);
    if (payload) void sendPush(chatId, payload);
  }

  return event;
}

export function notice(chatId: string, text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  emit(chatId, { type: 'notice', payload: { text, level } });
}

export function error(chatId: string, message: string): void {
  emit(chatId, { type: 'error', payload: { message } });
}

export function modelChanged(chatId: string, model: string): void {
  emit(chatId, { type: 'model_changed', payload: { model } });
}

export function runStart(chatId: string, runId: string, source: string): void {
  activeRun.set(chatId, runId);
  emit(chatId, { type: 'run_start', payload: { source }, runId });
}

export function runEnd(chatId: string, runId: string, source: string): void {
  emit(chatId, { type: 'run_end', payload: { source }, runId });
  if (activeRun.get(chatId) === runId) activeRun.delete(chatId);
}

/** Maps a normalized Pi stream event onto the protocol and emits it. */
export function stream(chatId: string, runId: string, ev: PiStreamEvent): void {
  switch (ev.kind) {
    case 'text_delta':
      emit(chatId, { type: 'assistant_delta', payload: { text: ev.text }, runId });
      return;
    case 'thinking_delta':
      emit(chatId, { type: 'thinking_delta', payload: { text: ev.text }, runId });
      return;
    case 'tool_start':
      emit(chatId, {
        type: 'tool_start',
        payload: { toolCallId: ev.toolCallId, name: ev.name, label: ev.label, args: ev.args },
        runId,
      });
      return;
    case 'tool_update':
      emit(chatId, {
        type: 'tool_update',
        payload: { toolCallId: ev.toolCallId, partial: ev.partial },
        runId,
      });
      return;
    case 'tool_end':
      emit(chatId, {
        type: 'tool_record',
        payload: {
          toolCallId: ev.toolCallId,
          name: ev.name,
          label: ev.label,
          args: ev.args,
          result: ev.result,
          isError: ev.isError,
        },
        runId,
      });
      return;
  }
}

/** Background sources are final-only: persist tool records but skip live deltas. */
export function streamBackground(chatId: string, runId: string, ev: PiStreamEvent): void {
  if (ev.kind === 'tool_end') stream(chatId, runId, ev);
}
