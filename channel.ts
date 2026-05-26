#!/usr/bin/env node

/**
 * Standalone Telegram → Pi chat bridge.
 *
 * Polls Telegram, keeps one Pi SDK session per chat, queues prompts per chat,
 * and sends Pi's final response back to Telegram. Supports text, images,
 * downloaded files, optional audio transcription, local extensions/skills,
 * generated file uploads, and scheduled heartbeat prompts.
 */

import * as fs from "node:fs";
import {
	ALLOWED_CHAT_ID,
	BOT_TOKEN,
	DOCUMENT_UPLOAD_EXTS,
	HEARTBEAT_ENABLED,
	IDLE_TIMEOUT_MS,
	LOCAL_DOCUMENT_UPLOAD_DIRS,
	LOCAL_IMAGE_UPLOAD_DIRS,
	MAX_QUEUE_PER_CHAT,
	OPENROUTER_API_KEY,
	OPENROUTER_MODEL,
	PROJECT_EXTENSIONS_DIR,
	PROJECT_SKILLS_DIR,
	SEND_LOCAL_DOCUMENTS,
	TMP_DIR,
} from "./src/config.ts";
import {
	createHeartbeatController,
	heartbeatStatusText,
} from "./src/heartbeat.ts";
import { toIncomingPrompt } from "./src/inbound.ts";
import { sendPiResponse } from "./src/outbound.ts";
import {
	createPiRuntime,
	type PiRuntime,
	SdkPiSession,
} from "./src/pi-session.ts";
import {
	discoverExtensionPaths,
	discoverSkillPaths,
	ensureMemoryFile,
	memorySystemPromptExtension,
	readSystemPrompt,
} from "./src/resources.ts";
import {
	registerBotCommands,
	sanitizeError,
	sendTelegramMessage,
	startTyping,
	telegram,
} from "./src/telegram.ts";
import type { IncomingPrompt, TelegramUpdate } from "./src/types.ts";
import { voiceNotesConfigured } from "./src/voice.ts";

interface ChatState {
	chatId: string;
	queue: IncomingPrompt[];
	processing: boolean;
	pi: SdkPiSession;
	messageCount: number;
	startedAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}

validateEnvironment();

let EXTENSION_PATHS = discoverExtensionPaths(PROJECT_EXTENSIONS_DIR);
let SKILL_PATHS = discoverSkillPaths(PROJECT_SKILLS_DIR);

const PI_RUNTIME: PiRuntime = createPiRuntime({
	cwd: process.cwd(),
	openRouterApiKey: OPENROUTER_API_KEY,
	openRouterModel: OPENROUTER_MODEL,
	getExtensionPaths: () => EXTENSION_PATHS,
	getSkillPaths: () => SKILL_PATHS,
	systemPromptOverride: () => readSystemPrompt(),
	extensionFactories: [memorySystemPromptExtension],
});

fs.mkdirSync(TMP_DIR, { recursive: true });
ensureMemoryFile();

const chats = new Map<string, ChatState>();
let offset = 0;
let running = true;

const heartbeat = createHeartbeatController({
	handleIncoming,
	isChatBusy: (chatId) => {
		const chat = chats.get(chatId);
		return Boolean(chat?.processing || (chat?.queue.length ?? 0) > 0);
	},
	isRunning: () => running,
});

function validateEnvironment(): void {
	if (!BOT_TOKEN) {
		console.error(
			"Missing TELEGRAM_BOT_TOKEN. Example: TELEGRAM_BOT_TOKEN=123:abc OPENROUTER_API_KEY=sk-or-... OPENROUTER_MODEL=openai/gpt-5.4-mini node channel.ts",
		);
		process.exit(1);
	}

	if (!OPENROUTER_API_KEY) {
		console.error(
			"Missing OPENROUTER_API_KEY. This bridge only uses OpenRouter provider models.",
		);
		process.exit(1);
	}

	if (!OPENROUTER_MODEL) {
		console.error(
			"Missing OPENROUTER_MODEL. Example: OPENROUTER_MODEL=openai/gpt-5.4-mini",
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

function getChat(chatId: string): ChatState {
	let chat = chats.get(chatId);
	if (!chat) {
		chat = {
			chatId,
			queue: [],
			processing: false,
			pi: new SdkPiSession(PI_RUNTIME, chatId),
			messageCount: 0,
			startedAt: Date.now(),
		};
		chats.set(chatId, chat);
	}
	resetIdleTimer(chat);
	return chat;
}

function resetIdleTimer(chat: ChatState): void {
	if (chat.idleTimer) clearTimeout(chat.idleTimer);
	chat.idleTimer = setTimeout(() => {
		console.log(`[${chat.chatId}] idle timeout; stopping Pi SDK session`);
		chat.pi.cleanup();
		chats.delete(chat.chatId);
	}, IDLE_TIMEOUT_MS);
}

async function handleIncoming(prompt: IncomingPrompt): Promise<void> {
	const chat = getChat(prompt.chatId);
	const trimmed = prompt.text.trim();

	if (prompt.attachments.length === 0 && trimmed.startsWith("/")) {
		const handled = await handleCommand(chat, trimmed);
		if (handled) return;
	}

	if (chat.queue.length >= MAX_QUEUE_PER_CHAT) {
		if (prompt.source !== "heartbeat") {
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

async function handleCommand(chat: ChatState, text: string): Promise<boolean> {
	const [commandRaw] = text.split(/\s+/, 1);
	const command = commandRaw.toLowerCase().replace(/@.+$/, "");

	if (command === "/start") {
		await sendTelegramMessage(
			chat.chatId,
			"👋 Hi! Send me a message and I'll ask Pi. Use /help for commands.",
		);
		return true;
	}
	if (command === "/help") {
		await sendTelegramMessage(
			chat.chatId,
			[
				"Telegram → Pi bridge commands:",
				"/status — show this chat session status",
				"/abort — abort the current Pi response",
				"/new — clear this chat's Pi conversation",
				"/reload — re-scan extensions/skills and reset all chats",
				"/help — show this help",
			].join("\n"),
		);
		return true;
	}
	if (command === "/status") {
		const uptimeSeconds = Math.floor((Date.now() - chat.startedAt) / 1000);
		await sendTelegramMessage(
			chat.chatId,
			[
				"Session status:",
				`- State: ${chat.processing ? "processing" : "idle"}`,
				`- Messages: ${chat.messageCount}`,
				`- Queue: ${chat.queue.length}`,
				`- Uptime: ${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`,
				`- Model: openrouter/${PI_RUNTIME.modelName}`,
				`- Voice note tool: ${voiceStatusText()}`,
				`- Heartbeat: ${HEARTBEAT_ENABLED ? "enabled" : "off"}`,
			].join("\n"),
		);
		return true;
	}
	if (command === "/abort") {
		chat.queue.length = 0;
		chat.pi.abort();
		await sendTelegramMessage(
			chat.chatId,
			"⏹ Aborting current prompt and clearing queue...",
		);
		return true;
	}
	if (command === "/new") {
		chat.queue.length = 0;
		chat.processing = false;
		chat.pi.reset();
		chat.messageCount = 0;
		chat.startedAt = Date.now();
		await sendTelegramMessage(
			chat.chatId,
			"🔄 Started a fresh Pi conversation for this chat.",
		);
		return true;
	}
	if (command === "/reload") {
		EXTENSION_PATHS = discoverExtensionPaths(PROJECT_EXTENSIONS_DIR);
		SKILL_PATHS = discoverSkillPaths(PROJECT_SKILLS_DIR);
		for (const existing of chats.values()) {
			if (existing.idleTimer) clearTimeout(existing.idleTimer);
			existing.pi.cleanup();
		}
		chats.clear();
		await sendTelegramMessage(
			chat.chatId,
			"🔁 Reloaded extensions and skills. All chats reset.",
		);
		return true;
	}

	return false;
}

async function processQueue(chat: ChatState): Promise<void> {
	if (chat.processing) return;

	while (chat.queue.length > 0 && running) {
		const prompt = chat.queue.shift();
		if (!prompt) break;
		chat.processing = true;
		resetIdleTimer(chat);

		const typing =
			prompt.source === "heartbeat"
				? { stop: () => undefined }
				: startTyping(prompt.chatId);
		try {
			const logLabel = prompt.source === "heartbeat" ? "heartbeat" : "prompt";
			console.log(
				`[${prompt.chatId}] ${logLabel}: ${prompt.text.slice(0, 120)}`,
			);
			const response = await chat.pi.runPrompt(prompt.text, prompt.attachments);
			await sendPiResponse(prompt.chatId, response, {
				suppressNoop: prompt.suppressNoop,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[${prompt.chatId}] error:`, message);
			await sendTelegramMessage(prompt.chatId, `❌ ${sanitizeError(message)}`);
		} finally {
			typing.stop();
			chat.processing = false;
			resetIdleTimer(chat);
		}
	}
}

async function pollTelegram(): Promise<void> {
	console.log("Telegram → Pi bridge started");
	console.log(`Allowed chat: ${ALLOWED_CHAT_ID}`);
	console.log("Provider: openrouter");
	console.log(`Model: ${PI_RUNTIME.modelName}`);
	console.log("Pi runtime: SDK");
	console.log(
		`Extensions: ${EXTENSION_PATHS.length ? EXTENSION_PATHS.join(", ") : "none"}`,
	);
	console.log(
		`Skills: ${SKILL_PATHS.length ? SKILL_PATHS.join(", ") : "none"}`,
	);
	console.log(`Auto image upload: ${LOCAL_IMAGE_UPLOAD_DIRS.join(", ")}`);
	console.log(
		`Auto document upload: ${
			SEND_LOCAL_DOCUMENTS
				? `${LOCAL_DOCUMENT_UPLOAD_DIRS.join(", ")} [${DOCUMENT_UPLOAD_EXTS.join(", ")}]`
				: "off"
		}`,
	);
	console.log(`Voice note tool: ${voiceStatusText()}`);
	console.log(heartbeatStatusText());

	await registerBotCommands();
	heartbeat.start();

	while (running) {
		try {
			const params = new URLSearchParams({
				offset: String(offset),
				timeout: "30",
				allowed_updates: JSON.stringify(["message"]),
			});
			const data = await telegram<{ ok: boolean; result: TelegramUpdate[] }>(
				`getUpdates?${params}`,
			);
			if (!data.ok) continue;

			for (const update of data.result) {
				offset = update.update_id + 1;
				if (!update.message) continue;

				const incoming = await toIncomingPrompt(update.message);
				if (incoming) void handleIncoming(incoming);
			}
		} catch (error) {
			if (!running) break;
			console.error(
				"Polling error:",
				error instanceof Error ? error.message : String(error),
			);
			await sleep(5000);
		}
	}
}

function voiceStatusText(): string {
	return voiceNotesConfigured()
		? "registered and configured (ElevenLabs)"
		: "registered, but missing ELEVENLABS_API_KEY or ELEVENLABS_TTS_VOICE_ID";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(): Promise<void> {
	if (!running) return;
	running = false;
	console.log("Shutting down...");
	heartbeat.stop();
	for (const chat of chats.values()) {
		if (chat.idleTimer) clearTimeout(chat.idleTimer);
		chat.pi.cleanup();
	}
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

await pollTelegram();
