import 'dotenv/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseModelRef } from './util.ts';

/**
 * Application configuration.
 *
 * Keep secrets and deployment-specific values in .env. The non-secret,
 * source-controlled settings below are grouped by topic; edit them in place to
 * tune the bot.
 */

// ---------------------------------------------------------------------------
// Runtime paths
// ---------------------------------------------------------------------------

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
export const SESSIONS_DIR = path.join(PROJECT_ROOT, 'sessions');
export const TMP_DIR = path.join(os.tmpdir(), 'pi-channel');

export const PROJECT_EXTENSIONS_DIR = path.join(PROJECT_ROOT, 'extensions');
export const PROJECT_SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');
export const FILES_DIR = path.join(PROJECT_ROOT, 'files');
export const BOT_SETTINGS_PATH = path.join(FILES_DIR, 'settings.json');
export const SYSTEM_PROMPT_PATH = path.join(FILES_DIR, 'system.md');
export const MEMORY_PATH = path.join(FILES_DIR, 'memory.md');
export const DAILY_MEMORY_DIR = path.join(FILES_DIR, 'memory');
export const CRON_JOBS_PATH = path.join(FILES_DIR, 'cron-jobs.json');
export const POST_RESTART_TASKS_PATH = path.join(FILES_DIR, 'post-restart-tasks.json');
export const HEARTBEAT_FILE_PATH = path.join(FILES_DIR, 'heartbeat.md');
export const HEARTBEAT_STATE_PATH = path.join(FILES_DIR, 'heartbeat-state.md');

// ---------------------------------------------------------------------------
// Environment and secrets
// ---------------------------------------------------------------------------

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
/** The single Telegram chat allowed to use this bot. */
export const ALLOWED_CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID?.trim() ?? '';
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? '';
export const OPENAI_CODEX_API_KEY = process.env.OPENAI_CODEX_API_KEY ?? '';
export const GOOGLE_GENAI_API_KEY = process.env.GOOGLE_GENAI_API_KEY ?? '';
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Default chat model. files/settings.json overrides it; see MODEL below. */
export const CHAT_MODEL = 'openai-codex/gpt-5.6-luna';
/** Model for heartbeat and cron prompts. Not changeable from Telegram. */
export const BACKGROUND_MODEL = 'openai-codex/gpt-5.6-terra';
/** Chat models offered by /models. Must contain CHAT_MODEL and the active model. */
export const ALLOWED_MODELS: readonly string[] = [
  'openai-codex/gpt-5.5',
  'openai-codex/gpt-5.6-luna',
  'openai-codex/gpt-5.6-sol',
  'openrouter/moonshotai/kimi-k2.6',
];

/**
 * The subset of settings.json this bot reads. The file is owned by Pi's
 * SettingsManager, which merges writes into the existing contents rather than
 * rewriting it, so bot-only keys such as `heartbeat` survive /models and
 * /reasoning.
 */
interface BotSettings {
  defaultProvider?: unknown;
  defaultModel?: unknown;
  heartbeat?: unknown;
  cronJobs?: unknown;
}

function readBotSettings(): BotSettings {
  if (!fs.existsSync(BOT_SETTINGS_PATH)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(BOT_SETTINGS_PATH, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${BOT_SETTINGS_PATH} must contain a JSON object`);
  }
  return parsed as BotSettings;
}

const BOT_SETTINGS = readBotSettings();
const SETTINGS_MODEL =
  typeof BOT_SETTINGS.defaultProvider === 'string' && typeof BOT_SETTINGS.defaultModel === 'string'
    ? `${BOT_SETTINGS.defaultProvider}/${BOT_SETTINGS.defaultModel}`.trim()
    : '';

export const MODEL = SETTINGS_MODEL || CHAT_MODEL;

export function ensureBotSettingsFile(): void {
  if (fs.existsSync(BOT_SETTINGS_PATH)) return;
  const model = parseModelRef(MODEL);
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.writeFileSync(
    BOT_SETTINGS_PATH,
    `${JSON.stringify(
      {
        defaultProvider: model.provider,
        defaultModel: model.model,
        defaultThinkingLevel: 'high',
        heartbeat: false,
        cronJobs: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Telegram API and size limits
// ---------------------------------------------------------------------------

export const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
export const TELEGRAM_FILE_API = BOT_TOKEN ? `https://api.telegram.org/file/bot${BOT_TOKEN}` : '';
// Client-side fetch deadlines so a silently dead connection cannot hang a call.
// The poll timeout must exceed the 30s server-side getUpdates hold.
export const TELEGRAM_API_TIMEOUT_MS = 30_000;
export const TELEGRAM_POLL_TIMEOUT_MS = 40_000;
export const TELEGRAM_MEDIA_TIMEOUT_MS = 120_000;
export const TELEGRAM_MAX_MESSAGE = 4096;
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export const TELEGRAM_PHOTO_UPLOAD_LIMIT = 10 * 1024 * 1024;
export const TELEGRAM_DOCUMENT_UPLOAD_LIMIT = 50 * 1024 * 1024;
export const TELEGRAM_VOICE_UPLOAD_LIMIT = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Queueing and response behavior
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MINUTES = 120;
export const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * 60_000;
export const MAX_QUEUED_PROMPTS = 5;
export const SEND_TOOL_CALLS = true;
export const TOOL_CALL_BATCH_MS = 5000;
export const TOOL_CALL_BATCH_MAX_ITEMS = 10;

// ---------------------------------------------------------------------------
// Restart lifecycle
// ---------------------------------------------------------------------------

/** Grace period after shutdown so final Telegram sends flush before the exit. */
export const RESTART_EXIT_DELAY_MS = 250;
/** Delay before restart_bot restarts, so its tool result reaches the agent first. */
export const RESTART_TOOL_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// Voice and transcription
// ---------------------------------------------------------------------------

export type SpeechProvider = 'google-genai' | 'elevenlabs';
export const SPEECH_TO_TEXT_PROVIDER: SpeechProvider = 'elevenlabs';
export const TEXT_TO_SPEECH_PROVIDER: SpeechProvider = 'google-genai';

// Google GenAI
export const GOOGLE_GENAI_STT_MODEL = 'gemini-3.5-flash';
export const GOOGLE_GENAI_STT_PROMPT =
  'Transcribe this audio accurately. Return only the transcript text.';
export const GOOGLE_GENAI_TTS_MODEL_NAME = 'gemini-3.1-flash-tts-preview';
export const GOOGLE_GENAI_TTS_VOICE = 'Kore';

// ElevenLabs
export const ELEVENLABS_MODEL = 'scribe_v2';
export const ELEVENLABS_LANGUAGE = 'en';
export const TRANSCRIPTION_FETCH_ATTEMPTS = 3;
export const TRANSCRIPTION_FETCH_TIMEOUT_MS = 60_000;
export const TRANSCRIPTION_RETRY_BASE_DELAY_MS = 1_000;
export const ELEVENLABS_TTS_VOICE_ID = 'cjVigY5qzO86Huf0OWal';
export const ELEVENLABS_TTS_MODEL = 'eleven_v3';
export const ELEVENLABS_TTS_OUTPUT_FORMAT = 'opus_48000_32';
export const MAX_TTS_CHARS = 2500;
export const TRANSCRIPTION_MAX_FILE_SIZE = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Generated local upload behavior
// ---------------------------------------------------------------------------

export const SEND_LOCAL_IMAGES = true;
export const LOCAL_IMAGE_UPLOAD_DIRS = [path.join(os.tmpdir(), 'create-image')];

export const SEND_LOCAL_DOCUMENTS = true;
export const LOCAL_DOCUMENT_UPLOAD_DIRS = [path.join(os.tmpdir(), 'pi-channel'), process.cwd()];
export const DOCUMENT_UPLOAD_EXTS = [
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
];

// ---------------------------------------------------------------------------
// Background work: background bash
//
// Every concurrency limit, timeout, TTL, and payload cap for background work
// belongs in this section — only narrow display widths stay next to the
// formatter that uses them.
// ---------------------------------------------------------------------------

export const BACKGROUND_BASH_MAX_RUNNING = 12;
export const BACKGROUND_BASH_DEFAULT_YIELD_MS = 4_000;
export const BACKGROUND_BASH_MAX_YIELD_MS = 30_000;
export const BACKGROUND_BASH_DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
export const BACKGROUND_BASH_MAX_RUNTIME_CAP_MS = 24 * 60 * 60_000;
export const BACKGROUND_BASH_REPORT_OUTPUT_MAX_CHARS = 3_000;
export const BACKGROUND_BASH_COMPLETED_TTL_MS = 30 * 60_000;
/** How long background_bash_stop waits for a signalled session to settle. */
export const BACKGROUND_BASH_STOP_WAIT_MS = 5_000;

// ---------------------------------------------------------------------------
// Pi resources and scheduled prompt config
// ---------------------------------------------------------------------------

export const EXTENSION_ENTRYPOINT_EXTS = new Set<string>(['.ts', '.js', '.mjs', '.cjs']);
/**
 * Heartbeat runs only when settings.json holds `"heartbeat": true`. It is a
 * runtime setting rather than a constant here because it makes the bot act on
 * its own schedule, so it must be switchable without a code change. Read at
 * startup, so a change takes effect on the next restart.
 */
export const HEARTBEAT_ENABLED = BOT_SETTINGS.heartbeat === true;
/**
 * Scheduled tasks run only when settings.json holds `"cronJobs": true`. Off by
 * default for the same reason as the heartbeat: it lets the bot act unprompted.
 * This gates both the scheduler and the create/list/cancel/update tools, so the
 * agent cannot queue jobs that would never fire. Read at startup.
 */
export const CRON_JOBS_ENABLED = BOT_SETTINGS.cronJobs === true;
const HEARTBEAT_INTERVAL_SECONDS = 3600;
export const HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_SECONDS * 1000;

export const HEARTBEAT_NOOP = '__HEARTBEAT_NOOP__';
export const CRON_NOOP = '__CRON_NOOP__';
export const BACKGROUND_BASH_NOOP = '__BACKGROUND_BASH_NOOP__';

/** True only for the single chat configured via TELEGRAM_ALLOWED_CHAT_ID. */
export function isAllowedTelegramChat(chatId: string): boolean {
  return Boolean(ALLOWED_CHAT_ID) && chatId.trim() === ALLOWED_CHAT_ID;
}
