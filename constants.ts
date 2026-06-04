import * as os from "node:os";
import * as path from "node:path";

/**
 * Non-secret bot configuration.
 *
 * Keep API keys, tokens, the allowed Telegram chat ID, and other
 * deployment-specific values in .env. Values that are safe to keep in source
 * live here.
 */

export const CHAT_MODEL = "openai-codex/gpt-5.4-mini";
export const BACKGROUND_MODEL = "openai-codex/gpt-5.4-mini";
export const ALLOWED_MODELS = [
	"openai-codex/gpt-5.4-mini",
	"openai-codex/gpt-5.5",
	"openrouter/moonshotai/kimi-k2.6",
] as const;

export const ELEVENLABS_TRANSCRIPTION_MODEL = "scribe_v2";
export const ELEVENLABS_TRANSCRIPTION_LANGUAGE = "en";
export const ELEVENLABS_TTS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
export const ELEVENLABS_TTS_MODEL = "eleven_v3";
export const ELEVENLABS_TTS_OUTPUT_FORMAT = "opus_48000_32";

export const PI_CHANNEL_IDLE_TIMEOUT_MINUTES = 120;
export const PI_CHANNEL_MAX_QUEUE_PER_CHAT = 5;
export const PI_CHANNEL_MAX_TTS_CHARS = 2500;
export const PI_CHANNEL_SEND_TOOL_CALLS = true;
export const PI_CHANNEL_TOOL_CALL_BATCH_MS = 1500;
export const PI_CHANNEL_TOOL_CALL_BATCH_MAX_ITEMS = 8;
export const PI_CHANNEL_SEND_LOCAL_IMAGES = true;
export const PI_CHANNEL_IMAGE_UPLOAD_DIRS = [
	path.join(os.tmpdir(), "create-image"),
] as const;
export const PI_CHANNEL_SEND_LOCAL_DOCUMENTS = true;
export const PI_CHANNEL_DOCUMENT_UPLOAD_DIRS = [
	path.join(os.tmpdir(), "pi-channel"),
	process.cwd(),
] as const;
export const PI_CHANNEL_DOCUMENT_UPLOAD_EXTS = [
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

export const HEARTBEAT_ENABLED = true;
export const PI_HEARTBEAT_INTERVAL_SECONDS = 3600;

export const EXTENSION_ENTRYPOINT_EXTS = [
	".ts",
	".js",
	".mjs",
	".cjs",
] as const;
