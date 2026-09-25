import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ChatSession } from './chat-session.ts';
import type { ChoiceRegistry, ChoiceSpec } from './choices.ts';
import type { ChannelRef } from './contract.ts';

/**
 * The /reasoning menu. The levels a model offers differ, so the menu's ID
 * carries the ones it showed (`reasoning.low-medium-high`): a copy from before
 * a restart rebuilds exactly those options, and a level the current model no
 * longer offers is refused rather than mistaken for another.
 */
const REASONING_CHOICE = 'reasoning';
const HIDDEN_REASONING_LEVELS = new Set<ThinkingLevel>(['off', 'minimal']);

export function selectableReasoningLevels(levels: readonly ThinkingLevel[]): ThinkingLevel[] {
  return levels.filter((level) => !HIDDEN_REASONING_LEVELS.has(level));
}

export function reasoningChoice(
  session: ChatSession,
  levels: readonly ThinkingLevel[],
  audience: 'all' | ChannelRef,
  current?: ThinkingLevel,
): ChoiceSpec {
  return {
    id: `${REASONING_CHOICE}.${levels.join('-')}`,
    text: [
      `Current chat model: ${session.get().pi.modelName}`,
      ...(current ? [`Current reasoning: ${current}`] : []),
      'Choose a reasoning level:',
    ].join('\n'),
    options: levels.map((label) => ({ label })),
    cancellable: true,
    cancelText: 'Cancelled reasoning switch.',
    unknownOptionText: '❌ That reasoning option is no longer available. Use /reasoning again.',
    failureToast: 'Reasoning switch failed.',
    audience,
    refuse: () =>
      session.isBusy()
        ? {
            toast: 'Chat is busy.',
            text: '⚠️ Reasoning switch cancelled because the chat is busy. Try /reasoning again when idle.',
          }
        : null,
    async select(index) {
      const requested = levels[index];
      const chat = session.get();
      const state = await chat.pi.getThinkingState();
      if (!requested || !selectableReasoningLevels(state.availableLevels).includes(requested)) {
        return null;
      }
      const effective = await chat.pi.setThinkingLevel(requested);
      return {
        toast: 'Reasoning level switched.',
        text: `✅ Switched reasoning level to ${effective}`,
      };
    },
  };
}

export function defineReasoningChoice(registry: ChoiceRegistry, session: ChatSession): void {
  registry.define(REASONING_CHOICE, (param, by) => {
    const levels = (param ?? '').split('-').filter(Boolean) as ThinkingLevel[];
    return levels.length > 0 ? reasoningChoice(session, levels, by) : null;
  });
}
