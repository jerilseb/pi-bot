import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ChatRegistry } from './chat-session.ts';
import { isAllowedTelegramChat } from './config.ts';
import {
  answerTelegramCallbackQuery,
  editTelegramMessageText,
  type InlineKeyboardButton,
  sanitizeError,
} from './telegram.ts';
import type { TelegramCallbackQuery } from './types.ts';
import { errorMessage } from './util.ts';

const REASONING_CALLBACK_PREFIX = 'reasoning:';
const REASONING_CALLBACK_CANCEL = `${REASONING_CALLBACK_PREFIX}cancel`;

export function buildReasoningInlineKeyboard(
  levels: ThinkingLevel[],
): InlineKeyboardButton[][] {
  return [
    ...levels.map((level) => [
      { text: level, callback_data: `${REASONING_CALLBACK_PREFIX}${level}` },
    ]),
    [{ text: 'Cancel', callback_data: REASONING_CALLBACK_CANCEL }],
  ];
}

export async function handleReasoningCallbackQuery(
  query: TelegramCallbackQuery,
  registry: ChatRegistry,
): Promise<void> {
  const data = query.data ?? '';
  if (!data.startsWith(REASONING_CALLBACK_PREFIX)) return;

  const chatId = query.message ? String(query.message.chat.id) : '';
  if (!isAllowedTelegramChat(chatId) || !query.message) {
    await answerTelegramCallbackQuery(query.id, 'This reasoning menu is no longer valid.');
    return;
  }

  if (data === REASONING_CALLBACK_CANCEL) {
    await answerTelegramCallbackQuery(query.id, 'Cancelled');
    await editTelegramMessageText(chatId, query.message.message_id, 'Cancelled reasoning switch.');
    return;
  }

  if (registry.isBusy(chatId)) {
    await answerTelegramCallbackQuery(query.id, 'Chat is busy.');
    await editTelegramMessageText(
      chatId,
      query.message.message_id,
      '⚠️ Reasoning switch cancelled because the chat is busy. Try /reasoning again when idle.',
    );
    return;
  }

  const chat = registry.get(chatId);
  const requestedLevel = data.slice(REASONING_CALLBACK_PREFIX.length) as ThinkingLevel;

  try {
    const state = await chat.pi.getThinkingState();
    if (!state.availableLevels.includes(requestedLevel)) {
      await answerTelegramCallbackQuery(query.id, 'Unsupported reasoning level.');
      await editTelegramMessageText(
        chatId,
        query.message.message_id,
        '❌ That reasoning option is no longer available. Use /reasoning again.',
      );
      return;
    }

    const effectiveLevel = await chat.pi.setThinkingLevel(requestedLevel);
    await answerTelegramCallbackQuery(query.id, 'Reasoning level switched.');
    await editTelegramMessageText(
      chatId,
      query.message.message_id,
      `✅ Switched reasoning level to ${effectiveLevel}`,
    );
  } catch (error) {
    await answerTelegramCallbackQuery(query.id, 'Reasoning switch failed.');
    await editTelegramMessageText(
      chatId,
      query.message.message_id,
      `❌ ${sanitizeError(errorMessage(error))}`,
    );
  }
}
