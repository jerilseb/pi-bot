import * as fs from 'node:fs';
import { buildAgentEnvelope } from './agent-envelope.ts';
import {
  ALLOWED_CHAT_ID,
  BOT_SETTINGS_PATH,
  HEARTBEAT_ENABLED,
  HEARTBEAT_FILE_PATH,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_NOOP,
  HEARTBEAT_STATE_PATH,
} from './config.ts';
import type { IncomingPrompt } from './types.ts';

export interface HeartbeatController {
  start(): void;
  stop(): void;
}

export function createHeartbeatController(options: {
  handleIncoming: (prompt: IncomingPrompt) => Promise<void>;
  isChatBusy: () => boolean;
  isRunning: () => boolean;
}): HeartbeatController {
  let timer: ReturnType<typeof setInterval> | null = null;

  const runOnce = async (): Promise<void> => {
    if (!options.isRunning()) return;

    const instructions = readHeartbeatInstructions();
    if (!instructions) return;

    if (options.isChatBusy()) {
      console.log('heartbeat skipped; chat is busy');
      return;
    }

    await options.handleIncoming({
      text: buildHeartbeatPrompt(instructions),
      attachments: [],
      source: 'heartbeat',
      suppressNoop: true,
    });
  };

  return {
    start(): void {
      if (!HEARTBEAT_ENABLED || timer || !ALLOWED_CHAT_ID) return;

      console.log(
        `Heartbeat: every ${Math.round(HEARTBEAT_INTERVAL_MS / 1000)}s for chat ${ALLOWED_CHAT_ID}`,
      );
      timer = setInterval(() => void runOnce(), HEARTBEAT_INTERVAL_MS);
    },

    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

export function heartbeatStatusText(): string {
  return `Heartbeat: ${
    HEARTBEAT_ENABLED
      ? `${Math.round(HEARTBEAT_INTERVAL_MS / 1000)}s (${HEARTBEAT_FILE_PATH})`
      : `off (set "heartbeat": true in ${BOT_SETTINGS_PATH})`
  }`;
}

/**
 * Returns the heartbeat file's full trimmed contents, including its
 * `# Heartbeat` heading, or '' when the file is missing or holds nothing but
 * that heading.
 */
function readHeartbeatInstructions(): string {
  if (!fs.existsSync(HEARTBEAT_FILE_PATH)) return '';

  const instructions = fs.readFileSync(HEARTBEAT_FILE_PATH, 'utf8').trim();
  const withoutHeading = instructions.replace(/^#\s*Heartbeat\s*/i, '').trim();
  return withoutHeading ? instructions : '';
}

function buildHeartbeatPrompt(instructions: string): string {
  return buildAgentEnvelope({
    preamble: 'This is a scheduled heartbeat run for the Telegram assistant.',
    meta: [['Heartbeat file', HEARTBEAT_FILE_PATH]],
    sections: [
      {
        intro: 'Read and follow these heartbeat instructions:',
        tag: 'heartbeat_instructions',
        body: instructions,
      },
    ],
    guidance: [
      `If you need durable heartbeat state, create or update ${HEARTBEAT_STATE_PATH}.`,
      'Only notify the Telegram user when there is something important, actionable, or explicitly requested by the heartbeat instructions.',
    ],
    noopSentinel: HEARTBEAT_NOOP,
  });
}
