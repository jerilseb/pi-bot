import type { ChatSession } from './chat-session.ts';
import type { ChoiceRegistry, ChoiceSpec } from './choices.ts';
import { ALLOWED_MODELS } from './config.ts';
import type { ChannelRef } from './contract.ts';

/**
 * The /models menu. Its options index into ALLOWED_MODELS and its ID is
 * stable, so a copy from before a restart still switches the model.
 */
const MODEL_CHOICE_ID = 'models';

export function modelChoice(session: ChatSession, audience: 'all' | ChannelRef): ChoiceSpec {
  return {
    id: MODEL_CHOICE_ID,
    text: [`Current chat model: ${session.get().pi.modelName}`, 'Choose a chat model:'].join('\n'),
    options: ALLOWED_MODELS.map((label) => ({ label })),
    cancellable: true,
    cancelText: 'Cancelled model switch.',
    unknownOptionText: '❌ That model option is no longer available. Use /models again.',
    failureToast: 'Model switch failed.',
    audience,
    refuse: () =>
      session.isBusy()
        ? {
            toast: 'Chat is busy.',
            text: '⚠️ Model switch cancelled because the chat is busy. Try /models again when idle.',
          }
        : null,
    async select(index) {
      const modelName = ALLOWED_MODELS[index];
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

export function defineModelChoice(registry: ChoiceRegistry, session: ChatSession): void {
  registry.define(MODEL_CHOICE_ID, (_param, by) => modelChoice(session, by));
}
