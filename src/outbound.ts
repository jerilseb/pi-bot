import { CRON_NOOP, HEARTBEAT_NOOP } from "./config.ts";
import { sendTelegramMessage } from "./telegram.ts";
import type { PiPromptResult } from "./types.ts";

export async function sendPiResponse(
	chatId: string,
	response: PiPromptResult,
	options: { suppressNoop?: boolean } = {},
): Promise<void> {
	if (options.suppressNoop && isNoopResponse(response.text)) {
		console.log(`[${chatId}] background task completed with no user-visible update`);
		return;
	}

	await sendTelegramMessage(chatId, response.text);
}

function isNoopResponse(text: string): boolean {
	const normalized = text
		.trim()
		.replace(/^```(?:text)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();

	return (
		normalized.includes(HEARTBEAT_NOOP) ||
		normalized.includes(CRON_NOOP) ||
		normalized.includes("HEARTBEAT_NOOP") ||
		normalized.includes("CRON_NOOP")
	);
}
