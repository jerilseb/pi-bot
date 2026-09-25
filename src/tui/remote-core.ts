import type { Duplex } from 'node:stream';
import { encodeLine, JsonlDecoder } from '../channels/socket/jsonl.ts';
import {
  type ClientReceipt,
  type ClientRequest,
  PROTOCOL_VERSION,
  parseServerMessage,
  type RequestResults,
  type ServerMessage,
  type Welcome,
} from '../channels/socket/protocol.ts';
import { TUI_RECONNECT_MAX_MS, TUI_RECONNECT_MIN_MS } from '../config.ts';
import type {
  AgentCore,
  Channel,
  ChannelRef,
  ChoiceOutcome,
  CommandInfo,
  CoreSnapshot,
  IngestionTicket,
  JobStopOutcome,
  Receipt,
  SubmitResult,
  UserInput,
} from '../contract.ts';
import { errorMessage } from '../util.ts';

/**
 * The agent core as a terminal UI client reaches it: AgentCore over the bot's
 * socket (src/channels/socket/protocol.ts), so the terminal is written
 * against the same interface as Telegram.
 *
 * It attaches one channel, the terminal, and keeps it connected: it says
 * hello on every connection, hands the welcome (the channel's ref and a
 * snapshot of the chat) to `onConnect` before any event of that connection,
 * and reconnects with a doubling backoff whenever the bot goes away, which
 * carries the terminal across a /restart. A call made while disconnected
 * fails at once rather than waiting for the bot to come back.
 */

export interface RemoteCoreOptions {
  /** Opens a connection to the bot: its socket, or a test's stream. */
  connect: () => Promise<Duplex>;
  /** Each connection's welcome, before any of its events reach the channel. */
  onConnect?: (welcome: Welcome) => void;
  /** A connection ended, or could not be made; the next try is in `retryInMs`. */
  onDisconnect?: (reason: string, retryInMs: number) => void;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export class RemoteCore implements AgentCore {
  private readonly options: RemoteCoreOptions;
  private channel: Channel | null = null;
  private connection: Connection | null = null;
  private welcome: Welcome | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(options: RemoteCoreOptions) {
    this.options = options;
  }

  /** The channel the bot has attached this client as, while connected. */
  get ref(): ChannelRef | null {
    return this.connection ? (this.welcome?.ref ?? null) : null;
  }

  get connected(): boolean {
    return this.ref !== null;
  }

  submit(input: UserInput): Promise<SubmitResult> {
    return this.request({
      type: 'submit',
      text: input.text,
      attachments: input.attachments,
      ...(input.ticket ? { ticket: input.ticket } : {}),
    });
  }

  /** The bot answers as this client's channel, whatever `from` says; so for every call. */
  command(line: string, _from?: ChannelRef): Promise<boolean> {
    return this.request({ type: 'command', line });
  }

  /** As the bot listed them in its last welcome; the core's first, then the channel's own. */
  commands(_from?: ChannelRef): CommandInfo[] {
    return this.welcome?.commands ?? [...(this.channel?.commands ?? [])];
  }

  choose(choiceId: string, option: number | 'cancel', _from?: ChannelRef): Promise<ChoiceOutcome> {
    return this.request({ type: 'choose', choiceId, option });
  }

  stopJob(jobId: string, task: number | undefined, _from?: ChannelRef): Promise<JobStopOutcome> {
    return this.request({ type: 'stopJob', jobId, ...(task !== undefined ? { task } : {}) });
  }

  beginIngestion(): Promise<IngestionTicket> {
    return this.request({ type: 'beginIngestion' });
  }

  snapshot(): Promise<CoreSnapshot> {
    return this.request({ type: 'snapshot' });
  }

  /** Connects, and keeps reconnecting, until detached. Only one channel at a time. */
  attach(channel: Channel): () => void {
    if (this.channel) throw new Error('RemoteCore already has a channel attached');
    this.channel = channel;
    void this.run(channel);
    return () => {
      this.stopped = true;
      this.connection?.close('detached');
      this.wake?.();
    };
  }

  private request<T extends ClientRequest['type']>(
    request: Extract<ClientRequest, { type: T }>,
  ): Promise<RequestResults[T]> {
    const connection = this.connection;
    if (!connection || !this.welcome) {
      return Promise.reject(new Error('Not connected to the bot.'));
    }
    return connection.request(request) as Promise<RequestResults[T]>;
  }

  private async run(channel: Channel): Promise<void> {
    const min = this.options.reconnectMinMs ?? TUI_RECONNECT_MIN_MS;
    const max = this.options.reconnectMaxMs ?? TUI_RECONNECT_MAX_MS;
    let delay = min;
    while (!this.stopped) {
      const reason = await this.connectOnce(channel).catch((error: unknown) => errorMessage(error));
      if (this.stopped) return;
      if (this.welcome === null) delay = Math.min(delay * 2, max);
      else delay = min;
      this.welcome = null;
      this.options.onDisconnect?.(reason, delay);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** One connection, from hello until it ends. Returns why it ended. */
  private async connectOnce(channel: Channel): Promise<string> {
    const stream = await this.options.connect();
    const connection = new Connection(stream, channel);
    this.connection = connection;
    try {
      const welcome = (await connection.request({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        caps: channel.caps,
        commands: [...(channel.commands ?? [])],
      })) as Welcome;
      this.welcome = welcome;
      this.options.onConnect?.(welcome);
      connection.startDispatch();
    } catch (error) {
      connection.close(errorMessage(error));
    }
    const reason = await connection.closed;
    if (this.connection === connection) this.connection = null;
    return reason;
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * One connection's framing and bookkeeping: requests matched to their
 * responses by ID, events and deliveries passed to the channel in order once
 * dispatch starts, and a receipt sent back for every delivery.
 */
class Connection {
  readonly closed: Promise<string>;
  private readonly stream: Duplex;
  private readonly channel: Channel;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private done = false;
  private resolveClosed!: (reason: string) => void;
  /** Events and deliveries that arrived before the welcome was handled. */
  private backlog: Array<Exclude<ServerMessage, { type: 'response' }>> | null = [];

  constructor(stream: Duplex, channel: Channel) {
    this.stream = stream;
    this.channel = channel;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    const decoder = new JsonlDecoder(
      (record) => this.receive(record),
      (error) => this.close(`the bot sent ${error.message}`),
    );
    stream.on('data', (chunk: Buffer) => decoder.push(chunk));
    stream.on('end', () => {
      decoder.end();
      this.close('the bot closed the connection');
    });
    stream.on('error', (error) => this.close(errorMessage(error)));
    stream.on('close', () => this.close('the connection closed'));
  }

  request(request: ClientRequest): Promise<unknown> {
    if (this.done) return Promise.reject(new Error('Not connected to the bot.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, ...request });
    });
  }

  /** From now on events and deliveries go to the channel, starting with any that waited. */
  startDispatch(): void {
    const backlog = this.backlog ?? [];
    this.backlog = null;
    for (const message of backlog) this.dispatch(message);
  }

  close(reason: string): void {
    if (this.done) return;
    this.done = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error(`Lost the connection to the bot: ${reason}`));
    }
    this.stream.destroy();
    this.resolveClosed(reason);
  }

  private receive(record: unknown): void {
    const message = parseServerMessage(record);
    if (!message) {
      this.close('the bot sent a malformed message');
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
      return;
    }
    if (this.backlog) this.backlog.push(message);
    else this.dispatch(message);
  }

  private dispatch(message: Exclude<ServerMessage, { type: 'response' }>): void {
    if (message.type === 'event') {
      try {
        this.channel.onEvent(message.event);
      } catch (error) {
        console.error(`failed to show a ${message.event.type} event:`, errorMessage(error));
      }
      return;
    }
    void this.receipt(message.id, () => this.channel.deliver(message.item));
  }

  private async receipt(id: number, deliver: () => Promise<Receipt>): Promise<void> {
    let receipt: ClientReceipt;
    try {
      const { ok, error, skipped } = await deliver();
      receipt = {
        type: 'receipt',
        id,
        ok,
        ...(error !== undefined ? { error } : {}),
        ...(skipped ? { skipped } : {}),
      };
    } catch (error) {
      receipt = { type: 'receipt', id, ok: false, error: errorMessage(error) };
    }
    this.write(receipt);
  }

  private write(message: unknown): void {
    if (this.done) return;
    this.stream.write(encodeLine(message));
  }
}
