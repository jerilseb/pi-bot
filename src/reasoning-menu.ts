import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { CallbackMenu } from './callback-menu.ts';
import type { ChatSession } from './chat-session.ts';
import type { InlineKeyboardButton } from './channels/telegram/telegram.ts';

const REASONING_CALLBACK_PREFIX = 'reasoning:';
const HIDDEN_REASONING_LEVELS = new Set<ThinkingLevel>(['off', 'minimal']);

function selectableReasoningLevels(levels: ThinkingLevel[]): ThinkingLevel[] {
  return levels.filter((level) => !HIDDEN_REASONING_LEVELS.has(level));
}

export function buildReasoningInlineKeyboard(levels: ThinkingLevel[]): InlineKeyboardButton[][] {
  return [
    ...selectableReasoningLevels(levels).map((level) => [
      { text: level, callback_data: `${REASONING_CALLBACK_PREFIX}${level}` },
    ]),
    [{ text: 'Cancel', callback_data: `${REASONING_CALLBACK_PREFIX}cancel` }],
  ];
}

/** The /reasoning keyboard. Buttons carry the level name. */
export function reasoningCallbackMenu(session: ChatSession): CallbackMenu {
  return {
    prefix: REASONING_CALLBACK_PREFIX,
    cancelText: 'Cancelled reasoning switch.',
    unknownOptionText: '❌ That reasoning option is no longer available. Use /reasoning again.',
    failureToast: 'Reasoning switch failed.',
    refuse: () =>
      session.isBusy()
        ? {
            toast: 'Chat is busy.',
            text: '⚠️ Reasoning switch cancelled because the chat is busy. Try /reasoning again when idle.',
          }
        : null,
    async select(value) {
      const requestedLevel = value as ThinkingLevel;
      const chat = session.get();
      const state = await chat.pi.getThinkingState();
      if (!selectableReasoningLevels(state.availableLevels).includes(requestedLevel)) return null;

      const effectiveLevel = await chat.pi.setThinkingLevel(requestedLevel);
      return {
        toast: 'Reasoning level switched.',
        text: `✅ Switched reasoning level to ${effectiveLevel}`,
      };
    },
  };
}
