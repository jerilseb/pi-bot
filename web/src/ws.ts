import type { ClientMessage, ServerEvent } from './protocol.ts';

type EventHandler = (event: ServerEvent) => void;
type StatusHandler = (connected: boolean) => void;

/** Auto-reconnecting WebSocket client for the chat protocol. */
export class ChatSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private onEvent: EventHandler;
  private onStatus: StatusHandler;
  private reconnectDelay = 1000;
  private closed = false;
  private queue: ClientMessage[] = [];

  constructor(onEvent: EventHandler, onStatus: StatusHandler) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.url = `${proto}://${location.host}/ws`;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectDelay = 1000;
      this.onStatus(true);
      for (const msg of this.queue.splice(0)) this.rawSend(msg);
    });

    ws.addEventListener('message', (ev) => {
      try {
        this.onEvent(JSON.parse(ev.data) as ServerEvent);
      } catch {
        // ignore malformed frame
      }
    });

    ws.addEventListener('close', () => {
      this.onStatus(false);
      if (this.closed) return;
      setTimeout(() => this.open(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 15000);
    });

    ws.addEventListener('error', () => ws.close());
  }

  private rawSend(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.rawSend(msg);
    else this.queue.push(msg);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
