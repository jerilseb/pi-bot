#!/usr/bin/env node

/**
 * The terminal UI: joins the bot's chat from a terminal on the same machine,
 * as a channel of its own beside Telegram. Needs the bot running with
 * ENABLE_TUI=true in .env; see the README.
 *
 *   npm run tui [-- --socket <path>]
 *
 * The socket path defaults to the one the bot listens on (tuiSocketPath in
 * src/config.ts). Everything else is src/tui/.
 */

import * as net from 'node:net';
import type { Duplex } from 'node:stream';

// Before src/config.ts loads .env, so dotenv's banner does not land on the screen.
process.env.DOTENV_CONFIG_QUIET = 'true';
const { tuiSocketPath } = await import('./src/config.ts');
const { initTheme } = await import('@earendil-works/pi-coding-agent');
const { ProcessTerminal } = await import('@earendil-works/pi-tui');
const { TerminalApp } = await import('./src/tui/app.ts');

const socketPath = socketArgument() ?? tuiSocketPath();

initTheme();
const app = new TerminalApp({
  terminal: new ProcessTerminal(),
  connect: () => connect(socketPath),
  cwd: process.cwd(),
  onQuit: () => {
    app.stop();
    process.exit(0);
  },
});
app.start();

function connect(target: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? new Error(
              `the bot is not listening on ${target} (is ENABLE_TUI=true, and is it running?)`,
            )
          : error,
      );
    });
  });
}

function socketArgument(): string | null {
  const index = process.argv.indexOf('--socket');
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}
