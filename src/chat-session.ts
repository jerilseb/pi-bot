import { IDLE_TIMEOUT_MS } from './config.ts';
import { type PiRuntime, SdkPiSession } from './pi-session.ts';
import type { IncomingPrompt } from './types.ts';

export interface ChatState {
  queue: IncomingPrompt[];
  processing: boolean;
  pi: SdkPiSession;
  messageCount: number;
  startedAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Holds the single chat's state for one Pi runtime. The bot serves exactly one
 * Telegram chat (TELEGRAM_ALLOWED_CHAT_ID), so this is a lazily created
 * singleton rather than a registry.
 */
export interface ChatSession {
  /** Returns the chat's state, creating a Pi session on first use. */
  get(): ChatState;
  /** Returns the chat's state only if it has already been created. */
  existing(): ChatState | null;
  /** True while a prompt is being processed or queued. */
  isBusy(): boolean;
  /** (Re)starts the idle timer that disposes an unused session. */
  resetIdleTimer(chat: ChatState): void;
  /** Disposes the session and forgets the tracked state. */
  clear(): void;
}

export function createChatSession(runtime: PiRuntime, label: string): ChatSession {
  let chat: ChatState | null = null;

  const resetIdleTimer = (state: ChatState): void => {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      console.log(`idle timeout; stopping ${label} Pi SDK session`);
      state.pi.cleanup();
      if (chat === state) chat = null;
    }, IDLE_TIMEOUT_MS);
  };

  return {
    get(): ChatState {
      if (!chat) {
        chat = {
          queue: [],
          processing: false,
          pi: new SdkPiSession(runtime),
          messageCount: 0,
          startedAt: Date.now(),
        };
      }
      resetIdleTimer(chat);
      return chat;
    },

    existing(): ChatState | null {
      return chat;
    },

    isBusy(): boolean {
      return Boolean(chat?.processing || (chat?.queue.length ?? 0) > 0);
    },

    resetIdleTimer,

    clear(): void {
      if (!chat) return;
      if (chat.idleTimer) clearTimeout(chat.idleTimer);
      chat.pi.cleanup();
      chat = null;
    },
  };
}
