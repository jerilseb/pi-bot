import * as fs from 'node:fs';
import type { Duplex } from 'node:stream';
import {
  TUI_CLIENT_BUFFER_MAX_BYTES,
  TUI_HISTORY_MAX_MESSAGES,
  TUI_RECEIPT_TIMEOUT_MS,
  TUI_REQUEST_MAX_CHARS,
  TUI_STREAM_COALESCE_MS,
} from '../../config.ts';
import type {
  AgentCore,
  Channel,
  ChannelCaps,
  ChannelRef,
  CommandInfo,
  CoreEvent,
  CoreSnapshot,
  Deliverable,
  Receipt,
  SubmitResult,
} from '../../contract.ts';
import type { Attachment } from '../../types.ts';
import { errorMessage } from '../../util.ts';
import { encodeLine, JsonlDecoder } from './jsonl.ts';
import {
  type ClientMessage,
  type ClientRequest,
  PROTOCOL_VERSION,
  parseClientMessage,
  recentHistory,
  type ServerMessage,
  type Welcome,
  wireEvent,
  wireReplacer,
} from './protocol.ts';

/**
 * One terminal UI client, as a channel of the agent core: the server's half
 * of the connection. It answers the client's requests as calls on the core
 * made by this channel, and forwards every event and delivery to it.
 *
 * The client says what it can do in its hello, and is attached to the core
 * only then. Until the welcome (with its snapshot) has been written, events
 * are held, so the client never hears of something older than the snapshot it
 * is about to be given.
 *
 * A streaming message grows by many small updates, each carrying the whole
 * message so far, and a tool's partial output likewise: those are coalesced
 * to at most one per TUI_STREAM_COALESCE_MS, and flushed ahead of anything
 * else, so order is kept. A client that stops reading is dropped rather than
 * buffered for without end; it reconnects and starts again from a snapshot.
 */

export interface SocketChannelOptions {
  core: AgentCore;
  stream: Duplex;
  ref: ChannelRef;
  /** Called once the connection is gone, whichever side ended it. */
  onClose?: () => void;
  receiptTimeoutMs?: number;
  coalesceMs?: number;
  bufferMaxBytes?: number;
  historyMaxMessages?: number;
}

interface PendingReceipt {
  resolve(receipt: Receipt): void;
  timer: ReturnType<typeof setTimeout>;
}

export class SocketChannel implements Channel {
  readonly ref: ChannelRef;
  /** Until the hello says otherwise: nothing but text, and nothing kept while away. */
  caps: ChannelCaps = { buttons: false, edits: false, files: false, voice: false, durable: false };
  commands: readonly CommandInfo[] = [];

  private readonly core: AgentCore;
  private readonly stream: Duplex;
  private readonly onClose: (() => void) | undefined;
  private readonly receiptTimeoutMs: number;
  private readonly coalesceMs: number;
  private readonly bufferMaxBytes: number;
  private readonly historyMaxMessages: number;
  private readonly decoder: JsonlDecoder;
  private detach: (() => void) | null = null;
  /** Messages held back while the welcome is prepared; null once it is written. */
  private held: ServerMessage[] | null = null;
  private greeted = false;
  private closed = false;
  private nextDeliveryId = 1;
  private readonly receipts = new Map<number, PendingReceipt>();
  /** The latest update of each thing streaming, keyed by what it updates. */
  private readonly streaming = new Map<string, CoreEvent>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Submits run one at a time, so two messages sent in a row reach the chat in that order. */
  private submitting: Promise<unknown> = Promise.resolve();

  constructor(options: SocketChannelOptions) {
    this.core = options.core;
    this.stream = options.stream;
    this.ref = options.ref;
    this.onClose = options.onClose;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? TUI_RECEIPT_TIMEOUT_MS;
    this.coalesceMs = options.coalesceMs ?? TUI_STREAM_COALESCE_MS;
    this.bufferMaxBytes = options.bufferMaxBytes ?? TUI_CLIENT_BUFFER_MAX_BYTES;
    this.historyMaxMessages = options.historyMaxMessages ?? TUI_HISTORY_MAX_MESSAGES;
    this.decoder = new JsonlDecoder(
      (record) => this.receive(record),
      (error) => this.fail(error.message),
      { maxLineLength: TUI_REQUEST_MAX_CHARS },
    );
    this.stream.on('data', (chunk: Buffer) => this.decoder.push(chunk));
    this.stream.on('end', () => {
      this.decoder.end();
      this.close();
    });
    this.stream.on('error', (error) => {
      console.error(`${this.ref.id} connection failed:`, errorMessage(error));
      this.close();
    });
    this.stream.on('close', () => this.close());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onEvent(event: CoreEvent): void {
    if (this.closed) return;
    const key = streamKey(event);
    if (key) {
      // Re-inserted so the map keeps the order the updates last arrived in.
      this.streaming.delete(key);
      this.streaming.set(key, event);
      this.flushTimer ??= setTimeout(() => this.flushStreaming(), this.coalesceMs);
      return;
    }
    this.flushStreaming();
    this.send({ type: 'event', event });
  }

  deliver(item: Deliverable): Promise<Receipt> {
    if (this.closed) return Promise.resolve(this.failedReceipt('disconnected'));
    this.flushStreaming();
    const id = this.nextDeliveryId++;
    return new Promise<Receipt>((resolve) => {
      const timer = setTimeout(() => {
        this.receipts.delete(id);
        resolve(this.failedReceipt('timeout'));
      }, this.receiptTimeoutMs);
      this.receipts.set(id, { resolve, timer });
      this.send({ type: 'deliver', id, item });
    });
  }

  async drain(timeoutMs: number): Promise<void> {
    this.flushStreaming();
    if (this.closed || this.stream.writableLength === 0) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.stream.off('drain', done);
        this.stream.off('close', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.stream.on('drain', done);
      this.stream.on('close', done);
    });
  }

  /** Ends the connection and detaches from the core. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.streaming.clear();
    this.detach?.();
    this.detach = null;
    for (const [id, pending] of this.receipts) {
      clearTimeout(pending.timer);
      this.receipts.delete(id);
      pending.resolve(this.failedReceipt('disconnected'));
    }
    this.stream.destroy();
    this.onClose?.();
  }

  private receive(record: unknown): void {
    const message = parseClientMessage(record);
    if (!message) {
      this.fail('malformed message');
      return;
    }
    if (message.type === 'receipt') {
      this.settleReceipt(message);
      return;
    }
    void this.answer(message);
  }

  private async answer(request: ClientRequest & { id: number }): Promise<void> {
    if (request.type === 'hello') {
      await this.greet(request);
      return;
    }
    if (!this.greeted) {
      this.send({ type: 'response', id: request.id, ok: false, error: 'Say hello first.' });
      return;
    }
    try {
      const result = await this.call(request);
      this.send({ type: 'response', id: request.id, ok: true, result });
    } catch (error) {
      this.send({ type: 'response', id: request.id, ok: false, error: errorMessage(error) });
    }
  }

  private async call(request: Exclude<ClientRequest, { type: 'hello' }>): Promise<unknown> {
    switch (request.type) {
      case 'submit': {
        const result = this.submitting.then(() =>
          this.submit(request.text, request.attachments, request.ticket),
        );
        this.submitting = result.catch(() => undefined);
        return result;
      }
      case 'command':
        return this.core.command(request.line, this.ref);
      case 'choose':
        return this.core.choose(request.choiceId, request.option, this.ref);
      case 'stopJob':
        return this.core.stopJob(request.jobId, request.task, this.ref);
      case 'beginIngestion':
        return this.core.beginIngestion();
      case 'snapshot':
        return this.snapshot();
    }
  }

  private async greet(
    hello: Extract<ClientRequest, { type: 'hello' }> & { id: number },
  ): Promise<void> {
    if (this.greeted) {
      this.send({ type: 'response', id: hello.id, ok: false, error: 'Already greeted.' });
      return;
    }
    if (hello.protocol !== PROTOCOL_VERSION) {
      this.send({
        type: 'response',
        id: hello.id,
        ok: false,
        error: `The bot speaks protocol ${PROTOCOL_VERSION}, this client ${hello.protocol}. Update the one that is behind.`,
      });
      this.stream.end();
      return;
    }
    this.greeted = true;
    this.caps = hello.caps;
    this.commands = hello.commands;
    this.held = [];
    try {
      this.detach = this.core.attach(this);
      const welcome: Welcome = {
        ref: this.ref,
        commands: this.core.commands(this.ref),
        snapshot: await this.snapshot(),
      };
      const held = this.held;
      this.held = null;
      this.send({ type: 'response', id: hello.id, ok: true, result: welcome });
      for (const message of held) this.send(message);
    } catch (error) {
      this.held = null;
      this.send({ type: 'response', id: hello.id, ok: false, error: errorMessage(error) });
      this.close();
    }
  }

  private async snapshot(): Promise<CoreSnapshot> {
    const snapshot = await this.core.snapshot();
    return { ...snapshot, history: recentHistory(snapshot.history, this.historyMaxMessages) };
  }

  /** A missing file would only fail the turn later, so it is turned away here. */
  private async submit(
    text: string,
    attachments: Attachment[],
    ticket: { epoch: number } | undefined,
  ): Promise<SubmitResult> {
    const missing = attachments.find((attachment) => !isFile(attachment.path));
    if (missing) {
      return { status: 'rejected', reason: 'error', error: `No such file: ${missing.path}` };
    }
    return this.core.submit({
      from: this.ref,
      text,
      attachments,
      ...(ticket ? { ticket } : {}),
    });
  }

  private settleReceipt(receipt: Extract<ClientMessage, { type: 'receipt' }>): void {
    const pending = this.receipts.get(receipt.id);
    if (!pending) return;
    this.receipts.delete(receipt.id);
    clearTimeout(pending.timer);
    pending.resolve({
      channel: this.ref,
      ok: receipt.ok,
      ...(receipt.error !== undefined ? { error: receipt.error } : {}),
      ...(receipt.skipped ? { skipped: receipt.skipped } : {}),
    });
  }

  private flushStreaming(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const updates = [...this.streaming.values()];
    this.streaming.clear();
    for (const event of updates) this.send({ type: 'event', event });
  }

  private send(message: ServerMessage): void {
    if (this.closed) return;
    if (this.held) {
      this.held.push(message);
      return;
    }
    // Checked before the write, so one large record (a long history) still goes out.
    if (this.stream.writableLength > this.bufferMaxBytes) {
      console.warn(`${this.ref.id} fell too far behind; dropping it`);
      this.close();
      return;
    }
    let line: string;
    try {
      const wire =
        message.type === 'event' ? { ...message, event: wireEvent(message.event) } : message;
      line = encodeLine(wire, wireReplacer);
    } catch (error) {
      console.error(`could not encode a ${message.type} for ${this.ref.id}:`, errorMessage(error));
      return;
    }
    this.stream.write(line);
  }

  private fail(reason: string): void {
    console.warn(`${this.ref.id} sent a ${reason}; closing it`);
    this.close();
  }

  private failedReceipt(error: string): Receipt {
    return { channel: this.ref, ok: false, error };
  }
}

/** What a streaming update updates, so a newer one replaces it; null for anything else. */
function streamKey(event: CoreEvent): string | null {
  if (event.type !== 'agent') return null;
  switch (event.event.type) {
    case 'message_update':
      return `${event.session}:message`;
    case 'tool_execution_update':
      return `${event.session}:tool:${event.event.toolCallId}`;
    default:
      return null;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
