import type { CallbackMenu } from './callback-menu.ts';
import { setSubagentToolCalls, subagentToolCallsEnabled } from './config.ts';
import type { InlineKeyboardButton } from './telegram.ts';

const SUBAGENT_TOOL_CALL_CALLBACK_PREFIX = 'subagenttoolcalls:';

export function describeSubagentToolCallSetting(enabled: boolean): string {
  return enabled
    ? 'On — show each worker’s tool calls, then its result'
    : 'Off — one line per task';
}

export function buildSubagentToolCallInlineKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      {
        text: describeSubagentToolCallSetting(true),
        callback_data: `${SUBAGENT_TOOL_CALL_CALLBACK_PREFIX}on`,
      },
    ],
    [
      {
        text: describeSubagentToolCallSetting(false),
        callback_data: `${SUBAGENT_TOOL_CALL_CALLBACK_PREFIX}off`,
      },
    ],
    [{ text: 'Cancel', callback_data: `${SUBAGENT_TOOL_CALL_CALLBACK_PREFIX}cancel` }],
  ];
}

/**
 * The /subagent_toolcalls keyboard. Progress messages read the setting at every
 * render, so a switch here reaches running jobs from their next edit and never
 * needs a restart, and it is safe while the chat is busy.
 */
export const subagentToolCallCallbackMenu: CallbackMenu = {
  prefix: SUBAGENT_TOOL_CALL_CALLBACK_PREFIX,
  cancelText: 'Kept the current sub-agent tool call setting.',
  unknownOptionText: '❌ That option is no longer available. Use /subagent_toolcalls again.',
  failureToast: 'Could not save the setting.',
  async select(value) {
    if (value !== 'on' && value !== 'off') return null;

    setSubagentToolCalls(value === 'on');
    return {
      toast: 'Setting saved.',
      text: `✅ Sub-agent tool calls: ${describeSubagentToolCallSetting(subagentToolCallsEnabled())}.`,
    };
  },
};
