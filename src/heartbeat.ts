import {
	ALLOWED_CHAT_ID,
	HEARTBEAT_ENABLED,
	HEARTBEAT_FILE_PATH,
	HEARTBEAT_INTERVAL_MS,
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

			const chatId = ALLOWED_CHAT_ID;

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
			? `${Math.round(HEARTBEAT_INTERVAL_MS / 1000)}s (${HEARTBEAT_FILE_PATH})`
			: "off"
	}`;
}
