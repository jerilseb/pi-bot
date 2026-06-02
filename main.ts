#!/usr/bin/env node

/**
 * Standalone Telegram → Pi chat bridge.
 *
 * Polls Telegram, keeps one Pi SDK session per chat, queues prompts per chat,
 * and sends Pi's final response back to Telegram. Supports text, images,
 * downloaded files, optional audio transcription, local extensions/skills,
 * generated file uploads, model refs across Pi providers, and scheduled heartbeat prompts.
 *
 * This module is the orchestrator: it wires the pieces together and owns the
 * polling loop, per-chat queue, and process lifecycle. Self-contained concerns
 * live in dedicated modules (commands, model-menu, chat-session, maintenance,
 * discovery, system-prompt, env-guard, heartbeat, cron).
 */

import * as fs from "node:fs";
import { createChatRegistry, type ChatState } from "./src/chat-session.ts";
import { handleCommand } from "./src/commands.ts";
import {
	ACTIVE_MODEL_PATH,
	ALLOWED_CHAT_ID,
	ALLOWED_MODELS,
	BOT_TOKEN,
	MAX_QUEUE_PER_CHAT,
	MODEL,
	PROJECT_EXTENSIONS_DIR,
	PROJECT_SKILLS_DIR,
	SEND_TOOL_CALLS,
	TMP_DIR,
	TOOL_CALL_BATCH_MAX_ITEMS,
	TOOL_CALL_BATCH_MS,
	writeActiveModel,
} from "./src/config.ts";
import { createCronController, cronStatusText } from "./src/cron.ts";
import { discoverExtensionPaths, discoverSkillPaths } from "./src/discovery.ts";
import { protectedEnvToolAccessExtension } from "./src/env-guard.ts";
import {
	createHeartbeatController,
	heartbeatStatusText,
} from "./src/heartbeat.ts";
import { toIncomingPrompt } from "./src/inbound.ts";
import { handleModelCallbackQuery } from "./src/model-menu.ts";
import { sendPiResponse } from "./src/outbound.ts";
import { createPiRuntime, type PiRuntime } from "./src/pi-session.ts";
import {
	activeModelSystemPromptExtension,
	ensureMemoryFile,
	memorySystemPromptExtension,
	readSystemPrompt,
} from "./src/system-prompt.ts";
import {
	registerBotCommands,
	sanitizeError,
	sendTelegramMessage,
	startTyping,
	telegram,
} from "./src/telegram.ts";
import type { IncomingPrompt, TelegramUpdate } from "./src/types.ts";
import { errorMessage, isBackgroundSource } from "./src/util.ts";
import { voiceStatusText } from "./src/voice.ts";

validateEnvironment();
writeActiveModel(MODEL);

let EXTENSION_PATHS = discoverExtensionPaths(PROJECT_EXTENSIONS_DIR);
let SKILL_PATHS = discoverSkillPaths(PROJECT_SKILLS_DIR);

const PI_RUNTIME: PiRuntime = createPiRuntime({
	cwd: process.cwd(),
	model: MODEL,
	getExtensionPaths: () => EXTENSION_PATHS,
	getSkillPaths: () => SKILL_PATHS,
	systemPromptOverride: () => readSystemPrompt(),
	extensionFactories: [
		memorySystemPromptExtension,
		activeModelSystemPromptExtension,
		protectedEnvToolAccessExtension,
	],
});

fs.mkdirSync(TMP_DIR, { recursive: true });
ensureMemoryFile();

const chats = createChatRegistry(PI_RUNTIME);
let offset = 0;
let running = true;

interface ToolNotificationBatch {
	notifications: string[];
	timer: ReturnType<typeof setTimeout> | null;
	sending: Promise<void> | null;
}

const toolNotificationBatches = new Map<string, ToolNotificationBatch>();

const heartbeat = createHeartbeatController({
	handleIncoming,
	isChatBusy: chats.isBusy,
	isRunning: () => running,
});

const cron = createCronController({
	handleIncoming,
	isChatBusy: chats.isBusy,
	isRunning: () => running,
});

function validateEnvironment(): void {
	if (!BOT_TOKEN) {
		console.error(
			"Missing TELEGRAM_BOT_TOKEN. Example: TELEGRAM_BOT_TOKEN=123:abc MODEL=openrouter/openai/gpt-5.4-mini node main.ts",
		);
		process.exit(1);
	}

	if (!MODEL) {
		console.error(
			"Missing MODEL. Example: MODEL=openrouter/openai/gpt-5.4-mini",
		);
		process.exit(1);
	}

	if (!ALLOWED_MODELS.includes(MODEL)) {
		console.error(
			`Active model (${MODEL}) must be included in ALLOWED_MODELS. Check ${ACTIVE_MODEL_PATH} or MODEL.`,
		);
		process.exit(1);
	}

	if (!ALLOWED_CHAT_ID) {
		console.error(
			"Missing TELEGRAM_ALLOWED_CHAT_ID. This bot is restricted to exactly one Telegram chat.",
		);
		process.exit(1);
	}
}

/** Re-scans local extensions/skills and resets every chat session. */
function reloadResources(): void {
	EXTENSION_PATHS = discoverExtensionPaths(PROJECT_EXTENSIONS_DIR);
	SKILL_PATHS = discoverSkillPaths(PROJECT_SKILLS_DIR);
	chats.clearAll();
}

/** Shuts the bot down and exits so PM2 brings the process back up. */
async function restart(): Promise<void> {
	await shutdown();
	setTimeout(() => process.exit(0), 250);
}

async function handleIncoming(prompt: IncomingPrompt): Promise<void> {
	const chat = chats.get(prompt.chatId);
	const trimmed = prompt.text.trim();

	if (prompt.attachments.length === 0 && trimmed.startsWith("/")) {
		const handled = await handleCommand(
			{ chat, registry: chats, reloadResources, restart },
			trimmed,
		);
		if (handled) return;
	}

	if (chat.queue.length >= MAX_QUEUE_PER_CHAT) {
		if (!isBackgroundSource(prompt.source)) {
			await sendTelegramMessage(
				prompt.chatId,
				`⚠️ Queue full (${MAX_QUEUE_PER_CHAT} pending). Wait or use /abort.`,
			);
		}
		return;
	}

	chat.queue.push(prompt);
	chat.messageCount++;
	void processQueue(chat);
}

async function processQueue(chat: ChatState): Promise<void> {
	if (chat.processing) return;

	while (chat.queue.length > 0 && running) {
		const prompt = chat.queue.shift();
		if (!prompt) break;
		chat.processing = true;
		chats.resetIdleTimer(chat);

		const typing = isBackgroundSource(prompt.source)
			? { stop: () => undefined }
			: startTyping(prompt.chatId);
		try {
			const logLabel = isBackgroundSource(prompt.source)
				? prompt.source
				: "prompt";
			console.log(
				`[${prompt.chatId}] ${logLabel}: ${prompt.text.slice(0, 120)}`,
			);
			const response = await chat.pi.runPrompt(prompt.text, prompt.attachments, {
				onToolCall: SEND_TOOL_CALLS
					? (notification) =>
							notifyToolCall(prompt.chatId, notification, prompt.source)
					: undefined,
			});
			await flushToolNotifications(prompt.chatId);
			await sendPiResponse(prompt.chatId, response, {
				suppressNoop: prompt.suppressNoop,
			});
			cleanupAttachments(prompt);
		} catch (error) {
			const message = errorMessage(error);
			console.error(`[${prompt.chatId}] error:`, message);
			await flushToolNotifications(prompt.chatId);
			await sendTelegramMessage(prompt.chatId, `❌ ${sanitizeError(message)}`);
		} finally {
			typing.stop();
			chat.processing = false;
			chats.resetIdleTimer(chat);
		}
	}
}

/** Best-effort removal of temp downloads created for this prompt. */
function cleanupAttachments(prompt: IncomingPrompt): void {
	for (const attachment of prompt.attachments) {
		if (attachment.path?.startsWith(TMP_DIR)) {
			try {
				fs.unlinkSync(attachment.path);
			} catch {
				// Best-effort cleanup.
			}
		}
	}
}

async function pollTelegram(): Promise<void> {
	logStartupBanner();

	await registerBotCommands();
	heartbeat.start();
	cron.start();
	await notifyAppStarted();

	while (running) {
		try {
			const params = new URLSearchParams({
				offset: String(offset),
				timeout: "30",
				allowed_updates: JSON.stringify(["message", "callback_query"]),
			});
			const data = await telegram<{ ok: boolean; result: TelegramUpdate[] }>(
				`getUpdates?${params}`,
			);
			if (!data.ok) continue;

			for (const update of data.result) {
				offset = update.update_id + 1;

				if (update.callback_query) {
					await handleModelCallbackQuery(update.callback_query, chats);
					continue;
				}

				if (!update.message) continue;

				const incoming = await toIncomingPrompt(update.message);
				if (incoming) void handleIncoming(incoming);
			}
		} catch (error) {
			if (!running) break;
			console.error("Polling error:", errorMessage(error));
			await sleep(5000);
		}
	}
}

function logStartupBanner(): void {
	console.log("Telegram → Pi bridge started");
	console.log(`Allowed chat: ${ALLOWED_CHAT_ID}`);
	console.log(`Model: ${PI_RUNTIME.modelName}`);
	console.log("Pi runtime: SDK");
	console.log(
		`Extensions: ${EXTENSION_PATHS.length ? EXTENSION_PATHS.join(", ") : "none"}`,
	);
	console.log(`Skills: ${SKILL_PATHS.length ? SKILL_PATHS.join(", ") : "none"}`);
	console.log(`Voice note tool: ${voiceStatusText()}`);
	console.log(`Tool call messages: ${SEND_TOOL_CALLS ? "on" : "off"}`);
	console.log(heartbeatStatusText());
	console.log(cronStatusText());
}

async function notifyAppStarted(): Promise<void> {
	try {
		await sendTelegramMessage(ALLOWED_CHAT_ID, "✅ Bot is up and running.");
	} catch (error) {
		console.error("Failed to send startup notification:", errorMessage(error));
	}
}

function notifyToolCall(
	chatId: string,
	notification: string,
	source: IncomingPrompt["source"],
): void {
	if (isBackgroundSource(source)) return;

	const batch = getToolNotificationBatch(chatId);
	batch.notifications.push(notification);

	if (batch.notifications.length >= TOOL_CALL_BATCH_MAX_ITEMS) {
		void flushToolNotifications(chatId);
		return;
	}

	if (TOOL_CALL_BATCH_MS <= 0) {
		void flushToolNotifications(chatId);
		return;
	}

	batch.timer ??= setTimeout(() => {
		void flushToolNotifications(chatId);
	}, TOOL_CALL_BATCH_MS);
}

function getToolNotificationBatch(chatId: string): ToolNotificationBatch {
	let batch = toolNotificationBatches.get(chatId);
	if (!batch) {
		batch = { notifications: [], timer: null, sending: null };
		toolNotificationBatches.set(chatId, batch);
	}
	return batch;
}

async function flushToolNotifications(chatId: string): Promise<void> {
	const batch = toolNotificationBatches.get(chatId);
	if (!batch) return;

	if (batch.sending) await batch.sending;

	if (batch.timer) {
		clearTimeout(batch.timer);
		batch.timer = null;
	}

	const notifications = batch.notifications.splice(0);
	if (notifications.length === 0) {
		if (!batch.sending) toolNotificationBatches.delete(chatId);
		return;
	}

	batch.sending = sendTelegramMessage(
		chatId,
		formatToolNotificationBatch(notifications),
	)
		.catch((error) => {
			console.error(
				`[${chatId}] failed to send tool notifications:`,
				errorMessage(error),
			);
		})
		.finally(() => {
			batch.sending = null;
			if (batch.notifications.length === 0 && !batch.timer) {
				toolNotificationBatches.delete(chatId);
			}
		});

	await batch.sending;
}

function formatToolNotificationBatch(notifications: string[]): string {
	const compacted = compactAdjacentNotifications(notifications);
	if (compacted.length === 1) return compacted[0];

	const maxDisplay = Math.max(1, TOOL_CALL_BATCH_MAX_ITEMS);
	const visible = compacted.slice(0, maxDisplay);
	const hidden = compacted.length - visible.length;
	return `🧰 ${visible.join(" → ")}${hidden > 0 ? ` → +${hidden} more` : ""}`;
}

function compactAdjacentNotifications(notifications: string[]): string[] {
	const compacted: string[] = [];
	let previous = "";
	let count = 0;

	for (const notification of notifications) {
		if (notification === previous) {
			count++;
			continue;
		}
		pushCompactedNotification(compacted, previous, count);
		previous = notification;
		count = 1;
	}
	pushCompactedNotification(compacted, previous, count);

	return compacted;
}

function pushCompactedNotification(
	compacted: string[],
	notification: string,
	count: number,
): void {
	if (!notification || count <= 0) return;
	compacted.push(count === 1 ? notification : `${notification} ×${count}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(): Promise<void> {
	if (!running) return;
	running = false;
	console.log("Shutting down...");
	heartbeat.stop();
	cron.stop();
	chats.clearAll();
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

await pollTelegram();
