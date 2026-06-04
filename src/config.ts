import "dotenv/config";
import * as os from "node:os";
import * as path from "node:path";
import {
	configNumber,
	normalizeModelRef,
	readActiveModel,
} from "./util.ts";

/**
 * Application configuration.
 *
 * Keep secrets and deployment-specific values in .env. Source-controlled values
 * below are safe defaults/toggles for this bot.
 */

// ---------------------------------------------------------------------------
// User-editable non-secret settings
// ---------------------------------------------------------------------------

// Models
export const CHAT_MODEL = "openai-codex/gpt-5.4-mini";
const CONFIG_BACKGROUND_MODEL = "openai-codex/gpt-5.4-mini";
const CONFIG_ALLOWED_MODELS = [
	"openai-codex/gpt-5.4-mini",
	"openai-codex/gpt-5.5",
	"openrouter/moonshotai/kimi-k2.6",
] as const;

// ElevenLabs voice features
const ELEVENLABS_TRANSCRIPTION_MODEL = "scribe_v2";
const ELEVENLABS_TRANSCRIPTION_LANGUAGE = "en";
const CONFIG_ELEVENLABS_TTS_VOICE_ID = "cjVigY5qzO86Huf0OWal";
const CONFIG_ELEVENLABS_TTS_MODEL = "eleven_v3";
const CONFIG_ELEVENLABS_TTS_OUTPUT_FORMAT = "opus_48000_32";

// Queueing, tool-call display, and TTS limits
const PI_CHANNEL_IDLE_TIMEOUT_MINUTES = 120;
const PI_CHANNEL_MAX_QUEUE_PER_CHAT = 5;
const PI_CHANNEL_MAX_TTS_CHARS = 2500;
const PI_CHANNEL_SEND_TOOL_CALLS = true;
const PI_CHANNEL_TOOL_CALL_BATCH_MS = 1500;
const PI_CHANNEL_TOOL_CALL_BATCH_MAX_ITEMS = 8;

// Generated local file uploads
const PI_CHANNEL_SEND_LOCAL_IMAGES = true;
const PI_CHANNEL_IMAGE_UPLOAD_DIRS = [
	path.join(os.tmpdir(), "create-image"),
] as const;
const PI_CHANNEL_SEND_LOCAL_DOCUMENTS = true;
const PI_CHANNEL_DOCUMENT_UPLOAD_DIRS = [
	path.join(os.tmpdir(), "pi-channel"),
	process.cwd(),
] as const;
const PI_CHANNEL_DOCUMENT_UPLOAD_EXTS = [
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"txt",
	"md",
	"csv",
	"json",
] as const;

// Scheduled background prompts
const CONFIG_HEARTBEAT_ENABLED = true;
const PI_HEARTBEAT_INTERVAL_SECONDS = 3600;

// Local Pi extension discovery
const CONFIG_EXTENSION_ENTRYPOINT_EXTS = [
	".ts",
	".js",
	".mjs",
	".cjs",
] as const;

// ---------------------------------------------------------------------------
// Runtime paths
// ---------------------------------------------------------------------------

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
export const ACTIVE_MODEL_PATH = path.join(PROJECT_ROOT, ".active_model");
export const SESSIONS_DIR = path.join(PROJECT_ROOT, "sessions");
export const TMP_DIR = path.join(os.tmpdir(), "pi-channel");

export const PROJECT_EXTENSIONS_DIR = path.join(PROJECT_ROOT, "extensions");
export const PROJECT_SKILLS_DIR = path.join(PROJECT_ROOT, "skills");
export const FILES_DIR = path.join(PROJECT_ROOT, "files");
export const SYSTEM_PROMPT_PATH = path.join(FILES_DIR, "system.md");
export const MEMORY_PATH = path.join(FILES_DIR, "memory.md");
export const DAILY_MEMORY_DIR = path.join(FILES_DIR, "memory");
export const CRON_JOBS_PATH = path.join(FILES_DIR, "cron-jobs.json");
export const HEARTBEAT_FILE_PATH = path.join(FILES_DIR, "heartbeat.md");
export const HEARTBEAT_STATE_PATH = path.join(FILES_DIR, "heartbeat-state.md");

// ---------------------------------------------------------------------------
// Environment and secrets
// ---------------------------------------------------------------------------

export const BOT_TOKEN =
	process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN;
export const ALLOWED_CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID?.trim() ?? "";
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
export const OPENAI_CODEX_API_KEY = process.env.OPENAI_CODEX_API_KEY ?? "";
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// ---------------------------------------------------------------------------
// Derived model config
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = normalizeModelRef(CHAT_MODEL);
export const ALLOWED_MODELS = CONFIG_ALLOWED_MODELS.map((model) =>
	normalizeModelRef(model),
).filter(Boolean);
export const MODEL =
	readActiveModel(ACTIVE_MODEL_PATH, ALLOWED_MODELS, DEFAULT_MODEL) ??
	DEFAULT_MODEL;
export const BACKGROUND_MODEL = normalizeModelRef(CONFIG_BACKGROUND_MODEL);

// ---------------------------------------------------------------------------
// Telegram API and size limits
// ---------------------------------------------------------------------------

export const TELEGRAM_API = BOT_TOKEN
	? `https://api.telegram.org/bot${BOT_TOKEN}`
	: "";
export const TELEGRAM_FILE_API = BOT_TOKEN
	? `https://api.telegram.org/file/bot${BOT_TOKEN}`
	: "";
export const TELEGRAM_MAX_MESSAGE = 4096;
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export const TELEGRAM_PHOTO_UPLOAD_LIMIT = 10 * 1024 * 1024;
export const TELEGRAM_DOCUMENT_UPLOAD_LIMIT = 50 * 1024 * 1024;
export const TELEGRAM_VOICE_UPLOAD_LIMIT = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Queueing and response behavior
// ---------------------------------------------------------------------------

export const IDLE_TIMEOUT_MS =
	configNumber(PI_CHANNEL_IDLE_TIMEOUT_MINUTES, 30, 1) * 60_000;
export const MAX_QUEUE_PER_CHAT = configNumber(
	PI_CHANNEL_MAX_QUEUE_PER_CHAT,
	5,
	1,
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

// ---------------------------------------------------------------------------
// Voice and transcription
// ---------------------------------------------------------------------------

export const ELEVENLABS_MODEL = ELEVENLABS_TRANSCRIPTION_MODEL;
export const ELEVENLABS_LANGUAGE = ELEVENLABS_TRANSCRIPTION_LANGUAGE;
export const ELEVENLABS_TTS_VOICE_ID =
	CONFIG_ELEVENLABS_TTS_VOICE_ID.trim();
export const ELEVENLABS_TTS_MODEL = CONFIG_ELEVENLABS_TTS_MODEL.trim();
export const ELEVENLABS_TTS_OUTPUT_FORMAT =
	CONFIG_ELEVENLABS_TTS_OUTPUT_FORMAT.trim();
export const MAX_TTS_CHARS = configNumber(
	PI_CHANNEL_MAX_TTS_CHARS,
	2500,
	100,
);
export const TRANSCRIPTION_MAX_FILE_SIZE = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Generated local upload behavior
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pi resources and scheduled prompt config
// ---------------------------------------------------------------------------

export const EXTENSION_ENTRYPOINT_EXTS = new Set<string>(
	CONFIG_EXTENSION_ENTRYPOINT_EXTS,
);
export const HEARTBEAT_ENABLED = CONFIG_HEARTBEAT_ENABLED;
export const HEARTBEAT_INTERVAL_MS =
	configNumber(PI_HEARTBEAT_INTERVAL_SECONDS, 60, 1) * 1000;

export const HEARTBEAT_NOOP = "__HEARTBEAT_NOOP__";
export const CRON_NOOP = "__CRON_NOOP__";
