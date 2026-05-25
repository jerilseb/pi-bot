#!/usr/bin/env node

/**
 * Standalone Telegram → Pi chat bridge.
 *
 * This is a small, Telegram-only replacement for the pi-channels extension:
 * - polls Telegram Bot API for incoming messages
 * - keeps one persistent `pi --mode rpc` session per chat
 * - queues messages per chat and sends Pi's final response back to Telegram
 * - supports /start, /help, /status, /abort, /new
 * - supports photos as image attachments and other downloaded files as local paths
 * - optionally transcribes Telegram voice/audio with ElevenLabs Scribe
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=123:abc OPENROUTER_API_KEY=sk-or-... OPENROUTER_MODEL=openai/gpt-5.4-mini node channel.ts
 *
 * Optional env vars:
 *   TELEGRAM_ALLOWED_CHAT_IDS=123,-100456   comma-separated allowlist
 *   PI_CHANNEL_IDLE_TIMEOUT_MINUTES=30
 *   PI_CHANNEL_MAX_QUEUE_PER_CHAT=5
 *   PI_CHANNEL_SEND_LOCAL_IMAGES=true       upload generated image files back to Telegram
 *   PI_CHANNEL_IMAGE_UPLOAD_DIRS=/tmp/create-image  comma-separated allowed local image dirs
 *   PI_CHANNEL_MAX_IMAGE_UPLOADS=4
 *   PI_CHANNEL_SEND_LOCAL_DOCUMENTS=true    upload generated documents (pdf, docx, ...) back to Telegram
 *   PI_CHANNEL_DOCUMENT_UPLOAD_DIRS=/tmp/pi-channel  comma-separated allowed local document dirs
 *   PI_CHANNEL_MAX_DOCUMENT_UPLOADS=4
 *   PI_CHANNEL_DOCUMENT_UPLOAD_EXTS=pdf,doc,docx,xls,xlsx,ppt,pptx,txt,md,csv,json
 *                                           comma-separated extensions (no dot) the model is allowed to upload
 *   FAL_KEY=...                             enables the create-image skill, if present in skills/
 *   ELEVENLABS_API_KEY=...                  enables voice/audio transcription
 *   ElevenLabs transcription is hardcoded to model scribe_v2 and language en.
 */

import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_MODEL = "scribe_v2";
const ELEVENLABS_LANGUAGE = "en";
const ALLOWED_CHAT_IDS = new Set(
	(process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
);
const IDLE_TIMEOUT_MS =
	Number(process.env.PI_CHANNEL_IDLE_TIMEOUT_MINUTES ?? 30) * 60_000;
const MAX_QUEUE_PER_CHAT = Number(
	process.env.PI_CHANNEL_MAX_QUEUE_PER_CHAT ?? 5,
);
const TELEGRAM_API = BOT_TOKEN
	? `https://api.telegram.org/bot${BOT_TOKEN}`
	: "";
const TELEGRAM_FILE_API = BOT_TOKEN
	? `https://api.telegram.org/file/bot${BOT_TOKEN}`
	: "";
const TELEGRAM_MAX_MESSAGE = 4096;
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const TRANSCRIPTION_MAX_FILE_SIZE = 25 * 1024 * 1024;
const TELEGRAM_PHOTO_UPLOAD_LIMIT = 10 * 1024 * 1024;
const TELEGRAM_DOCUMENT_UPLOAD_LIMIT = 50 * 1024 * 1024;
const TMP_DIR = path.join(os.tmpdir(), "pi-channel");
const SEND_LOCAL_IMAGES = !["0", "false", "no", "off"].includes(
	(process.env.PI_CHANNEL_SEND_LOCAL_IMAGES ?? "true").toLowerCase(),
);
const LOCAL_IMAGE_UPLOAD_DIRS = (
	process.env.PI_CHANNEL_IMAGE_UPLOAD_DIRS ??
	path.join(os.tmpdir(), "create-image")
)
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const MAX_IMAGE_UPLOADS = Number(process.env.PI_CHANNEL_MAX_IMAGE_UPLOADS ?? 4);
const SEND_LOCAL_DOCUMENTS = !["0", "false", "no", "off"].includes(
	(process.env.PI_CHANNEL_SEND_LOCAL_DOCUMENTS ?? "true").toLowerCase(),
);
const LOCAL_DOCUMENT_UPLOAD_DIRS = (
	process.env.PI_CHANNEL_DOCUMENT_UPLOAD_DIRS ?? `${path.join(os.tmpdir(), "pi-channel")},${process.cwd()}`
)
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const MAX_DOCUMENT_UPLOADS = Number(
	process.env.PI_CHANNEL_MAX_DOCUMENT_UPLOADS ?? 4,
);
const DOCUMENT_UPLOAD_EXTS = (
	process.env.PI_CHANNEL_DOCUMENT_UPLOAD_EXTS ??
	"pdf,doc,docx,xls,xlsx,ppt,pptx,txt,md,csv,json"
)
	.split(",")
	.map((s) => s.trim().toLowerCase().replace(/^\./, ""))
	.filter(Boolean);
const DOCUMENT_PATH_REGEX = new RegExp(
	`(?:file://)?(?:~|/)[^\\s"'\`<>{}\\[\\]|]+?\\.(?:${DOCUMENT_UPLOAD_EXTS.map(
		(ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	).join("|")})(?=[\\s"'\`<>{}\\[\\]|),.;:!?]|$)`,
	"gi",
);
const EXTENSION_ENTRYPOINT_EXTS = new Set([".ts", ".js", ".mjs", ".cjs"]);
const PROJECT_EXTENSIONS_DIR = path.join(import.meta.dirname, "extensions");
const PROJECT_SKILLS_DIR = path.join(import.meta.dirname, "skills");
const LOCAL_PI_BIN = path.join(
	import.meta.dirname,
	"node_modules",
	".bin",
	process.platform === "win32" ? "pi.cmd" : "pi",
);
const EXTENSION_PATHS = discoverExtensionPaths(PROJECT_EXTENSIONS_DIR);
const SKILL_PATHS = discoverSkillPaths(PROJECT_SKILLS_DIR);

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

interface TelegramMessage {
	message_id: number;
	from?: { id: number; username?: string; first_name?: string };
	chat: { id: number; type: string; title?: string };
	date: number;
	text?: string;
	caption?: string;
	photo?: Array<{
		file_id: string;
		width: number;
		height: number;
		file_size?: number;
	}>;
	document?: {
		file_id: string;
		file_name?: string;
		mime_type?: string;
		file_size?: number;
	};
	voice?: {
		file_id: string;
		duration: number;
		mime_type?: string;
		file_size?: number;
	};
	audio?: {
		file_id: string;
		file_name?: string;
		title?: string;
		mime_type?: string;
		file_size?: number;
	};
	video?: {
		file_id: string;
		file_name?: string;
		mime_type?: string;
		file_size?: number;
	};
}

interface Attachment {
	type: "image" | "file";
	path: string;
	filename?: string;
	mimeType?: string;
	size?: number;
}

interface IncomingPrompt {
	chatId: string;
	text: string;
	attachments: Attachment[];
}

interface ChatState {
	chatId: string;
	queue: IncomingPrompt[];
	processing: boolean;
	rpc: RpcSession;
	messageCount: number;
	startedAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}

interface RpcPromptResult {
	text: string;
	toolOutput: string;
}

interface PendingRpcRequest {
	resolve: (value: RpcPromptResult) => void;
	reject: (error: Error) => void;
	chunks: string[];
	toolOutputs: string[];
}

interface TranscriptionResult {
	ok: boolean;
	text?: string;
	error?: string;
}

function discoverExtensionPaths(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];

	return fs
		.readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			if (entry.name.startsWith(".") || entry.name === "node_modules") return [];

			const entryPath = path.join(directory, entry.name);
			if (entry.isFile()) {
				return EXTENSION_ENTRYPOINT_EXTS.has(
					path.extname(entry.name).toLowerCase(),
				)
					? [entryPath]
					: [];
			}

			if (entry.isDirectory() && isExtensionDirectory(entryPath)) {
				return [entryPath];
			}

			return [];
		})
		.sort((a, b) => a.localeCompare(b));
}

function isExtensionDirectory(directory: string): boolean {
	return ["index.ts", "index.js", "index.mjs", "index.cjs", "package.json"].some(
		(entrypoint) => fs.existsSync(path.join(directory, entrypoint)),
	);
}

function discoverSkillPaths(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];

	const paths: string[] = [];
	const seen = new Set<string>();

	const add = (skillPath: string) => {
		const normalized = path.resolve(skillPath);
		if (seen.has(normalized)) return;
		seen.add(normalized);
		paths.push(normalized);
	};

	const walk = (current: string) => {
		if (fs.existsSync(path.join(current, "SKILL.md"))) {
			add(current);
			return;
		}

		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				walk(entryPath);
				continue;
			}

			if (
				current === directory &&
				entry.isFile() &&
				path.extname(entry.name).toLowerCase() === ".md" &&
				entry.name.toLowerCase() !== "readme.md"
			) {
				add(entryPath);
			}
		}
	};

	walk(directory);
	return paths.sort((a, b) => a.localeCompare(b));
}

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

if (!fs.existsSync(LOCAL_PI_BIN)) {
	console.error(`Local pi binary not found at ${LOCAL_PI_BIN}. Run npm install.`);
	process.exit(1);
}

fs.mkdirSync(TMP_DIR, { recursive: true });

const chats = new Map<string, ChatState>();
let offset = 0;
let running = true;

class RpcSession {
	private child: ChildProcess | null = null;
	private rl: readline.Interface | null = null;
	private pending: PendingRpcRequest | null = null;
	private ready = false;
	private cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async runPrompt(
		text: string,
		attachments: Attachment[],
	): Promise<RpcPromptResult> {
		await this.start();
		if (this.pending)
			throw new Error("RPC session is already processing a prompt");

		return new Promise((resolve, reject) => {
			this.pending = { resolve, reject, chunks: [], toolOutputs: [] };
			this.send({ type: "prompt", ...buildRpcPrompt(text, attachments) });
		});
	}

	abort(): void {
		this.send({ type: "abort" });
	}

	reset(): void {
		this.cleanup();
	}

	cleanup(): void {
		this.ready = false;
		if (this.pending) {
			this.pending.reject(new Error("RPC session stopped"));
			this.pending = null;
		}
		this.rl?.close();
		this.rl = null;
		this.child?.kill("SIGTERM");
		this.child = null;
	}

	private async start(): Promise<void> {
		if (this.ready && this.child?.stdin?.writable) return;

		const args = [
			"--mode",
			"rpc",
			"--no-extensions",
			"--no-skills",
			"--provider",
			"openrouter",
			"--model",
			OPENROUTER_MODEL,
			...EXTENSION_PATHS.flatMap((p) => ["-e", p]),
			...SKILL_PATHS.flatMap((p) => ["--skill", p]),
		];

		this.child = spawn(LOCAL_PI_BIN, args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, OPENROUTER_API_KEY },
		});

		if (!this.child.stdin || !this.child.stdout) {
			throw new Error("Failed to start pi RPC process");
		}

		this.rl = readline.createInterface({ input: this.child.stdout });
		this.rl.on("line", (line) => this.handleLine(line));

		let stderr = "";
		this.child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.length > 8000) stderr = stderr.slice(-8000);
		});

		this.child.on("close", (code) => {
			this.ready = false;
			if (this.pending) {
				const pending = this.pending;
				this.pending = null;
				pending.reject(
					new Error(stderr.trim() || `pi RPC exited with code ${code ?? 1}`),
				);
			}
		});

		this.child.on("error", (error) => {
			this.ready = false;
			if (this.pending) {
				const pending = this.pending;
				this.pending = null;
				pending.reject(error);
			}
		});

		this.ready = true;
	}

	private send(command: Record<string, unknown>): void {
		if (!this.child?.stdin?.writable)
			throw new Error("pi RPC process is not writable");
		this.child.stdin.write(`${JSON.stringify(command)}\n`);
	}

	private handleLine(line: string): void {
		let event: Record<string, any>;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (event.type === "message_update") {
			const delta = event.assistantMessageEvent;
			if (delta?.type === "text_delta" && typeof delta.delta === "string") {
				this.pending?.chunks.push(delta.delta);
			}
			if (delta?.type === "done" && delta.reason === "error" && this.pending) {
				const pending = this.pending;
				this.pending = null;
				pending.reject(
					new Error("Pi agent failed while generating a response"),
				);
			}
		}

		if (event.type === "response" && event.success === false && this.pending) {
			const pending = this.pending;
			this.pending = null;
			pending.reject(new Error(event.error || "Pi rejected the prompt"));
		}

		if (event.type === "tool_execution_end" && this.pending) {
			const output = extractToolResultText(event.result);
			if (output) this.pending.toolOutputs.push(output);
		}

		if (event.type === "agent_end" && this.pending) {
			const pending = this.pending;
			this.pending = null;
			const text = pending.chunks.join("").trim();
			pending.resolve({
				text: text || "(no response)",
				toolOutput: pending.toolOutputs.join("\n"),
			});
		}
	}
}

function buildRpcPrompt(
	text: string,
	attachments: Attachment[],
): {
	message: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
} {
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	const files: string[] = [];

	for (const attachment of attachments) {
		if (attachment.type === "image") {
			images.push({
				type: "image",
				data: fs.readFileSync(attachment.path).toString("base64"),
				mimeType: attachment.mimeType || "image/jpeg",
			});
		} else {
			files.push(
				attachment.filename
					? `${attachment.filename}: ${attachment.path}`
					: attachment.path,
			);
		}
	}

	const filePrefix =
		files.length > 0
			? `[Attached files saved locally]\n${files.map((f) => `- ${f}`).join("\n")}\n\n`
			: "";

	return {
		message: `${filePrefix}${text}`,
		...(images.length > 0 ? { images } : {}),
	};
}

function getChat(chatId: string): ChatState {
	let chat = chats.get(chatId);
	if (!chat) {
		chat = {
			chatId,
			queue: [],
			processing: false,
			rpc: new RpcSession(process.cwd()),
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
		console.log(`[${chat.chatId}] idle timeout; stopping pi RPC session`);
		chat.rpc.cleanup();
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
		await sendTelegramMessage(
			prompt.chatId,
			`⚠️ Queue full (${MAX_QUEUE_PER_CHAT} pending). Wait or use /abort.`,
		);
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
				`- Model: openrouter/${OPENROUTER_MODEL}`,
			].join("\n"),
		);
		return true;
	}
	if (command === "/abort") {
		chat.queue.length = 0;
		chat.rpc.abort();
		await sendTelegramMessage(
			chat.chatId,
			"⏹ Aborting current prompt and clearing queue...",
		);
		return true;
	}
	if (command === "/new") {
		chat.queue.length = 0;
		chat.processing = false;
		chat.rpc.reset();
		chat.messageCount = 0;
		chat.startedAt = Date.now();
		await sendTelegramMessage(
			chat.chatId,
			"🔄 Started a fresh Pi conversation for this chat.",
		);
		return true;
	}

	return false;
}

async function processQueue(chat: ChatState): Promise<void> {
	if (chat.processing) return;

	while (chat.queue.length > 0 && running) {
		const prompt = chat.queue.shift()!;
		chat.processing = true;
		resetIdleTimer(chat);

		const typing = startTyping(prompt.chatId);
		try {
			console.log(`[${prompt.chatId}] prompt: ${prompt.text.slice(0, 120)}`);
			const response = await chat.rpc.runPrompt(
				prompt.text,
				prompt.attachments,
			);
			await sendPiResponse(prompt.chatId, response);
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

function startTyping(chatId: string): { stop(): void } {
	void sendChatAction(chatId);
	const timer = setInterval(() => void sendChatAction(chatId), 4000);
	return { stop: () => clearInterval(timer) };
}

async function pollTelegram(): Promise<void> {
	console.log("Telegram → Pi bridge started");
	console.log(
		`Allowed chats: ${ALLOWED_CHAT_IDS.size ? [...ALLOWED_CHAT_IDS].join(", ") : "all"}`,
	);
	console.log("Provider: openrouter");
	console.log(`Model: ${OPENROUTER_MODEL}`);
	console.log(`Pi binary: ${LOCAL_PI_BIN}`);
	console.log(
		`Extensions: ${EXTENSION_PATHS.length ? EXTENSION_PATHS.join(", ") : "none"}`,
	);
	console.log(`Skills: ${SKILL_PATHS.length ? SKILL_PATHS.join(", ") : "none"}`);
	console.log(
		`Auto image upload: ${
			SEND_LOCAL_IMAGES ? LOCAL_IMAGE_UPLOAD_DIRS.join(", ") : "off"
		}`,
	);
	console.log(
		`Auto document upload: ${
			SEND_LOCAL_DOCUMENTS
				? `${LOCAL_DOCUMENT_UPLOAD_DIRS.join(", ")} [${DOCUMENT_UPLOAD_EXTS.join(", ")}]`
				: "off"
		}`,
	);

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

async function toIncomingPrompt(
	message: TelegramMessage,
): Promise<IncomingPrompt | null> {
	const chatId = String(message.chat.id);
	if (ALLOWED_CHAT_IDS.size > 0 && !ALLOWED_CHAT_IDS.has(chatId)) return null;

	const caption = message.caption?.trim() ?? "";

	if (message.text) {
		return { chatId, text: message.text, attachments: [] };
	}

	if (message.photo?.length) {
		const largest = message.photo[message.photo.length - 1];
		const downloaded = await downloadTelegramFile(
			largest.file_id,
			"photo.jpg",
			largest.file_size,
		);
		if (!downloaded) {
			return {
				chatId,
				text: "⚠️ I could not download that photo.",
				attachments: [],
			};
		}
		return {
			chatId,
			text: caption || "Describe this image.",
			attachments: [
				{
					type: "image",
					path: downloaded.localPath,
					filename: "photo.jpg",
					mimeType: "image/jpeg",
					size: downloaded.size,
				},
			],
		};
	}

	const file =
		message.document ?? message.voice ?? message.audio ?? message.video;
	if (file) {
		const filename = getTelegramFilename(message, file);
		const mimeType = "mime_type" in file ? file.mime_type : undefined;
		const downloaded = await downloadTelegramFile(
			file.file_id,
			filename,
			file.file_size,
		);
		if (!downloaded) {
			return {
				chatId,
				text: `⚠️ I could not download ${filename}.`,
				attachments: [],
			};
		}

		if (isTranscribableAudio(message, mimeType, filename)) {
			void sendChatAction(chatId);
			const transcription = await transcribeWithElevenLabs(
				downloaded.localPath,
			);
			if (transcription.ok && transcription.text) {
				const label = message.voice
					? "🎤 Voice message"
					: `🎵 Audio: ${filename}`;
				const prefix = caption ? `${caption}\n\n` : "";
				return {
					chatId,
					text: `${prefix}${label}: ${transcription.text}`,
					attachments: [],
				};
			}

			const reason = transcription.error
				? ` Transcription failed: ${transcription.error}`
				: " Transcription is not configured.";
			return {
				chatId,
				text: `${caption || `Audio file uploaded: ${filename}.`}${reason}\nLocal file path: ${downloaded.localPath}`,
				attachments: [
					{
						type: "file",
						path: downloaded.localPath,
						filename,
						mimeType,
						size: downloaded.size,
					},
				],
			};
		}

		return {
			chatId,
			text:
				caption ||
				`A file was uploaded: ${filename}. Use the attached local path if you need to inspect it.`,
			attachments: [
				{
					type: "file",
					path: downloaded.localPath,
					filename,
					mimeType,
					size: downloaded.size,
				},
			],
		};
	}

	return null;
}

function getTelegramFilename(
	message: TelegramMessage,
	file: NonNullable<
		| TelegramMessage["document"]
		| TelegramMessage["voice"]
		| TelegramMessage["audio"]
		| TelegramMessage["video"]
	>,
): string {
	if ("file_name" in file && file.file_name) return file.file_name;
	if ("title" in file && file.title) return `${file.title}.mp3`;
	if (message.voice) return "voice.ogg";
	if (message.video) return "video.mp4";
	return "file";
}

function isTranscribableAudio(
	message: TelegramMessage,
	mimeType: string | undefined,
	filename: string,
): boolean {
	if (message.voice || message.audio) return true;
	if (mimeType?.startsWith("audio/")) return true;
	const ext = path.extname(filename).toLowerCase();
	return [
		".mp3",
		".m4a",
		".ogg",
		".oga",
		".wav",
		".webm",
		".flac",
		".aac",
	].includes(ext);
}

async function transcribeWithElevenLabs(
	filePath: string,
): Promise<TranscriptionResult> {
	if (!ELEVENLABS_API_KEY) {
		return {
			ok: false,
			error: "Set ELEVENLABS_API_KEY to enable ElevenLabs transcription.",
		};
	}

	if (!fs.existsSync(filePath))
		return { ok: false, error: `File not found: ${filePath}` };
	const stat = fs.statSync(filePath);
	if (stat.size === 0) return { ok: false, error: "File is empty" };
	if (stat.size > TRANSCRIPTION_MAX_FILE_SIZE) {
		return {
			ok: false,
			error: `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 25MB)`,
		};
	}

	try {
		const form = new FormData();
		const fileBuffer = fs.readFileSync(filePath);
		form.append("file", new Blob([fileBuffer]), path.basename(filePath));
		form.append("model_id", ELEVENLABS_MODEL);
		if (ELEVENLABS_LANGUAGE) form.append("language_code", ELEVENLABS_LANGUAGE);

		const response = await fetch(
			"https://api.elevenlabs.io/v1/speech-to-text",
			{
				method: "POST",
				headers: { "xi-api-key": ELEVENLABS_API_KEY },
				body: form,
			},
		);

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			return {
				ok: false,
				error: `ElevenLabs API error (${response.status}): ${body.slice(0, 200)}`,
			};
		}

		const data = (await response.json()) as { text?: string };
		if (!data.text)
			return { ok: false, error: "ElevenLabs returned empty transcription" };
		return { ok: true, text: data.text };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function downloadTelegramFile(
	fileId: string,
	suggestedName: string,
	knownSize = 0,
): Promise<{ localPath: string; size: number } | null> {
	if (knownSize > TELEGRAM_DOWNLOAD_LIMIT) return null;

	const info = await telegram<{
		ok: boolean;
		result?: { file_path?: string; file_size?: number };
	}>(`getFile?file_id=${encodeURIComponent(fileId)}`);
	if (!info.ok || !info.result?.file_path) return null;
	if ((info.result.file_size ?? 0) > TELEGRAM_DOWNLOAD_LIMIT) return null;

	const res = await fetch(`${TELEGRAM_FILE_API}/${info.result.file_path}`);
	if (!res.ok) return null;

	const buffer = Buffer.from(await res.arrayBuffer());
	if (buffer.length > TELEGRAM_DOWNLOAD_LIMIT) return null;

	const ext =
		path.extname(info.result.file_path) || path.extname(suggestedName) || "";
	const safeBase =
		path
			.basename(suggestedName, path.extname(suggestedName))
			.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
	const localPath = path.join(TMP_DIR, `${Date.now()}-${safeBase}${ext}`);
	fs.writeFileSync(localPath, buffer);
	return { localPath, size: buffer.length };
}

async function sendPiResponse(
	chatId: string,
	response: RpcPromptResult,
): Promise<void> {
	await sendTelegramMessage(chatId, response.text);

	const combinedText = `${response.text}\n${response.toolOutput}`;

	if (SEND_LOCAL_IMAGES) {
		const imagePaths = extractUploadableImagePaths(combinedText).slice(
			0,
			Math.max(0, MAX_IMAGE_UPLOADS),
		);

		for (const imagePath of imagePaths) {
			try {
				await sendTelegramLocalImage(chatId, imagePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[${chatId}] image upload error:`, message);
				await sendTelegramMessage(
					chatId,
					`⚠️ Generated image was saved at ${imagePath}, but I could not upload it: ${sanitizeError(message)}`,
				);
			}
		}
	}

	if (SEND_LOCAL_DOCUMENTS) {
		const documentPaths = extractUploadableDocumentPaths(combinedText).slice(
			0,
			Math.max(0, MAX_DOCUMENT_UPLOADS),
		);

		for (const docPath of documentPaths) {
			try {
				await sendTelegramDocument(chatId, docPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[${chatId}] document upload error:`, message);
				await sendTelegramMessage(
					chatId,
					`⚠️ Generated document was saved at ${docPath}, but I could not upload it: ${sanitizeError(message)}`,
				);
			}
		}
	}
}

function extractUploadableImagePaths(text: string): string[] {
	const matches = text.matchAll(
		/(?:file:\/\/)?(?:~|\/)[^\s"'`<>{}\[\]|]+?\.(?:png|jpe?g|webp|gif)(?=[\s"'`<>{}\[\]|),.;:!?]|$)/gi,
	);
	const paths: string[] = [];
	const seen = new Set<string>();

	for (const match of matches) {
		const normalized = normalizeLocalPath(match[0]);
		if (!normalized || seen.has(normalized)) continue;
		if (!isUploadableImagePath(normalized)) continue;
		seen.add(normalized);
		paths.push(normalized);
	}

	return paths;
}

function extractUploadableDocumentPaths(text: string): string[] {
	if (DOCUMENT_UPLOAD_EXTS.length === 0) return [];
	const matches = text.matchAll(DOCUMENT_PATH_REGEX);
	const paths: string[] = [];
	const seen = new Set<string>();

	for (const match of matches) {
		const normalized = normalizeLocalPath(match[0]);
		if (!normalized || seen.has(normalized)) continue;
		if (!isUploadableDocumentPath(normalized)) continue;
		seen.add(normalized);
		paths.push(normalized);
	}

	return paths;
}

function normalizeLocalPath(candidate: string): string | null {
	let filePath = candidate
		.trim()
		.replace(/^file:\/\//, "")
		.replace(/^[('"`<\[]+/, "")
		.replace(/[)'"`>\],.;:!?]+$/, "");

	if (filePath.startsWith("~/")) {
		filePath = path.join(os.homedir(), filePath.slice(2));
	}

	if (!path.isAbsolute(filePath)) return null;
	return path.resolve(filePath);
}

function isUploadableImagePath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
		return false;
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return false;
	}

	if (!stat.isFile() || stat.size <= 0) return false;
	if (stat.size > TELEGRAM_DOCUMENT_UPLOAD_LIMIT) return false;
	return isUnderAllowedDir(filePath, LOCAL_IMAGE_UPLOAD_DIRS);
}

function isUploadableDocumentPath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
	if (!DOCUMENT_UPLOAD_EXTS.includes(ext)) return false;

	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return false;
	}

	if (!stat.isFile() || stat.size <= 0) return false;
	if (stat.size > TELEGRAM_DOCUMENT_UPLOAD_LIMIT) return false;
	return isUnderAllowedDir(filePath, LOCAL_DOCUMENT_UPLOAD_DIRS);
}

function isUnderAllowedDir(filePath: string, allowedDirs: string[]): boolean {
	let realFile: string;
	try {
		realFile = fs.realpathSync(filePath);
	} catch {
		return false;
	}

	for (const configuredDir of allowedDirs) {
		const expandedDir = configuredDir.startsWith("~/")
			? path.join(os.homedir(), configuredDir.slice(2))
			: configuredDir;
		let allowedDir = path.resolve(expandedDir);
		try {
			allowedDir = fs.realpathSync(allowedDir);
		} catch {
			// The directory may not exist until the first generation.
		}

		if (
			realFile === allowedDir ||
			realFile.startsWith(`${allowedDir}${path.sep}`)
		) {
			return true;
		}
	}

	return false;
}

async function sendTelegramLocalImage(
	chatId: string,
	filePath: string,
): Promise<void> {
	const stat = fs.statSync(filePath);
	const asPhoto = stat.size <= TELEGRAM_PHOTO_UPLOAD_LIMIT;
	const method = asPhoto ? "sendPhoto" : "sendDocument";
	const fieldName = asPhoto ? "photo" : "document";
	const fileBuffer = fs.readFileSync(filePath);
	const form = new FormData();
	form.append("chat_id", chatId);
	form.append(
		fieldName,
		new Blob([fileBuffer], { type: imageMimeType(filePath) }),
		path.basename(filePath),
	);
	form.append("caption", `Generated image: ${path.basename(filePath)}`);

	await telegram(method, { method: "POST", body: form });
}

function imageMimeType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		default:
			return "image/png";
	}
}

async function sendTelegramDocument(
	chatId: string,
	filePath: string,
): Promise<void> {
	const fileBuffer = fs.readFileSync(filePath);
	const form = new FormData();
	form.append("chat_id", chatId);
	form.append(
		"document",
		new Blob([fileBuffer], { type: documentMimeType(filePath) }),
		path.basename(filePath),
	);
	form.append("caption", path.basename(filePath));
	await telegram("sendDocument", { method: "POST", body: form });
}

function documentMimeType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".pdf":
			return "application/pdf";
		case ".doc":
			return "application/msword";
		case ".docx":
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		case ".xls":
			return "application/vnd.ms-excel";
		case ".xlsx":
			return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		case ".ppt":
			return "application/vnd.ms-powerpoint";
		case ".pptx":
			return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
		case ".csv":
			return "text/csv";
		case ".json":
			return "application/json";
		case ".md":
			return "text/markdown";
		case ".txt":
			return "text/plain";
		default:
			return "application/octet-stream";
	}
}

function extractToolResultText(result: any): string {
	const content = result?.content;
	if (!Array.isArray(content)) return typeof result === "string" ? result : "";
	return content
		.map((part) => (typeof part?.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

async function sendTelegramMessage(
	chatId: string,
	text: string,
): Promise<void> {
	const chunks = splitTelegramMessage(text || "(empty)");
	for (const chunk of chunks) {
		await telegram("sendMessage", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text: chunk }),
		});
	}
}

async function sendChatAction(chatId: string): Promise<void> {
	try {
		await telegram("sendChatAction", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, action: "typing" }),
		});
	} catch {
		// Typing indicators are best-effort.
	}
}

async function telegram<T = any>(
	methodAndQuery: string,
	init?: RequestInit,
): Promise<T> {
	const res = await fetch(`${TELEGRAM_API}/${methodAndQuery}`, init);
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(
			`Telegram ${methodAndQuery} failed (${res.status}): ${body}`,
		);
	}
	return (await res.json()) as T;
}

function splitTelegramMessage(text: string): string[] {
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > TELEGRAM_MAX_MESSAGE) {
		let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_MESSAGE);
		if (splitAt < TELEGRAM_MAX_MESSAGE / 2) splitAt = TELEGRAM_MAX_MESSAGE;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).replace(/^\n/, "");
	}
	chunks.push(remaining);
	return chunks;
}

function sanitizeError(error: string): string {
	const firstUsefulLine = error
		.split("\n")
		.map((line) => line.trim())
		.find(
			(line) => line && !line.startsWith("at ") && !line.startsWith("node:"),
		);
	const message = firstUsefulLine || "Something went wrong.";
	return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(): Promise<void> {
	if (!running) return;
	running = false;
	console.log("Shutting down...");
	for (const chat of chats.values()) {
		if (chat.idleTimer) clearTimeout(chat.idleTimer);
		chat.rpc.cleanup();
	}
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

await pollTelegram();
