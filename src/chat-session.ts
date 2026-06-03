import { IDLE_TIMEOUT_MS } from "./config.ts";
import { type PiRuntime, SdkPiSession } from "./pi-session.ts";
import type { IncomingPrompt } from "./types.ts";

export interface ChatState {
	chatId: string;
	queue: IncomingPrompt[];
	processing: boolean;
	pi: SdkPiSession;
	messageCount: number;
	startedAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}

export interface ChatRegistry {
	/** Returns the chat's state, creating a fresh Pi session on first use. */
	get(chatId: string): ChatState;
	/** Returns the chat's state if it already exists. */
	getExisting(chatId: string): ChatState | null;
	/** True while the chat is processing a prompt or has queued prompts. */
	isBusy(chatId: string): boolean;
	/** (Re)starts the idle timer that disposes an unused session. */
	resetIdleTimer(chat: ChatState): void;
	/** Disposes every session and forgets all tracked chats. */
	clearAll(): void;
}

export function createChatRegistry(runtime: PiRuntime): ChatRegistry {
	const chats = new Map<string, ChatState>();

	const resetIdleTimer = (chat: ChatState): void => {
		if (chat.idleTimer) clearTimeout(chat.idleTimer);
		chat.idleTimer = setTimeout(() => {
			console.log(`[${chat.chatId}] idle timeout; stopping Pi SDK session`);
			chat.pi.cleanup();
			chats.delete(chat.chatId);
		}, IDLE_TIMEOUT_MS);
	};

	return {
		get(chatId): ChatState {
			let chat = chats.get(chatId);
			if (!chat) {
				chat = {
					chatId,
					queue: [],
					processing: false,
					pi: new SdkPiSession(runtime, chatId),
					messageCount: 0,
					startedAt: Date.now(),
				};
				chats.set(chatId, chat);
			}
			resetIdleTimer(chat);
			return chat;
		},

		getExisting(chatId): ChatState | null {
			return chats.get(chatId) ?? null;
		},

		isBusy(chatId): boolean {
			const chat = chats.get(chatId);
			return Boolean(chat?.processing || (chat?.queue.length ?? 0) > 0);
		},

		resetIdleTimer,

		clearAll(): void {
			for (const chat of chats.values()) {
				if (chat.idleTimer) clearTimeout(chat.idleTimer);
				chat.pi.cleanup();
			}
			chats.clear();
		},
	};
}
