import { isAllowedTelegramChat, setShowTranscripts, showTranscriptsEnabled } from './config.ts';
import {
  answerTelegramCallbackQuery,
  editTelegramMessageText,
  type InlineKeyboardButton,
  sanitizeError,
} from './telegram.ts';
import type { TelegramCallbackQuery } from './types.ts';
import { errorMessage } from './util.ts';

const TRANSCRIPT_CALLBACK_PREFIX = 'transcripts:';
const TRANSCRIPT_CALLBACK_ON = `${TRANSCRIPT_CALLBACK_PREFIX}on`;
const TRANSCRIPT_CALLBACK_OFF = `${TRANSCRIPT_CALLBACK_PREFIX}off`;
const TRANSCRIPT_CALLBACK_CANCEL = `${TRANSCRIPT_CALLBACK_PREFIX}cancel`;

export function describeTranscriptSetting(enabled: boolean): string {
  return enabled ? 'On — send the transcript back' : 'Off — transcript stays internal';
}

export function buildTranscriptInlineKeyboard(): InlineKeyboardButton[][] {
  return [
    [{ text: 'On — send the transcript back', callback_data: TRANSCRIPT_CALLBACK_ON }],
    [{ text: 'Off — transcript stays internal', callback_data: TRANSCRIPT_CALLBACK_OFF }],
    [{ text: 'Cancel', callback_data: TRANSCRIPT_CALLBACK_CANCEL }],
  ];
}

/**
 * The setting is read afresh for every voice note, so a switch here applies
 * from the next voice note on and never needs a restart.
 */
export async function handleTranscriptCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const data = query.data ?? '';
  if (!data.startsWith(TRANSCRIPT_CALLBACK_PREFIX)) return;

  if (!query.message || !isAllowedTelegramChat(String(query.message.chat.id))) {
    await answerTelegramCallbackQuery(query.id, 'This menu is no longer valid.');
    return;
  }

  if (data === TRANSCRIPT_CALLBACK_CANCEL) {
    await answerTelegramCallbackQuery(query.id, 'Cancelled');
    await editTelegramMessageText(query.message.message_id, 'Kept the current transcript setting.');
    return;
  }

  if (data !== TRANSCRIPT_CALLBACK_ON && data !== TRANSCRIPT_CALLBACK_OFF) {
    await answerTelegramCallbackQuery(query.id, 'Unknown option.');
    await editTelegramMessageText(
      query.message.message_id,
      '❌ That option is no longer available. Use /transcripts again.',
    );
    return;
  }

  try {
    setShowTranscripts(data === TRANSCRIPT_CALLBACK_ON);
    await answerTelegramCallbackQuery(query.id, 'Setting saved.');
    await editTelegramMessageText(
      query.message.message_id,
      `✅ Voice transcripts: ${describeTranscriptSetting(showTranscriptsEnabled())}.`,
    );
  } catch (error) {
    await answerTelegramCallbackQuery(query.id, 'Could not save the setting.');
    await editTelegramMessageText(
      query.message.message_id,
      `❌ ${sanitizeError(errorMessage(error))}`,
    );
  }
}
