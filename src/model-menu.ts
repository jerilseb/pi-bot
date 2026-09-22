import type { CallbackMenu } from './callback-menu.ts';
import type { ChatSession } from './chat-session.ts';
import { ALLOWED_MODELS } from './config.ts';
import type { InlineKeyboardButton } from './telegram.ts';

const MODEL_CALLBACK_PREFIX = 'model:';

export function buildModelInlineKeyboard(): InlineKeyboardButton[][] {
  return [
    ...ALLOWED_MODELS.map((model, index) => [
      { text: model, callback_data: `${MODEL_CALLBACK_PREFIX}${index}` },
    ]),
    [{ text: 'Cancel', callback_data: `${MODEL_CALLBACK_PREFIX}cancel` }],
  ];
}

/** The /models keyboard. Buttons carry an index into ALLOWED_MODELS. */
export function modelCallbackMenu(session: ChatSession): CallbackMenu {
  return {
    prefix: MODEL_CALLBACK_PREFIX,
    cancelText: 'Cancelled model switch.',
    unknownOptionText: '❌ That model option is no longer available. Use /models again.',
    failureToast: 'Model switch failed.',
    refuse: () =>
      session.isBusy()
        ? {
            toast: 'Chat is busy.',
            text: '⚠️ Model switch cancelled because the chat is busy. Try /models again when idle.',
          }
        : null,
    async select(value) {
      const modelIndex = Number(value);
      const modelName = Number.isInteger(modelIndex) ? ALLOWED_MODELS[modelIndex] : undefined;
      if (!modelName) return null;

      const chat = session.get();
      await chat.pi.setModel(modelName);
      const thinking = await chat.pi.getThinkingState();
      return {
        toast: 'Model switched.',
        text: `✅ Switched chat model to ${chat.pi.modelName}\nReasoning: ${thinking.level}`,
      };
    },
  };
}
