import {
  isAllowedTelegramChat,
  setToolCallMode,
  TOOL_CALL_MODES,
  type ToolCallMode,
  toolCallMode,
} from './config.ts';
import {
  answerTelegramCallbackQuery,
  editTelegramMessageText,
  type InlineKeyboardButton,
  sanitizeError,
} from './telegram.ts';
import type { TelegramCallbackQuery } from './types.ts';
import { errorMessage } from './util.ts';

const TOOL_CALL_CALLBACK_PREFIX = 'toolcalls:';
const TOOL_CALL_CALLBACK_CANCEL = `${TOOL_CALL_CALLBACK_PREFIX}cancel`;

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
    [{ text: 'Cancel', callback_data: TOOL_CALL_CALLBACK_CANCEL }],
  ];
}

/**
 * The mode is read afresh at the start of every prompt, so a switch here applies
 * from the next prompt on and never needs a restart. That also means it is safe
 * while the chat is busy, unlike the model and reasoning menus.
 */
export async function handleToolCallCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const data = query.data ?? '';
  if (!data.startsWith(TOOL_CALL_CALLBACK_PREFIX)) return;

  if (!query.message || !isAllowedTelegramChat(String(query.message.chat.id))) {
    await answerTelegramCallbackQuery(query.id, 'This tool call menu is no longer valid.');
    return;
  }

  if (data === TOOL_CALL_CALLBACK_CANCEL) {
    await answerTelegramCallbackQuery(query.id, 'Cancelled');
    await editTelegramMessageText(query.message.message_id, 'Kept the current tool call setting.');
    return;
  }

  const selected = data.slice(TOOL_CALL_CALLBACK_PREFIX.length);
  const mode = TOOL_CALL_MODES.find((candidate) => candidate === selected);
  if (!mode) {
    await answerTelegramCallbackQuery(query.id, 'Unknown option.');
    await editTelegramMessageText(
      query.message.message_id,
      '❌ That option is no longer available. Use /toolcalls again.',
    );
    return;
  }

  try {
    setToolCallMode(mode);
    await answerTelegramCallbackQuery(query.id, 'Setting saved.');
    await editTelegramMessageText(
      query.message.message_id,
      `✅ Tool call messages: ${describeToolCallMode(toolCallMode())}\nApplies from the next prompt.`,
    );
  } catch (error) {
    await answerTelegramCallbackQuery(query.id, 'Could not save the setting.');
    await editTelegramMessageText(
      query.message.message_id,
      `❌ ${sanitizeError(errorMessage(error))}`,
    );
  }
}
