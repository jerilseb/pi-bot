import type { CallbackMenu } from './callback-menu.ts';
import { setShowTranscripts, showTranscriptsEnabled } from './config.ts';
import type { InlineKeyboardButton } from './telegram.ts';

const TRANSCRIPT_CALLBACK_PREFIX = 'transcripts:';

export function describeTranscriptSetting(enabled: boolean): string {
  return enabled ? 'On — send the transcript back' : 'Off — transcript stays internal';
}

export function buildTranscriptInlineKeyboard(): InlineKeyboardButton[][] {
  return [
    [{ text: describeTranscriptSetting(true), callback_data: `${TRANSCRIPT_CALLBACK_PREFIX}on` }],
    [{ text: describeTranscriptSetting(false), callback_data: `${TRANSCRIPT_CALLBACK_PREFIX}off` }],
    [{ text: 'Cancel', callback_data: `${TRANSCRIPT_CALLBACK_PREFIX}cancel` }],
  ];
}

/**
 * The /transcripts keyboard. The setting is read afresh for every voice note,
 * so a switch here applies from the next voice note on and never needs a
 * restart, and it is safe while the chat is busy.
 */
export const transcriptCallbackMenu: CallbackMenu = {
  prefix: TRANSCRIPT_CALLBACK_PREFIX,
  cancelText: 'Kept the current transcript setting.',
  unknownOptionText: '❌ That option is no longer available. Use /transcripts again.',
  failureToast: 'Could not save the setting.',
  async select(value) {
    if (value !== 'on' && value !== 'off') return null;

    setShowTranscripts(value === 'on');
    return {
      toast: 'Setting saved.',
      text: `✅ Voice transcripts: ${describeTranscriptSetting(showTranscriptsEnabled())}.`,
    };
  },
};
