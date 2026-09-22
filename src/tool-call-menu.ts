import type { CallbackMenu } from './callback-menu.ts';
import { setToolCallMode, TOOL_CALL_MODES, type ToolCallMode, toolCallMode } from './config.ts';
import type { InlineKeyboardButton } from './telegram.ts';

const TOOL_CALL_CALLBACK_PREFIX = 'toolcalls:';

const MODE_LABELS: Record<ToolCallMode, string> = {
  stream: 'Stream — a message per batch',
  collapsed: 'Collapsed — one expandable message per prompt',
  off: 'Off — no tool messages',
};

export function describeToolCallMode(mode: ToolCallMode): string {
  return MODE_LABELS[mode];
}

export function buildToolCallInlineKeyboard(): InlineKeyboardButton[][] {
  return [
    ...TOOL_CALL_MODES.map((mode) => [
      { text: MODE_LABELS[mode], callback_data: `${TOOL_CALL_CALLBACK_PREFIX}${mode}` },
    ]),
    [{ text: 'Cancel', callback_data: `${TOOL_CALL_CALLBACK_PREFIX}cancel` }],
  ];
}

/**
 * The /toolcalls keyboard. The mode is read afresh at the start of every
 * prompt, so a switch here applies from the next prompt on and never needs a
 * restart. That also means it is safe while the chat is busy, unlike the model
 * and reasoning menus.
 */
export const toolCallCallbackMenu: CallbackMenu = {
  prefix: TOOL_CALL_CALLBACK_PREFIX,
  cancelText: 'Kept the current tool call setting.',
  unknownOptionText: '❌ That option is no longer available. Use /toolcalls again.',
  failureToast: 'Could not save the setting.',
  async select(value) {
    const mode = TOOL_CALL_MODES.find((candidate) => candidate === value);
    if (!mode) return null;

    setToolCallMode(mode);
    return {
      toast: 'Setting saved.',
      text: `✅ Tool call messages: ${describeToolCallMode(toolCallMode())}\nApplies from the next prompt.`,
    };
  },
};
