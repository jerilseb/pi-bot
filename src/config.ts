import "dotenv/config";
import * as os from "node:os";
import * as path from "node:path";

export function envFlag(
	value: string | undefined,
	defaultValue: boolean,
): boolean {
	if (value === undefined || value.trim() === "") return defaultValue;
	return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function envNumber(
	value: string | undefined,
	defaultValue: number,
	minimum: number,
): number {
	const parsed = Number(value ?? defaultValue);
	if (!Number.isFinite(parsed)) return defaultValue;
	return Math.max(minimum, parsed);
}

export function resolveConfigPath(value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

export const BOT_TOKEN =
	process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN;
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "";
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
export const ELEVENLABS_MODEL = "scribe_v2";
export const ELEVENLABS_LANGUAGE = "en";
export const ELEVENLABS_TTS_VOICE_ID =
	process.env.ELEVENLABS_TTS_VOICE_ID?.trim() ?? "";
export const ELEVENLABS_TTS_MODEL =
	process.env.ELEVENLABS_TTS_MODEL?.trim() || "eleven_v3";
export const ELEVENLABS_TTS_OUTPUT_FORMAT =
	process.env.ELEVENLABS_TTS_OUTPUT_FORMAT?.trim() || "opus_48000_32";
export const ALLOWED_CHAT_ID =
	process.env.TELEGRAM_ALLOWED_CHAT_ID?.trim() ?? "";

export const IDLE_TIMEOUT_MS =
	Number(process.env.PI_CHANNEL_IDLE_TIMEOUT_MINUTES ?? 30) * 60_000;
export const MAX_QUEUE_PER_CHAT = Number(
	process.env.PI_CHANNEL_MAX_QUEUE_PER_CHAT ?? 5,
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

export const MAX_TTS_CHARS = envNumber(
	process.env.PI_CHANNEL_MAX_TTS_CHARS,
	2500,
	100,
);

export const SEND_TOOL_CALLS = envFlag(
	process.env.PI_CHANNEL_SEND_TOOL_CALLS,
	true,
);

export const SEND_LOCAL_IMAGES = true;
export const LOCAL_IMAGE_UPLOAD_DIRS = (
	process.env.PI_CHANNEL_IMAGE_UPLOAD_DIRS ??
	path.join(os.tmpdir(), "create-image")
)
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

export const SEND_LOCAL_DOCUMENTS = envFlag(
	process.env.PI_CHANNEL_SEND_LOCAL_DOCUMENTS,
	true,
);
export const LOCAL_DOCUMENT_UPLOAD_DIRS = (
	process.env.PI_CHANNEL_DOCUMENT_UPLOAD_DIRS ??
	`${path.join(os.tmpdir(), "pi-channel")},${process.cwd()}`
)
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
export const DOCUMENT_UPLOAD_EXTS = (
	process.env.PI_CHANNEL_DOCUMENT_UPLOAD_EXTS ??
	"pdf,doc,docx,xls,xlsx,ppt,pptx,txt,md,csv,json"
)
	.split(",")
	.map((s) => s.trim().toLowerCase().replace(/^\./, ""))
	.filter(Boolean);

export const EXTENSION_ENTRYPOINT_EXTS = new Set([
	".ts",
	".js",
	".mjs",
	".cjs",
]);
export const PROJECT_EXTENSIONS_DIR = path.join(PROJECT_ROOT, "extensions");
export const PROJECT_SKILLS_DIR = path.join(PROJECT_ROOT, "skills");
export const FILES_DIR = path.join(PROJECT_ROOT, "files");
export const SYSTEM_PROMPT_PATH = path.join(FILES_DIR, "system.md");
export const MEMORY_PATH = path.join(FILES_DIR, "memory.md");
export const CRON_JOBS_PATH = path.join(FILES_DIR, "cron-jobs.json");

export const HEARTBEAT_ENABLED = true;
export const HEARTBEAT_INTERVAL_MS =
	envNumber(process.env.PI_HEARTBEAT_INTERVAL_SECONDS, 60, 1) * 1000;
export const HEARTBEAT_FILE_PATH = path.join(FILES_DIR, "heartbeat.md");
export const HEARTBEAT_STATE_PATH = path.join(FILES_DIR, "heartbeat-state.md");
export const HEARTBEAT_NOOP = "__HEARTBEAT_NOOP__";
export const CRON_NOOP = "__CRON_NOOP__";
