import { type PiRuntime, SdkPiSession } from './pi-session.ts';
import type { IncomingPrompt } from './types.ts';

export interface ChatState {
  queue: IncomingPrompt[];
  processing: boolean;
  pi: SdkPiSession;
  messageCount: number;
  startedAt: number;
}

/**
 * Holds the single chat's state for one Pi runtime. The bot serves exactly one
 * Telegram chat (TELEGRAM_ALLOWED_CHAT_ID), so this is a lazily created
 * singleton rather than a registry. State stays loaded until explicitly cleared;
 * elapsed time must never dispose a session that may still be doing work.
 */
export interface ChatSession {
  /** Returns the chat's state, creating a Pi session on first use. */
  get(): ChatState;
  /** Returns the chat's state only if it has already been created. */
  existing(): ChatState | null;
  /** True while a prompt is being processed or queued. */
  isBusy(): boolean;
  /** Disposes the session and forgets the tracked state. */
  clear(): void;
}

export function createChatSession(runtime: PiRuntime): ChatSession {
  let chat: ChatState | null = null;

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
      return chat;
    },

    existing(): ChatState | null {
      return chat;
    },

    isBusy(): boolean {
      return Boolean(chat?.processing || (chat?.queue.length ?? 0) > 0);
    },

    clear(): void {
      if (!chat) return;
      chat.pi.cleanup();
      chat = null;
    },
  };
}
