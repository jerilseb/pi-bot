import 'dotenv/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeModelRef, readActiveModel } from './util.ts';

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
export const ALLOWED_CHATS_PATH = path.join(FILES_DIR, 'allowed-chats.json');
export const HEARTBEAT_FILE_PATH = path.join(FILES_DIR, 'heartbeat.md');
export const HEARTBEAT_STATE_PATH = path.join(FILES_DIR, 'heartbeat-state.md');

// ---------------------------------------------------------------------------
// Environment and secrets
// ---------------------------------------------------------------------------

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? '';
export const OPENAI_CODEX_API_KEY = process.env.OPENAI_CODEX_API_KEY ?? '';
export const GOOGLE_GENAI_API_KEY =
  process.env.GOOGLE_GENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export const CHAT_MODEL = 'openai-codex/gpt-5.4-mini';
const CONFIG_BACKGROUND_MODEL = 'openai-codex/gpt-5.4-mini';
const CONFIG_SUBAGENT_MODEL = 'openai-codex/gpt-5.4-mini';
const CONFIG_ALLOWED_MODELS = [
  'openai-codex/gpt-5.4-mini',
  'openai-codex/gpt-5.5',
  'openai-codex/gpt-5.6-sol',
  'openrouter/moonshotai/kimi-k2.6',
] as const;

export const DEFAULT_MODEL = normalizeModelRef(CHAT_MODEL);
export const BACKGROUND_MODEL = normalizeModelRef(CONFIG_BACKGROUND_MODEL);
export const SUBAGENT_MODEL = normalizeModelRef(CONFIG_SUBAGENT_MODEL);
export const ALLOWED_MODELS = CONFIG_ALLOWED_MODELS.map((model) => normalizeModelRef(model)).filter(
  Boolean,
);
export const MODEL =
  readActiveModel(ACTIVE_MODEL_PATH, ALLOWED_MODELS, DEFAULT_MODEL) ?? DEFAULT_MODEL;

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
export const MAX_QUEUE_PER_CHAT = 5;
export const SEND_TOOL_CALLS = true;
export const TOOL_CALL_BATCH_MS = 5000;
export const TOOL_CALL_BATCH_MAX_ITEMS = 10;

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
// Sub-agent config
// ---------------------------------------------------------------------------

export const SUBAGENT_MAX_RUNNING = 3;
export const SUBAGENT_DEFAULT_YIELD_MS = 5_000;
export const SUBAGENT_MAX_YIELD_MS = 30_000;
export const SUBAGENT_DEFAULT_MAX_RUNTIME_MS = 10 * 60_000;
export const SUBAGENT_MAX_RUNTIME_CAP_MS = 60 * 60_000;
export const SUBAGENT_MAX_RESULT_CHARS = 6_000;
export const SUBAGENT_COMPLETED_TTL_MS = 30 * 60_000;
export const SUBAGENT_SKILLS = ['pdf'];

// ---------------------------------------------------------------------------
// Pi resources and scheduled prompt config
// ---------------------------------------------------------------------------

export const EXTENSION_ENTRYPOINT_EXTS = new Set<string>(['.ts', '.js', '.mjs', '.cjs']);
export const HEARTBEAT_ENABLED = true;
const HEARTBEAT_INTERVAL_SECONDS = 3600;
export const HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_SECONDS * 1000;

export const HEARTBEAT_NOOP = '__HEARTBEAT_NOOP__';
export const CRON_NOOP = '__CRON_NOOP__';
export const BACKGROUND_BASH_NOOP = '__BACKGROUND_BASH_NOOP__';

export interface AllowedTelegramChat {
  id: string;
  name: string;
  enabled: boolean;
  type?: string;
}

export function ensureAllowedChatsFile(): void {
  if (fs.existsSync(ALLOWED_CHATS_PATH)) return;
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.writeFileSync(ALLOWED_CHATS_PATH, '[]\n', 'utf8');
}

export function readAllowedTelegramChats(): AllowedTelegramChat[] {
  ensureAllowedChatsFile();
  const content = fs.readFileSync(ALLOWED_CHATS_PATH, 'utf8').trim();
  if (!content) return [];

  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${ALLOWED_CHATS_PATH} must contain a JSON array of allowed chats`);
  }

  const seen = new Set<string>();
  const chats: AllowedTelegramChat[] = [];
  for (let index = 0; index < parsed.length; index++) {
    const chat = parseAllowedTelegramChat(parsed[index], index);
    if (seen.has(chat.id)) continue;
    seen.add(chat.id);
    chats.push(chat);
  }
  return chats;
}

export function getAllowedTelegramChatIds(): string[] {
  return readAllowedTelegramChats()
    .filter((chat) => chat.enabled)
    .map((chat) => chat.id);
}

export function getPrivateTelegramChatIds(): string[] {
  return readAllowedTelegramChats()
    .filter((chat) => chat.enabled && chat.type === 'private')
    .map((chat) => chat.id);
}

export function getPrimaryTelegramChatId(): string {
  return getAllowedTelegramChatIds()[0] ?? '';
}

export function isAllowedTelegramChat(chatId: string): boolean {
  return getAllowedTelegramChatIds().includes(chatId.trim());
}

function parseAllowedTelegramChat(entry: unknown, index: number): AllowedTelegramChat {
  if (!isRecord(entry)) {
    throw new Error(`${ALLOWED_CHATS_PATH}[${index}] must be an object`);
  }

  const id = parseAllowedTelegramChatId(entry.id, index);
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
  const enabled = typeof entry.enabled === 'boolean' ? entry.enabled : true;
  const type = typeof entry.type === 'string' && entry.type.trim() ? entry.type.trim() : undefined;

  return {
    id,
    name,
    enabled,
    ...(type ? { type } : {}),
  };
}

function parseAllowedTelegramChatId(value: unknown, index: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${ALLOWED_CHATS_PATH}[${index}].id must be a string or number`);
  }

  const id = String(value).trim();
  if (!id) throw new Error(`${ALLOWED_CHATS_PATH}[${index}].id must not be empty`);
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
