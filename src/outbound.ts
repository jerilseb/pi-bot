import { HEARTBEAT_NOOP } from "./config.ts";
import { sendTelegramMessage } from "./telegram.ts";
import type { PiPromptResult } from "./types.ts";

export async function sendPiResponse(
	chatId: string,
	response: PiPromptResult,
	options: { suppressNoop?: boolean } = {},
): Promise<void> {
	if (options.suppressNoop && isHeartbeatNoop(response.text)) {
		console.log(`[${chatId}] heartbeat completed with no user-visible update`);
		return;
	}

	await sendTelegramMessage(chatId, response.text);
}

function isHeartbeatNoop(text: string): boolean {
	const normalized = text
		.trim()
		.replace(/^```(?:text)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	return normalized === HEARTBEAT_NOOP;
}
