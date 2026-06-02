import type { ChatRegistry, ChatState } from "./chat-session.ts";
import { HEARTBEAT_ENABLED, SEND_TOOL_CALLS } from "./config.ts";
import { cronStatusText } from "./cron.ts";
import { formatCommandOutput, gitPull } from "./maintenance.ts";
import { buildModelInlineKeyboard } from "./model-menu.ts";
import {
	sendTelegramInlineKeyboard,
	sendTelegramMessage,
} from "./telegram.ts";
import { voiceStatusText } from "./voice.ts";

export interface CommandContext {
	chat: ChatState;
	registry: ChatRegistry;
	/** Re-scans extensions/skills and resets every chat session. */
	reloadResources(): void;
	/** Shuts the bot down and exits so PM2 brings it back up. */
	restart(): Promise<void>;
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

const HELP_TEXT = [
	"Telegram → Pi bridge commands:",
	"/status — show this chat session status",
	"/models — choose an allowed model",
	"/abort — abort the current Pi response",
	"/new — clear this chat's Pi conversation",
	"/reload — re-scan extensions/skills and reset all chats",
	"/update — git pull this repo and restart the app",
	"/restart — exit this process so PM2 can restart it",
	"/help — show this help",
].join("\n");

const COMMANDS: Record<string, CommandHandler> = {
	"/start": async ({ chat }) => {
		await sendTelegramMessage(
			chat.chatId,
			"👋 Hi! Send me a message and I'll ask Pi. Use /help for commands.",
		);
	},

	"/help": async ({ chat }) => {
		await sendTelegramMessage(chat.chatId, HELP_TEXT);
	},

	"/status": async ({ chat }) => {
		const uptimeSeconds = Math.floor((Date.now() - chat.startedAt) / 1000);
		await sendTelegramMessage(
			chat.chatId,
			[
				"Session status:",
				`- State: ${chat.processing ? "processing" : "idle"}`,
				`- Messages: ${chat.messageCount}`,
				`- Queue: ${chat.queue.length}`,
				`- Uptime: ${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`,
				`- Model: ${chat.pi.modelName}`,
				`- Voice note tool: ${voiceStatusText()}`,
				`- Tool call messages: ${SEND_TOOL_CALLS ? "on" : "off"}`,
				`- Heartbeat: ${HEARTBEAT_ENABLED ? "enabled" : "off"}`,
				`- ${cronStatusText()}`,
			].join("\n"),
		);
	},

	"/models": async ({ chat, registry }) => {
		if (registry.isBusy(chat.chatId)) {
			await sendTelegramMessage(
				chat.chatId,
				"⚠️ Wait for the current response and queue to finish before switching models.",
			);
			return;
		}

		await sendTelegramInlineKeyboard(
			chat.chatId,
			[`Current model: ${chat.pi.modelName}`, "Choose a model:"].join("\n"),
			buildModelInlineKeyboard(),
		);
	},

	"/abort": async ({ chat }) => {
		chat.queue.length = 0;
		chat.pi.abort();
		await sendTelegramMessage(
			chat.chatId,
			"⏹ Aborting current prompt and clearing queue...",
		);
	},

	"/new": async ({ chat }) => {
		chat.queue.length = 0;
		chat.processing = false;
		chat.pi.reset();
		chat.messageCount = 0;
		chat.startedAt = Date.now();
		await sendTelegramMessage(
			chat.chatId,
			"🔄 Started a fresh Pi conversation for this chat.",
		);
	},

	"/reload": async ({ chat, reloadResources }) => {
		reloadResources();
		await sendTelegramMessage(
			chat.chatId,
			"🔁 Reloaded extensions and skills. All chats reset.",
		);
	},

	"/update": async ({ chat, restart }) => {
		await sendTelegramMessage(chat.chatId, "⬇️ Pulling latest changes...");
		const result = await gitPull();
		if (!result.ok) {
			await sendTelegramMessage(
				chat.chatId,
				`❌ Update failed:\n${formatCommandOutput(result.output)}`,
			);
			return;
		}

		await sendTelegramMessage(
			chat.chatId,
			`✅ Update complete. Restarting app...\n${formatCommandOutput(result.output)}`,
		);
		await restart();
	},

	"/restart": async ({ chat, restart }) => {
		await sendTelegramMessage(
			chat.chatId,
			"♻️ Restarting bot process. PM2 should bring it back up shortly.",
		);
		await restart();
	},
};

/** Dispatches a leading-slash command. Returns false when none matches. */
export async function handleCommand(
	ctx: CommandContext,
	text: string,
): Promise<boolean> {
	const [commandRaw] = text.split(/\s+/, 1);
	const command = commandRaw.toLowerCase().replace(/@.+$/, "");

	const handler = COMMANDS[command];
	if (!handler) return false;

	await handler(ctx);
	return true;
}
