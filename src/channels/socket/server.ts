import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import type { AgentCore } from '../../contract.ts';
import { errorMessage } from '../../util.ts';
import { SocketChannel, type SocketChannelOptions } from './channel.ts';

/**
 * The Unix socket terminal UI clients connect to. Each connection becomes a
 * SocketChannel of its own (`tui:1`, `tui:2`, …), attached to the core once
 * it has said hello and detached when it goes, so several terminals can be
 * open at once and each is a channel like Telegram.
 *
 * The socket lives in a directory only this user can enter, and is itself
 * readable and writable only by them: whoever can connect can talk to the
 * agent. A socket file left by a bot that died is removed on start; one that
 * still answers means another bot is running, and this one does not start.
 */

export interface SocketServerOptions {
  core: AgentCore;
  path: string;
  /** Overrides the channels' timeouts and limits; for tests. */
  channelOptions?: Partial<Omit<SocketChannelOptions, 'core' | 'stream' | 'ref' | 'onClose'>>;
}

export class SocketServer {
  private readonly core: AgentCore;
  private readonly path: string;
  private readonly channelOptions: SocketServerOptions['channelOptions'];
  private readonly channels = new Set<SocketChannel>();
  private server: net.Server | null = null;
  private clients = 0;

  constructor(options: SocketServerOptions) {
    this.core = options.core;
    this.path = options.path;
    this.channelOptions = options.channelOptions;
  }

  /** How many clients are connected, greeted or not. */
  get connected(): number {
    return this.channels.size;
  }

  async start(): Promise<void> {
    preparePrivateDirectory(path.dirname(this.path));
    await removeStaleSocket(this.path);
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (error) => console.error('terminal UI socket failed:', errorMessage(error)));
    fs.chmodSync(this.path, 0o600);
    this.server = server;
  }

  /** Serves one connection; the socket's, or a test's stream. */
  accept(stream: Duplex): SocketChannel {
    const channel: SocketChannel = new SocketChannel({
      ...this.channelOptions,
      core: this.core,
      stream,
      ref: { id: `tui:${++this.clients}`, kind: 'tui' },
      onClose: () => this.channels.delete(channel),
    });
    this.channels.add(channel);
    return channel;
  }

  /** Stops listening, ends every connection, and removes the socket file. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const channel of [...this.channels]) channel.close();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.unlinkSync(this.path);
    } catch {
      // Already gone: net removes it on close on some platforms.
    }
  }
}

/**
 * Creates the socket's directory, private to this user, or checks that an
 * existing one is: a real directory, theirs, and closed to everyone else. Under
 * a shared temp directory someone else could have made it first.
 */
function preparePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} belongs to another user`);
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/** Removes a socket file nothing listens on; throws when something still does. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch {
    return;
  }
  if (!stat.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
  const listening = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (listening) throw new Error(`another bot is already serving the terminal UI at ${socketPath}`);
  fs.unlinkSync(socketPath);
}
