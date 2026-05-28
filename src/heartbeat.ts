import * as fs from "node:fs";
import {
	ALLOWED_CHAT_ID,
	HEARTBEAT_ENABLED,
	HEARTBEAT_FILE_PATH,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_NOOP,
	HEARTBEAT_STATE_PATH,
} from "./config.ts";
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
			timer = setInterval(() => void runOnce(chatId), HEARTBEAT_INTERVAL_MS);
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

function readHeartbeatInstructions(): {
	filePath: string;
	instructions: string;
} {
	if (!fs.existsSync(HEARTBEAT_FILE_PATH)) {
		return { filePath: HEARTBEAT_FILE_PATH, instructions: "" };
	}

	const content = fs.readFileSync(HEARTBEAT_FILE_PATH, "utf8");
	const trimmed = content.trim();
	const body = trimmed.replace(/^#\s*(?:Heartbeat|Heatbeat)\s*/i, "").trim();
	return { filePath: HEARTBEAT_FILE_PATH, instructions: body ? trimmed : "" };
}

function buildHeartbeatPrompt(instructions: string, filePath: string): string {
	return [
		"This is a scheduled heartbeat run for the Telegram assistant.",
		`Heartbeat file: ${filePath}`,
		"",
		"Read and follow these heartbeat instructions:",
		"<heartbeat_instructions>",
		instructions,
		"</heartbeat_instructions>",
		"",
		`If you need durable heartbeat state, create or update ${HEARTBEAT_STATE_PATH}.`,
		"Only notify the Telegram user when there is something important, actionable, or explicitly requested by the heartbeat instructions.",
		`If there is nothing user-visible to report, respond exactly: ${HEARTBEAT_NOOP}`,
	].join("\n");
}
