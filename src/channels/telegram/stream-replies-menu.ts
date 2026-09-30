import type { CallbackMenu } from './callback-menu.ts';
import { setStreamReplies, streamRepliesEnabled } from '../../config.ts';
import type { InlineKeyboardButton } from './telegram.ts';

const STREAM_REPLIES_CALLBACK_PREFIX = 'streamreplies:';

export function describeStreamRepliesSetting(enabled: boolean): string {
  return enabled ? 'On — show the reply as it is written' : 'Off — send the reply when it is done';
}

export function buildStreamRepliesInlineKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      {
        text: describeStreamRepliesSetting(true),
        callback_data: `${STREAM_REPLIES_CALLBACK_PREFIX}on`,
      },
    ],
    [
      {
        text: describeStreamRepliesSetting(false),
        callback_data: `${STREAM_REPLIES_CALLBACK_PREFIX}off`,
      },
    ],
    [{ text: 'Cancel', callback_data: `${STREAM_REPLIES_CALLBACK_PREFIX}cancel` }],
  ];
}

/**
 * The /stream_replies keyboard. The setting is read at the start of each turn,
 * so a switch here applies from the next reply and never needs a restart, and
 * it is safe while the chat is busy.
 */
export const streamRepliesCallbackMenu: CallbackMenu = {
  prefix: STREAM_REPLIES_CALLBACK_PREFIX,
  cancelText: 'Kept the current reply streaming setting.',
  unknownOptionText: '❌ That option is no longer available. Use /stream_replies again.',
  failureToast: 'Could not save the setting.',
  async select(value) {
    if (value !== 'on' && value !== 'off') return null;

    setStreamReplies(value === 'on');
    return {
      toast: 'Setting saved.',
      text: `✅ Streamed replies: ${describeStreamRepliesSetting(streamRepliesEnabled())}.`,
    };
  },
};
