import {
	ALLOWED_CHAT_IDS,
	HEARTBEAT_CHAT_ID,
	HEARTBEAT_ENABLED,
	HEARTBEAT_FILE_CONFIGURED,
	HEARTBEAT_FILE_PATH,
	HEARTBEAT_INTERVAL_MS,
	LEGACY_HEATBEAT_FILE_PATH,
} from "./config.ts";
import { buildHeartbeatPrompt, readHeartbeatInstructions } from "./resources.ts";
import type { IncomingPrompt } from "./types.ts";

export interface HeartbeatController {
	start(): void;
	stop(): void;
}

export function createHeartbeatController(options: {
	handleIncoming: (prompt: IncomingPrompt) => Promise<void>;
	isChatBusy: (chatId: string) => boolean;
	isRunning: () => boolean;
}): HeartbeatController {
	let timer: ReturnType<typeof setInterval> | null = null;

	const resolveHeartbeatChatId = (): string | null => {
		if (HEARTBEAT_CHAT_ID) return HEARTBEAT_CHAT_ID;
		if (ALLOWED_CHAT_IDS.size === 1) return [...ALLOWED_CHAT_IDS][0];
		return null;
	};

	const runOnce = async (chatId: string): Promise<void> => {
		if (!options.isRunning()) return;

		const { filePath, instructions } = readHeartbeatInstructions();
		if (!instructions) return;

		if (options.isChatBusy(chatId)) {
			console.log(`[${chatId}] heartbeat skipped; chat is busy`);
			return;
		}

		await options.handleIncoming({
			chatId,
			text: buildHeartbeatPrompt(instructions, filePath),
			attachments: [],
			source: "heartbeat",
			suppressNoop: true,
		});
	};

	return {
		start(): void {
			if (!HEARTBEAT_ENABLED || timer) return;

			const chatId = resolveHeartbeatChatId();
			if (!chatId) {
				console.warn(
					"Heartbeat enabled, but no PI_HEARTBEAT_CHAT_ID is set and TELEGRAM_ALLOWED_CHAT_IDS does not contain exactly one chat.",
				);
				return;
			}

			if (ALLOWED_CHAT_IDS.size > 0 && !ALLOWED_CHAT_IDS.has(chatId)) {
				console.warn(
					`Heartbeat disabled because target chat ${chatId} is not in TELEGRAM_ALLOWED_CHAT_IDS.`,
				);
				return;
			}

			console.log(
				`Heartbeat: every ${Math.round(HEARTBEAT_INTERVAL_MS / 1000)}s for chat ${chatId}`,
			);
			timer = setInterval(
				() => void runOnce(chatId),
				HEARTBEAT_INTERVAL_MS,
			);
		},

		stop(): void {
			if (!timer) return;
			clearInterval(timer);
			timer = null;
		},
	};
}

export function heartbeatStatusText(): string {
	return `Heartbeat: ${
		HEARTBEAT_ENABLED
			? `${Math.round(HEARTBEAT_INTERVAL_MS / 1000)}s (${HEARTBEAT_FILE_CONFIGURED ? HEARTBEAT_FILE_PATH : `${HEARTBEAT_FILE_PATH}; fallback ${LEGACY_HEATBEAT_FILE_PATH}`})`
			: "off"
	}`;
}
