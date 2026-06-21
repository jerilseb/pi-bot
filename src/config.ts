import 'dotenv/config';
import * as os from 'node:os';
import * as path from 'node:path';
import { configNumber, normalizeModelRef, readActiveModel } from './util.ts';

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
export const CHAT_MODEL = 'openai-codex/gpt-5.4-mini';
const CONFIG_BACKGROUND_MODEL = 'openai-codex/gpt-5.4-mini';
const CONFIG_ALLOWED_MODELS = [
  'openai-codex/gpt-5.4-mini',
  'openai-codex/gpt-5.5',
  'openrouter/moonshotai/kimi-k2.6',
] as const;

// Speech features
export type SpeechProvider = 'google-genai' | 'elevenlabs';
const CONFIG_SPEECH_TO_TEXT_PROVIDER: SpeechProvider = 'elevenlabs';
const CONFIG_TEXT_TO_SPEECH_PROVIDER: SpeechProvider = 'google-genai';

// Google GenAI speech features
const GOOGLE_GENAI_TRANSCRIPTION_MODEL = 'gemini-3.5-flash';
const GOOGLE_GENAI_TRANSCRIPTION_PROMPT =
  'Transcribe this audio accurately. Return only the transcript text.';
const GOOGLE_GENAI_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const GOOGLE_GENAI_TTS_VOICE_NAME = 'Kore';

// ElevenLabs speech features
const ELEVENLABS_TRANSCRIPTION_MODEL = 'scribe_v2';
const ELEVENLABS_TRANSCRIPTION_LANGUAGE = 'en';
const ELEVENLABS_TRANSCRIPTION_FETCH_ATTEMPTS = 3;
const ELEVENLABS_TRANSCRIPTION_FETCH_TIMEOUT_MS = 60_000;
const ELEVENLABS_TRANSCRIPTION_RETRY_BASE_DELAY_MS = 1_000;
const CONFIG_ELEVENLABS_TTS_VOICE_ID = 'cjVigY5qzO86Huf0OWal';
const CONFIG_ELEVENLABS_TTS_MODEL = 'eleven_v3';
const CONFIG_ELEVENLABS_TTS_OUTPUT_FORMAT = 'opus_48000_32';

// Queueing and TTS limits
const PI_CHANNEL_IDLE_TIMEOUT_MINUTES = 120;
const PI_CHANNEL_MAX_QUEUE_PER_CHAT = 5;
const PI_CHANNEL_MAX_TTS_CHARS = 2500;

// Web UI server
const CONFIG_WEB_UI_PORT = 8787;
const CONFIG_WEB_UI_HOST = '127.0.0.1';
const CONFIG_WEB_HISTORY_MAX = 500;
const CONFIG_WEB_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const CONFIG_WEB_UPLOAD_ABANDONED_TTL_MINUTES = 30;
const CONFIG_WEB_TOOL_UPDATE_THROTTLE_MS = 250;

// Generated local file uploads
const PI_CHANNEL_SEND_LOCAL_IMAGES = true;
const PI_CHANNEL_IMAGE_UPLOAD_DIRS = [path.join(os.tmpdir(), 'create-image')] as const;
const PI_CHANNEL_SEND_LOCAL_DOCUMENTS = true;
const PI_CHANNEL_DOCUMENT_UPLOAD_DIRS = [
  path.join(os.tmpdir(), 'pi-channel'),
  process.cwd(),
] as const;
const PI_CHANNEL_DOCUMENT_UPLOAD_EXTS = [
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'md',
  'csv',
  'json',
] as const;

// Scheduled background prompts
const CONFIG_HEARTBEAT_ENABLED = true;
const PI_HEARTBEAT_INTERVAL_SECONDS = 3600;

// Sub-agents spawned by the main agent
const CONFIG_SUBAGENT_MODEL = 'openai-codex/gpt-5.4-mini';
const PI_SUBAGENT_MAX_RUNNING = 3;
const PI_SUBAGENT_DEFAULT_YIELD_MS = 5_000;
const PI_SUBAGENT_MAX_YIELD_MS = 30_000;
const PI_SUBAGENT_DEFAULT_MAX_RUNTIME_MS = 10 * 60_000;
const PI_SUBAGENT_MAX_RUNTIME_CAP_MS = 60 * 60_000;
const PI_SUBAGENT_MAX_RESULT_CHARS = 6_000;
const PI_SUBAGENT_COMPLETED_TTL_MS = 30 * 60_000;
const CONFIG_SUBAGENT_SKILLS = ['pdf'] as const;

// Local Pi extension discovery
const CONFIG_EXTENSION_ENTRYPOINT_EXTS = ['.ts', '.js', '.mjs', '.cjs'] as const;

// ---------------------------------------------------------------------------
// Runtime paths
// ---------------------------------------------------------------------------

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
export const ACTIVE_MODEL_PATH = path.join(PROJECT_ROOT, '.active_model');
export const SESSIONS_DIR = path.join(PROJECT_ROOT, 'sessions');
export const TMP_DIR = path.join(os.tmpdir(), 'pi-channel');

export const PROJECT_EXTENSIONS_DIR = path.join(PROJECT_ROOT, 'extensions');
export const PROJECT_SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');
export const FILES_DIR = path.join(PROJECT_ROOT, 'files');
export const SYSTEM_PROMPT_PATH = path.join(FILES_DIR, 'system.md');
export const MEMORY_PATH = path.join(FILES_DIR, 'memory.md');
export const DAILY_MEMORY_DIR = path.join(FILES_DIR, 'memory');
export const CRON_JOBS_PATH = path.join(FILES_DIR, 'cron-jobs.json');
export const POST_RESTART_TASKS_PATH = path.join(FILES_DIR, 'post-restart-tasks.json');
export const HEARTBEAT_FILE_PATH = path.join(FILES_DIR, 'heartbeat.md');
export const HEARTBEAT_STATE_PATH = path.join(FILES_DIR, 'heartbeat-state.md');

// Web UI persisted state
export const WEB_ASSETS_DIR = path.join(FILES_DIR, 'web-assets');
export const WEB_ASSETS_MANIFEST_PATH = path.join(WEB_ASSETS_DIR, 'manifest.json');
export const WEB_HISTORY_DIR = path.join(FILES_DIR, 'web-history');
export const WEB_HISTORY_STATE_PATH = path.join(WEB_HISTORY_DIR, 'state.json');
export const WEB_PUSH_SUBSCRIPTIONS_PATH = path.join(FILES_DIR, 'web-push-subscriptions.json');

/** Frontend production build output served by src/web/server.ts. */
export const WEB_DIST_DIR = path.join(PROJECT_ROOT, 'web', 'dist');

// ---------------------------------------------------------------------------
// Environment and secrets
// ---------------------------------------------------------------------------

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? '';
export const OPENAI_CODEX_API_KEY = process.env.OPENAI_CODEX_API_KEY ?? '';
export const GOOGLE_GENAI_API_KEY =
  process.env.GOOGLE_GENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Web Push (VAPID). Disabled by default; enable only with keys present.
export const WEB_PUSH_ENABLED =
  (process.env.WEB_PUSH_ENABLED ?? '').trim().toLowerCase() === 'true';
export const WEB_PUSH_VAPID_PUBLIC = process.env.WEB_PUSH_VAPID_PUBLIC ?? '';
export const WEB_PUSH_VAPID_PRIVATE = process.env.WEB_PUSH_VAPID_PRIVATE ?? '';
export const WEB_PUSH_SUBJECT = process.env.WEB_PUSH_SUBJECT ?? 'mailto:admin@example.com';

// ---------------------------------------------------------------------------
// Derived model config
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = normalizeModelRef(CHAT_MODEL);
export const ALLOWED_MODELS = CONFIG_ALLOWED_MODELS.map((model) => normalizeModelRef(model)).filter(
  Boolean,
);
export const MODEL =
  readActiveModel(ACTIVE_MODEL_PATH, ALLOWED_MODELS, DEFAULT_MODEL) ?? DEFAULT_MODEL;
export const BACKGROUND_MODEL = normalizeModelRef(CONFIG_BACKGROUND_MODEL);

// ---------------------------------------------------------------------------
// Web UI server and asset/upload limits
// ---------------------------------------------------------------------------

/** The single default web conversation id. The registry is keyed by chatId so
 * named conversations can be added later without rework. */
export const WEB_CHAT_ID = 'web';

export const WEB_UI_PORT = configNumber(
  Number(process.env.WEB_UI_PORT) || CONFIG_WEB_UI_PORT,
  8787,
  1,
);
export const WEB_UI_HOST = (process.env.WEB_UI_HOST ?? CONFIG_WEB_UI_HOST).trim() || '127.0.0.1';
export const WEB_HISTORY_MAX = configNumber(CONFIG_WEB_HISTORY_MAX, 500, 1);
export const WEB_UPLOAD_MAX_BYTES = configNumber(
  CONFIG_WEB_UPLOAD_MAX_BYTES,
  50 * 1024 * 1024,
  1024,
);
export const WEB_UPLOAD_ABANDONED_TTL_MS =
  configNumber(CONFIG_WEB_UPLOAD_ABANDONED_TTL_MINUTES, 30, 1) * 60_000;
export const WEB_TOOL_UPDATE_THROTTLE_MS = configNumber(CONFIG_WEB_TOOL_UPDATE_THROTTLE_MS, 250, 0);
/** Max bytes of tool args/results streamed or persisted (the rest is truncated). */
export const TOOL_DATA_CAP_BYTES = 8 * 1024;

// Generated-file upload size caps for the send_image / send_document / send_voice_note tools.
export const IMAGE_UPLOAD_LIMIT = 10 * 1024 * 1024;
export const DOCUMENT_UPLOAD_LIMIT = 50 * 1024 * 1024;
export const VOICE_UPLOAD_LIMIT = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Queueing behavior
// ---------------------------------------------------------------------------

export const IDLE_TIMEOUT_MS = configNumber(PI_CHANNEL_IDLE_TIMEOUT_MINUTES, 30, 1) * 60_000;
export const MAX_QUEUE_PER_CHAT = configNumber(PI_CHANNEL_MAX_QUEUE_PER_CHAT, 5, 1);

// ---------------------------------------------------------------------------
// Voice and transcription
// ---------------------------------------------------------------------------

export const SPEECH_TO_TEXT_PROVIDER = CONFIG_SPEECH_TO_TEXT_PROVIDER;
export const TEXT_TO_SPEECH_PROVIDER = CONFIG_TEXT_TO_SPEECH_PROVIDER;
export const GOOGLE_GENAI_STT_MODEL = GOOGLE_GENAI_TRANSCRIPTION_MODEL.trim();
export const GOOGLE_GENAI_STT_PROMPT = GOOGLE_GENAI_TRANSCRIPTION_PROMPT.trim();
export const GOOGLE_GENAI_TTS_MODEL_NAME = GOOGLE_GENAI_TTS_MODEL.trim();
export const GOOGLE_GENAI_TTS_VOICE = GOOGLE_GENAI_TTS_VOICE_NAME.trim();
export const ELEVENLABS_MODEL = ELEVENLABS_TRANSCRIPTION_MODEL;
export const ELEVENLABS_LANGUAGE = ELEVENLABS_TRANSCRIPTION_LANGUAGE;
export const TRANSCRIPTION_FETCH_ATTEMPTS = configNumber(
  ELEVENLABS_TRANSCRIPTION_FETCH_ATTEMPTS,
  3,
  1,
);
export const TRANSCRIPTION_FETCH_TIMEOUT_MS = configNumber(
  ELEVENLABS_TRANSCRIPTION_FETCH_TIMEOUT_MS,
  60_000,
  1_000,
);
export const TRANSCRIPTION_RETRY_BASE_DELAY_MS = configNumber(
  ELEVENLABS_TRANSCRIPTION_RETRY_BASE_DELAY_MS,
  1_000,
  100,
);
export const ELEVENLABS_TTS_VOICE_ID = CONFIG_ELEVENLABS_TTS_VOICE_ID.trim();
export const ELEVENLABS_TTS_MODEL = CONFIG_ELEVENLABS_TTS_MODEL.trim();
export const ELEVENLABS_TTS_OUTPUT_FORMAT = CONFIG_ELEVENLABS_TTS_OUTPUT_FORMAT.trim();
export const MAX_TTS_CHARS = configNumber(PI_CHANNEL_MAX_TTS_CHARS, 2500, 100);
export const TRANSCRIPTION_MAX_FILE_SIZE = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Generated local upload behavior
// ---------------------------------------------------------------------------

export const SEND_LOCAL_IMAGES = PI_CHANNEL_SEND_LOCAL_IMAGES;
export const LOCAL_IMAGE_UPLOAD_DIRS = PI_CHANNEL_IMAGE_UPLOAD_DIRS.map((s) => s.trim()).filter(
  Boolean,
);

export const SEND_LOCAL_DOCUMENTS = PI_CHANNEL_SEND_LOCAL_DOCUMENTS;
export const LOCAL_DOCUMENT_UPLOAD_DIRS = PI_CHANNEL_DOCUMENT_UPLOAD_DIRS.map((s) =>
  s.trim(),
).filter(Boolean);
export const DOCUMENT_UPLOAD_EXTS = PI_CHANNEL_DOCUMENT_UPLOAD_EXTS.map((s) =>
  s.trim().toLowerCase().replace(/^\./, ''),
).filter(Boolean);

// ---------------------------------------------------------------------------
// Sub-agent config
// ---------------------------------------------------------------------------

export const SUBAGENT_MODEL = normalizeModelRef(CONFIG_SUBAGENT_MODEL);
export const SUBAGENT_MAX_RUNNING = configNumber(PI_SUBAGENT_MAX_RUNNING, 3, 1);
export const SUBAGENT_DEFAULT_YIELD_MS = configNumber(PI_SUBAGENT_DEFAULT_YIELD_MS, 5_000, 0);
export const SUBAGENT_MAX_YIELD_MS = configNumber(PI_SUBAGENT_MAX_YIELD_MS, 30_000, 0);
export const SUBAGENT_DEFAULT_MAX_RUNTIME_MS = configNumber(
  PI_SUBAGENT_DEFAULT_MAX_RUNTIME_MS,
  10 * 60_000,
  1_000,
);
export const SUBAGENT_MAX_RUNTIME_CAP_MS = configNumber(
  PI_SUBAGENT_MAX_RUNTIME_CAP_MS,
  60 * 60_000,
  1_000,
);
export const SUBAGENT_MAX_RESULT_CHARS = configNumber(PI_SUBAGENT_MAX_RESULT_CHARS, 6_000, 500);
export const SUBAGENT_COMPLETED_TTL_MS = configNumber(
  PI_SUBAGENT_COMPLETED_TTL_MS,
  30 * 60_000,
  60_000,
);
export const SUBAGENT_SKILLS = CONFIG_SUBAGENT_SKILLS.map((skill) => skill.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Pi resources and scheduled prompt config
// ---------------------------------------------------------------------------

export const EXTENSION_ENTRYPOINT_EXTS = new Set<string>(CONFIG_EXTENSION_ENTRYPOINT_EXTS);
export const HEARTBEAT_ENABLED = CONFIG_HEARTBEAT_ENABLED;
export const HEARTBEAT_INTERVAL_MS = configNumber(PI_HEARTBEAT_INTERVAL_SECONDS, 60, 1) * 1000;

export const HEARTBEAT_NOOP = '__HEARTBEAT_NOOP__';
export const CRON_NOOP = '__CRON_NOOP__';
export const BACKGROUND_BASH_NOOP = '__BACKGROUND_BASH_NOOP__';
