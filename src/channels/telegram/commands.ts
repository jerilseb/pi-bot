import { showTranscriptsEnabled, subagentToolCallsEnabled, toolCallMode } from '../../config.ts';
import type { CommandInfo } from '../../contract.ts';
import {
  buildSubagentToolCallInlineKeyboard,
  describeSubagentToolCallSetting,
} from './subagent-tool-call-menu.ts';
import { sendTelegramInlineKeyboard, sendTelegramMessage } from './telegram.ts';
import { buildToolCallInlineKeyboard, describeToolCallMode } from './tool-call-menu.ts';
import { buildTranscriptInlineKeyboard, describeTranscriptSetting } from './transcript-menu.ts';

/**
 * Telegram's own commands: the conventional /start, and the settings for how
 * Telegram shows things (tool calls, voice transcripts, sub-agent progress).
 * The core lists them with its own, in the command menu and in /help.
 */

export interface TelegramCommand extends CommandInfo {
  handler: () => Promise<void>;
}

export const TELEGRAM_COMMANDS: readonly TelegramCommand[] = [
  {
    name: 'start',
    description: 'Say hi',
    // Conventional Telegram entry point; it carries no information for /help.
    hideFromHelp: true,
    handler: () =>
      sendTelegramMessage("👋 Hi! Send me a message and I'll ask Pi. Use /help for commands."),
  },
  {
    name: 'toolcalls',
    description: 'Choose how tool calls are shown',
    help: 'choose how Pi’s tool calls are shown in the chat',
    handler: () =>
      sendTelegramInlineKeyboard(
        [
          `Current: ${describeToolCallMode(toolCallMode())}`,
          'Choose how tool calls are shown:',
        ].join('\n'),
        buildToolCallInlineKeyboard(),
      ),
  },
  {
    name: 'transcripts',
    description: 'Choose whether voice transcripts are sent back',
    help: 'choose whether a voice note transcript is sent back to the chat',
    handler: () =>
      sendTelegramInlineKeyboard(
        [
          `Current: ${describeTranscriptSetting(showTranscriptsEnabled())}`,
          'Send the voice note transcript back to the chat?',
        ].join('\n'),
        buildTranscriptInlineKeyboard(),
      ),
  },
  {
    name: 'subagent_toolcalls',
    description: 'Choose whether sub-agent progress shows tool calls',
    help: 'choose whether a sub-agent job’s progress message shows each worker’s tool calls, then its result',
    handler: () =>
      sendTelegramInlineKeyboard(
        [
          `Current: ${describeSubagentToolCallSetting(subagentToolCallsEnabled())}`,
          'Show each worker’s tool calls in the sub-agent progress message?',
        ].join('\n'),
        buildSubagentToolCallInlineKeyboard(),
      ),
  },
];
