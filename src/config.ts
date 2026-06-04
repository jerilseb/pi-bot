import "dotenv/config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ALLOWED_MODELS as CONFIG_ALLOWED_MODELS,
	BACKGROUND_MODEL as CONFIG_BACKGROUND_MODEL,
	CHAT_MODEL,
	ELEVENLABS_TRANSCRIPTION_LANGUAGE,
	ELEVENLABS_TRANSCRIPTION_MODEL,
	ELEVENLABS_TTS_MODEL as CONFIG_ELEVENLABS_TTS_MODEL,
	ELEVENLABS_TTS_OUTPUT_FORMAT as CONFIG_ELEVENLABS_TTS_OUTPUT_FORMAT,
	ELEVENLABS_TTS_VOICE_ID as CONFIG_ELEVENLABS_TTS_VOICE_ID,
	EXTENSION_ENTRYPOINT_EXTS as CONFIG_EXTENSION_ENTRYPOINT_EXTS,
	HEARTBEAT_ENABLED as CONFIG_HEARTBEAT_ENABLED,
	PI_CHANNEL_DOCUMENT_UPLOAD_DIRS,
	PI_CHANNEL_DOCUMENT_UPLOAD_EXTS,
	PI_CHANNEL_IDLE_TIMEOUT_MINUTES,
	PI_CHANNEL_IMAGE_UPLOAD_DIRS,
	PI_CHANNEL_MAX_QUEUE_PER_CHAT,
	PI_CHANNEL_MAX_TTS_CHARS,
	PI_CHANNEL_SEND_LOCAL_DOCUMENTS,
	PI_CHANNEL_SEND_LOCAL_IMAGES,
	PI_CHANNEL_SEND_TOOL_CALLS,
	PI_CHANNEL_TOOL_CALL_BATCH_MAX_ITEMS,
	PI_CHANNEL_TOOL_CALL_BATCH_MS,
	PI_HEARTBEAT_INTERVAL_SECONDS,
} from "../constants.ts";

export interface ModelRef {
	provider: string;
	model: string;
}

function configNumber(
	value: number,
	defaultValue: number,
	minimum: number,
): number {
	const parsed = Number(value ?? defaultValue);
	if (!Number.isFinite(parsed)) return defaultValue;
	return Math.max(minimum, parsed);
}

export function parseModelRef(value: string): ModelRef {
	const normalized = normalizeModelRef(value);
	const slash = normalized.indexOf("/");
	if (slash <= 0 || slash === normalized.length - 1) {
		throw new Error(
			`Model must be in provider/model form, e.g. openrouter/openai/gpt-5.4-mini: ${value}`,
		);
	}
	return {
		provider: normalized.slice(0, slash),
		model: normalized.slice(slash + 1),
	};
}

export function normalizeModelRef(
	value: string,
	defaultProvider?: string,
): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (!defaultProvider || trimmed.startsWith(`${defaultProvider}/`)) {
		return trimmed;
	}
	return `${defaultProvider}/${trimmed}`;
}

export function formatModelRef(ref: ModelRef): string {
	return `${ref.provider}/${ref.model}`;
}

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
export const ACTIVE_MODEL_PATH = path.join(PROJECT_ROOT, ".active_model");
export const SESSIONS_DIR = path.join(PROJECT_ROOT, "sessions");

function readActiveModelRaw(filePath: string): string | null {
	if (!fs.existsSync(filePath)) return null;
	return fs.readFileSync(filePath, "utf8").trim() || null;
}

function readActiveModel(
	filePath: string,
	allowedModels: string[],
	defaultModel: string,
): string | null {
	const raw = readActiveModelRaw(filePath);
	if (!raw) return null;

	const candidates = [normalizeModelRef(raw), normalizeModelRef(raw, "openrouter")]
		.filter(Boolean)
		.filter((model, index, models) => models.indexOf(model) === index);

	return (
		candidates.find((model) => allowedModels.includes(model)) ??
		candidates.find((model) => model === defaultModel) ??
		candidates[0] ??
		null
	);
}

function writeModelState(filePath: string, model: string): void {
	fs.writeFileSync(filePath, `${normalizeModelRef(model)}\n`, "utf8");
}

export function writeActiveModel(model: string): void {
	writeModelState(ACTIVE_MODEL_PATH, model);
}

export const BOT_TOKEN =
	process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN;

export const DEFAULT_MODEL = normalizeModelRef(CHAT_MODEL);

export const ALLOWED_MODELS = CONFIG_ALLOWED_MODELS.map((model) =>
	normalizeModelRef(model),
).filter(Boolean);
export const MODEL =
	readActiveModel(ACTIVE_MODEL_PATH, ALLOWED_MODELS, DEFAULT_MODEL) ??
	DEFAULT_MODEL;
export const BACKGROUND_MODEL = normalizeModelRef(CONFIG_BACKGROUND_MODEL);

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
export const OPENAI_CODEX_API_KEY = process.env.OPENAI_CODEX_API_KEY ?? "";
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
export const ELEVENLABS_MODEL = ELEVENLABS_TRANSCRIPTION_MODEL;
export const ELEVENLABS_LANGUAGE = ELEVENLABS_TRANSCRIPTION_LANGUAGE;
export const ELEVENLABS_TTS_VOICE_ID =
	CONFIG_ELEVENLABS_TTS_VOICE_ID.trim();
export const ELEVENLABS_TTS_MODEL = CONFIG_ELEVENLABS_TTS_MODEL.trim();
export const ELEVENLABS_TTS_OUTPUT_FORMAT =
	CONFIG_ELEVENLABS_TTS_OUTPUT_FORMAT.trim();
export const ALLOWED_CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID?.trim() ?? "";

export const IDLE_TIMEOUT_MS =
	configNumber(PI_CHANNEL_IDLE_TIMEOUT_MINUTES, 30, 1) * 60_000;
export const MAX_QUEUE_PER_CHAT = configNumber(
	PI_CHANNEL_MAX_QUEUE_PER_CHAT,
	5,
	1,
);
export const TELEGRAM_API = BOT_TOKEN
	? `https://api.telegram.org/bot${BOT_TOKEN}`
	: "";
export const TELEGRAM_FILE_API = BOT_TOKEN
	? `https://api.telegram.org/file/bot${BOT_TOKEN}`
	: "";
export const TELEGRAM_MAX_MESSAGE = 4096;
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export const TRANSCRIPTION_MAX_FILE_SIZE = 25 * 1024 * 1024;
export const TELEGRAM_PHOTO_UPLOAD_LIMIT = 10 * 1024 * 1024;
export const TELEGRAM_DOCUMENT_UPLOAD_LIMIT = 50 * 1024 * 1024;
export const TELEGRAM_VOICE_UPLOAD_LIMIT = 50 * 1024 * 1024;
export const TMP_DIR = path.join(os.tmpdir(), "pi-channel");

export const MAX_TTS_CHARS = configNumber(
	PI_CHANNEL_MAX_TTS_CHARS,
	2500,
	100,
);

export const SEND_TOOL_CALLS = PI_CHANNEL_SEND_TOOL_CALLS;
export const TOOL_CALL_BATCH_MS = configNumber(
	PI_CHANNEL_TOOL_CALL_BATCH_MS,
	1500,
	0,
);
export const TOOL_CALL_BATCH_MAX_ITEMS = configNumber(
	PI_CHANNEL_TOOL_CALL_BATCH_MAX_ITEMS,
	8,
	1,
);

export const SEND_LOCAL_IMAGES = PI_CHANNEL_SEND_LOCAL_IMAGES;
export const LOCAL_IMAGE_UPLOAD_DIRS = PI_CHANNEL_IMAGE_UPLOAD_DIRS.map((s) =>
	s.trim(),
).filter(Boolean);

export const SEND_LOCAL_DOCUMENTS = PI_CHANNEL_SEND_LOCAL_DOCUMENTS;
export const LOCAL_DOCUMENT_UPLOAD_DIRS = PI_CHANNEL_DOCUMENT_UPLOAD_DIRS.map(
	(s) => s.trim(),
).filter(Boolean);
export const DOCUMENT_UPLOAD_EXTS = PI_CHANNEL_DOCUMENT_UPLOAD_EXTS.map((s) =>
	s.trim().toLowerCase().replace(/^\./, ""),
).filter(Boolean);

export const EXTENSION_ENTRYPOINT_EXTS = new Set<string>(
	CONFIG_EXTENSION_ENTRYPOINT_EXTS,
);
export const PROJECT_EXTENSIONS_DIR = path.join(PROJECT_ROOT, "extensions");
export const PROJECT_SKILLS_DIR = path.join(PROJECT_ROOT, "skills");
export const FILES_DIR = path.join(PROJECT_ROOT, "files");
export const SYSTEM_PROMPT_PATH = path.join(FILES_DIR, "system.md");
export const MEMORY_PATH = path.join(FILES_DIR, "memory.md");
export const CRON_JOBS_PATH = path.join(FILES_DIR, "cron-jobs.json");

export const HEARTBEAT_ENABLED = CONFIG_HEARTBEAT_ENABLED;
export const HEARTBEAT_INTERVAL_MS =
	configNumber(PI_HEARTBEAT_INTERVAL_SECONDS, 60, 1) * 1000;
export const HEARTBEAT_FILE_PATH = path.join(FILES_DIR, "heartbeat.md");
export const HEARTBEAT_STATE_PATH = path.join(FILES_DIR, "heartbeat-state.md");
export const HEARTBEAT_NOOP = "__HEARTBEAT_NOOP__";
export const CRON_NOOP = "__CRON_NOOP__";
