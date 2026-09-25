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
/**
 * Sub-agent worker transcripts. A subdirectory, not SESSIONS_DIR itself: the
 * SDK's session listing is not recursive and the chat session lists SESSIONS_DIR
 * on every start, which must not mean parsing every worker transcript ever kept.
 */
export const SUBAGENT_SESSIONS_DIR = path.join(SESSIONS_DIR, 'subagent-sessions');
/**
 * Background-session transcripts, one per run: heartbeat runs and scheduled-task
 * runs each in their own directory, so neither is mistaken for the other.
 * Subdirectories for the same reason as SUBAGENT_SESSIONS_DIR.
 */
export const HEARTBEAT_SESSIONS_DIR = path.join(SESSIONS_DIR, 'heartbeat-sessions');
export const SCHEDULED_TASKS_SESSIONS_DIR = path.join(SESSIONS_DIR, 'scheduled-tasks-sessions');
export const TMP_DIR = path.join(os.tmpdir(), 'pi-channel');

export const PROJECT_EXTENSIONS_DIR = path.join(PROJECT_ROOT, 'extensions');
export const FILES_DIR = path.join(PROJECT_ROOT, 'files');
export const BOT_SETTINGS_PATH = path.join(FILES_DIR, 'settings.json');
export const SYSTEM_PROMPT_PATH = path.join(FILES_DIR, 'system.md');
export const MEMORY_PATH = path.join(FILES_DIR, 'memory.md');
export const DAILY_MEMORY_DIR = path.join(FILES_DIR, 'memory');
export const CRON_JOBS_PATH = path.join(FILES_DIR, 'cron-jobs.json');
export const POST_RESTART_TASKS_PATH = path.join(FILES_DIR, 'post-restart-tasks.json');
export const HEARTBEAT_FILE_PATH = path.join(FILES_DIR, 'heartbeat.md');
export const HEARTBEAT_STATE_PATH = path.join(FILES_DIR, 'heartbeat-state.md');
/** System prompt for sub-agent workers; created with a default on first start. */
export const SUBAGENT_PROMPT_PATH = path.join(FILES_DIR, 'subagent.md');

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
/**
 * Sub-agents run only when .env sets ENABLE_SUBAGENTS=true. Off by default: a
 * worker is a whole extra agent with tool access spending tokens on its own, so
 * turning that on is a deployment decision. Read at startup; the tools are not
 * registered at all while it is off. The raw value is kept for validation, so a
 * misspelling is a startup error rather than a silently disabled feature.
 */
export const ENABLE_SUBAGENTS = process.env.ENABLE_SUBAGENTS?.trim() ?? '';
export const SUBAGENTS_ENABLED = ENABLE_SUBAGENTS.toLowerCase() === 'true';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Default chat model. files/settings.json overrides it; see MODEL below. */
export const CHAT_MODEL = 'openai-codex/gpt-6-luna';
/**
 * Model for heartbeat runs, as provider/model. It lives in .env rather than here
 * because which model an unprompted run may use is a deployment choice that
 * tracks the provider keys available, not a product default.
 *
 * Unset means the heartbeat does not run. Enabling it in files/settings.json
 * without setting its model is a startup error rather than a silent no-op, so a
 * half-configured heartbeat cannot look healthy until the moment it fails to
 * fire. Not changeable from Telegram.
 *
 * Scheduled tasks need nothing here: each task is pinned at creation to the
 * chat model active at that moment (the /models selection), unless the user
 * asked for a specific model for it.
 */
export const HEARTBEAT_MODEL = process.env.HEARTBEAT_MODEL?.trim() ?? '';
/** Chat models offered by /models. Must contain CHAT_MODEL and the active model. */
export const ALLOWED_MODELS: readonly string[] = [
  'openai-codex/gpt-6-astra',
  'openai-codex/gpt-6-luna',
  'openai-codex/gpt-6-sol',
  'openrouter/deepseek/deepseek-v4.1-flash',
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
  toolCalls?: unknown;
  showTranscripts?: unknown;
  subagentToolCalls?: unknown;
}

function readBotSettings(): BotSettings {
  if (!fs.existsSync(BOT_SETTINGS_PATH)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(BOT_SETTINGS_PATH, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${BOT_SETTINGS_PATH} must contain a JSON object`);
  }
  return parsed as BotSettings;
}

/**
 * Merges one bot-only key into settings.json without touching the rest, the
 * same contract Pi's SettingsManager honours in the other direction.
 */
function updateBotSettings(patch: Partial<Record<keyof BotSettings, unknown>>): void {
  const current = readBotSettings();
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.writeFileSync(
    BOT_SETTINGS_PATH,
    `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`,
    'utf8',
  );
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
        toolCalls: DEFAULT_TOOL_CALL_MODE,
        showTranscripts: false,
        subagentToolCalls: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Telegram: the Bot API, its limits, and how the Telegram channel shows things
//
// Telegram's rate limits are the reason for every interval here; the core
// announces every change and the Telegram channel paces its own edits.
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

/**
 * How tool calls reach the chat. `stream` sends a new message per batch,
 * `collapsed` keeps one expandable message per prompt and edits it in place,
 * `off` sends nothing. Persisted in files/settings.json as `toolCalls` and
 * switched from Telegram with /toolcalls, so it is read fresh rather than
 * frozen at startup like `heartbeat` and `cronJobs`.
 */
export const TOOL_CALL_MODES = ['stream', 'collapsed', 'off'] as const;
export type ToolCallMode = (typeof TOOL_CALL_MODES)[number];
export const DEFAULT_TOOL_CALL_MODE: ToolCallMode = 'collapsed';

export function isToolCallMode(value: unknown): value is ToolCallMode {
  return typeof value === 'string' && TOOL_CALL_MODES.some((mode) => mode === value);
}

/** The mode as settings.json currently holds it. Read at the start of a prompt. */
export function toolCallMode(): ToolCallMode {
  try {
    const { toolCalls } = readBotSettings();
    return isToolCallMode(toolCalls) ? toolCalls : DEFAULT_TOOL_CALL_MODE;
  } catch (error) {
    console.error('failed to read the tool call mode:', error);
    return DEFAULT_TOOL_CALL_MODE;
  }
}

export function setToolCallMode(mode: ToolCallMode): void {
  updateBotSettings({ toolCalls: mode });
}

/**
 * Whether a voice note's speech-to-text transcript is echoed back to the
 * chat. Persisted in files/settings.json as `showTranscripts` and switched
 * from Telegram with /transcripts, so it is read fresh rather than frozen at
 * startup like `heartbeat` and `cronJobs`.
 */
export function showTranscriptsEnabled(): boolean {
  try {
    return readBotSettings().showTranscripts === true;
  } catch (error) {
    console.error('failed to read the transcript setting:', error);
    return false;
  }
}

export function setShowTranscripts(enabled: boolean): void {
  updateBotSettings({ showTranscripts: enabled });
}

/**
 * Whether a sub-agent job's progress message shows each worker's tool calls,
 * replaced by its result once it finishes. Off by default, which keeps the
 * message to one line per task. Persisted in files/settings.json as
 * `subagentToolCalls` and switched from Telegram with /subagent_toolcalls; read
 * at every render, so a switch reaches running jobs too.
 */
export function subagentToolCallsEnabled(): boolean {
  try {
    return readBotSettings().subagentToolCalls === true;
  } catch (error) {
    console.error('failed to read the sub-agent tool call setting:', error);
    return false;
  }
}

export function setSubagentToolCalls(enabled: boolean): void {
  updateBotSettings({ subagentToolCalls: enabled });
}

export const TOOL_CALL_BATCH_MS = 10_000;
export const TOOL_CALL_BATCH_MAX_ITEMS = 10;
/**
 * Budget for the collapsed message body. Well under TELEGRAM_MAX_MESSAGE so the
 * header and blockquote tags always fit; lines past it are counted, not shown.
 */
export const TOOL_CALL_COLLAPSED_MAX_CHARS = 3_500;

/**
 * The heartbeat of the live progress message a job started from the chat keeps
 * in Telegram (src/channels/telegram/job-progress.ts): it is re-rendered this
 * often even when nothing happened, so its clock moves. Each refresh is at most
 * one Telegram edit and no model call. Also how long a message waits after a
 * failed write before trying again, so a Telegram rate limit does not use up
 * its retries in seconds.
 */
export const JOB_PROGRESS_UPDATE_MS = 20_000;
/**
 * Shortest gap between two routine writes of one live progress message. Changes
 * in between (a worker's tool call, a line of output) are coalesced into the
 * next write, which renders the state as it is then.
 */
export const JOB_PROGRESS_MIN_EDIT_MS = 3_000;
/**
 * Shortest gap between routine writes across all live progress messages, since
 * the per-message gap does not bound the total when many jobs run at once. With
 * no Telegram 429 handling, this and the two intervals above are the only rate
 * protection.
 */
export const JOB_PROGRESS_GLOBAL_MIN_GAP_MS = 1_000;

// ---------------------------------------------------------------------------
// Interfaces: the channels (Telegram, later a terminal UI) that use the core
// ---------------------------------------------------------------------------

/**
 * How recently a channel must have been used for something unprompted (a
 * background report, a heartbeat or cron message) to alert it rather than
 * every durable channel. See src/core.ts.
 */
export const ACTIVE_WINDOW_MS = 10 * 60_000;
/**
 * How long shutdown waits for each channel to finish its pending sends. Each
 * channel sends in the background, in event order, so a reply or error may
 * still be going out when the process is asked to exit.
 */
export const CHANNEL_DRAIN_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Queueing and response behavior
// ---------------------------------------------------------------------------

export const MAX_QUEUED_PROMPTS = 5;
// The Pi SDK already retries transient failures (3 attempts by default). After
// that budget is exhausted, the foreground chat gets one fresh continuation
// turn rather than replaying the original user prompt and its tool side effects.
export const TRANSPORT_RECOVERY_MAX_CONTINUATIONS = 1;
export const TRANSPORT_RECOVERY_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Usage commands (/openaiusage, /elevenlabsusage)
// ---------------------------------------------------------------------------

/** Deadline for each provider usage request, unless the caller passes a signal. */
export const USAGE_FETCH_TIMEOUT_MS = 30_000;

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
export const LOCAL_IMAGE_UPLOAD_DIRS = [TMP_DIR];

export const SEND_LOCAL_DOCUMENTS = true;
export const LOCAL_DOCUMENT_UPLOAD_DIRS = [TMP_DIR, process.cwd()];
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
// Background work: background runs, background bash, and sub-agents
//
// Every concurrency limit, timeout, TTL, and payload cap for background work
// belongs in this section — only narrow display widths stay next to the
// formatter that uses them.
// ---------------------------------------------------------------------------

/**
 * How long the chat must be idle — no turn running or queued, no new message —
 * before anything a background run (scheduled task, heartbeat, or the job
 * reports they get) sends is delivered. See src/background-outbox.ts.
 */
export const BACKGROUND_DELIVERY_COOLDOWN_MS = 5 * 60_000;
/** How often held background deliveries recheck the chat while it is busy. */
export const BACKGROUND_DELIVERY_POLL_MS = 15_000;

export const BACKGROUND_BASH_MAX_RUNNING = 12;
export const BACKGROUND_BASH_DEFAULT_YIELD_MS = 4_000;
export const BACKGROUND_BASH_MAX_YIELD_MS = 30_000;
export const BACKGROUND_BASH_DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
export const BACKGROUND_BASH_MAX_RUNTIME_CAP_MS = 24 * 60 * 60_000;
export const BACKGROUND_BASH_REPORT_OUTPUT_MAX_CHARS = 3_000;
export const BACKGROUND_BASH_COMPLETED_TTL_MS = 30 * 60_000;
/** How long background_bash_stop waits for a signalled session to settle. */
export const BACKGROUND_BASH_STOP_WAIT_MS = 5_000;
/**
 * Guidance, not a limit: a background command the agent expects to run longer
 * than this, or that is still running after it, should end the agent's turn,
 * with the completion report resuming the work in the same conversation. Shorter
 * ones may be waited for. Stated to the agent in the background bash tools; a
 * backgrounded sub-agent job always ends the turn, so the chat is free while
 * its workers run.
 */
export const BACKGROUND_JOB_END_TURN_AFTER_MS = 3 * 60_000;
/**
 * Longest (and default) background_bash_wait. Equal to the end-your-turn
 * threshold: a command worth waiting for in the turn is one expected to finish
 * within it, and one that outlasts the wait should end the turn.
 */
export const BACKGROUND_WAIT_MAX_MS = BACKGROUND_JOB_END_TURN_AFTER_MS;
/** How often a wait with an `until` pattern checks the command's new output. */
export const BACKGROUND_WAIT_CHECK_MS = 250;
/** Unseen output a background_bash_wait returns; the tail is kept. */
export const BACKGROUND_BASH_WAIT_OUTPUT_MAX_CHARS = 3_000;

/** Jobs (one subagent_run call each) that may be running at once. */
export const SUBAGENT_MAX_RUNNING_JOBS = 8;
/** Tasks one subagent_run call may carry. */
export const SUBAGENT_MAX_TASKS_PER_JOB = 4;
/**
 * Worker sessions running at once across all jobs. A job with more tasks than
 * free slots starts what it can and runs the rest as slots open.
 */
export const SUBAGENT_MAX_CONCURRENT_WORKERS = 4;
export const SUBAGENT_DEFAULT_YIELD_MS = 30_000;
export const SUBAGENT_MAX_YIELD_MS = 120_000;
export const SUBAGENT_DEFAULT_MAX_RUNTIME_MS = 15 * 60_000;
export const SUBAGENT_MAX_RUNTIME_CAP_MS = 2 * 60 * 60_000;
/** Per task, in reports and subagent_read output. */
export const SUBAGENT_RESULT_MAX_CHARS = 12_000;
export const SUBAGENT_COMPLETED_TTL_MS = 30 * 60_000;
/** How long subagent_stop waits for signalled workers to settle. */
export const SUBAGENT_STOP_WAIT_MS = 5_000;

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
export const SUBAGENT_NOOP = '__SUBAGENT_NOOP__';

/** True only for the single chat configured via TELEGRAM_ALLOWED_CHAT_ID. */
export function isAllowedTelegramChat(chatId: string): boolean {
  return Boolean(ALLOWED_CHAT_ID) && chatId.trim() === ALLOWED_CHAT_ID;
}
