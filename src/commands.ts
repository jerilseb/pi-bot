import { backgroundOutbox } from './background-outbox.ts';
import type { ChatSession, ChatState } from './chat-session.ts';
import {
  CRON_JOBS_ENABLED,
  ELEVENLABS_API_KEY,
  HEARTBEAT_ENABLED,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MODEL,
  SUBAGENTS_ENABLED,
  showTranscriptsEnabled,
  subagentToolCallsEnabled,
  toolCallMode,
} from './config.ts';
import { readCronJobs } from './cron-store.ts';
import { configuredTextToSpeechProviders } from './speech.ts';
import { renderStatus, type StatusSnapshot } from './status.ts';
import { buildElevenLabsUsageTelegramHtml, fetchElevenLabsUsage } from './elevenlabs-usage.ts';
import { buildModelInlineKeyboard } from './model-menu.ts';
import { buildReasoningInlineKeyboard } from './reasoning-menu.ts';
import {
  buildSubagentToolCallInlineKeyboard,
  describeSubagentToolCallSetting,
} from './subagent-tool-call-menu.ts';
import { buildToolCallInlineKeyboard, describeToolCallMode } from './tool-call-menu.ts';
import { buildTranscriptInlineKeyboard, describeTranscriptSetting } from './transcript-menu.ts';
import {
  buildOpenAIUsageTelegramHtml,
  fetchOpenAIUsage,
  OPENAI_CODEX_PROVIDER,
} from './openai-usage.ts';
import { cleanupAttachments } from './attachments.ts';
import { discardPendingIngestion } from './channels/telegram/inbound.ts';
import { runRestartGate } from './restart-flow.ts';
import { escapeTelegramHtml } from './channels/telegram/telegram-html.ts';
import {
  sendTelegramInlineKeyboard,
  sendTelegramMessage,
  type TelegramBotCommand,
} from './channels/telegram/telegram.ts';
import { errorMessage } from './util.ts';

export interface CommandContext {
  chat: ChatState;
  session: ChatSession;
  backgroundSession: ChatSession;
  /** Shuts the bot down and exits so systemd brings it back up. */
  restart(): Promise<void>;
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

/**
 * One slash command. This is the single source of truth for the Telegram
 * command menu, the /help listing, and dispatch, so the three cannot drift.
 */
interface BotCommand {
  /** Command name without the leading slash. */
  name: string;
  /** Short line shown in the Telegram command menu. */
  description: string;
  /** Longer line shown by /help. Falls back to description. */
  help?: string;
  /** Set only for commands deliberately kept out of /help. */
  hideFromHelp?: boolean;
  handler: CommandHandler;
}

const BOT_COMMANDS: BotCommand[] = [
  {
    name: 'start',
    description: 'Say hi',
    // Conventional Telegram entry point; it carries no information for /help.
    hideFromHelp: true,
    handler: async () => {
      await sendTelegramMessage(
        "👋 Hi! Send me a message and I'll ask Pi. Use /help for commands.",
      );
    },
  },

  {
    name: 'help',
    description: 'Show commands',
    help: 'show this help',
    handler: async () => {
      await sendTelegramMessage(HELP_TEXT);
    },
  },

  {
    name: 'status',
    description: 'Show chat session status',
    help: 'show this chat session status',
    handler: async ({ chat, backgroundSession }) => {
      // Loads the transcript if it is not yet, so the context and usage below are real.
      const thinking = await chat.pi.getThinkingState();
      await sendTelegramMessage(
        renderStatus(collectStatus(chat, backgroundSession.existing(), thinking.level)),
      );
    },
  },

  {
    name: 'models',
    description: 'Switch chat model',
    help: 'choose an allowed chat model',
    handler: async ({ chat, session }) => {
      if (session.isBusy()) {
        await sendTelegramMessage(
          '⚠️ Wait for the current chat response and queue to finish before switching models.',
        );
        return;
      }

      await sendTelegramInlineKeyboard(
        [`Current chat model: ${chat.pi.modelName}`, 'Choose a chat model:'].join('\n'),
        buildModelInlineKeyboard(),
      );
    },
  },

  {
    name: 'reasoning',
    description: 'Switch chat reasoning level',
    help: 'choose the chat reasoning level',
    handler: async ({ chat, session }) => {
      if (session.isBusy()) {
        await sendTelegramMessage(
          '⚠️ Wait for the current chat response and queue to finish before switching reasoning.',
        );
        return;
      }

      const thinking = await chat.pi.getThinkingState();
      await sendTelegramInlineKeyboard(
        [
          `Current chat model: ${chat.pi.modelName}`,
          `Current reasoning: ${thinking.level}`,
          'Choose a reasoning level:',
        ].join('\n'),
        buildReasoningInlineKeyboard(thinking.availableLevels),
      );
    },
  },

  {
    name: 'toolcalls',
    description: 'Choose how tool calls are shown',
    help: 'choose how Pi’s tool calls are shown in the chat',
    handler: async () => {
      await sendTelegramInlineKeyboard(
        [
          `Current: ${describeToolCallMode(toolCallMode())}`,
          'Choose how tool calls are shown:',
        ].join('\n'),
        buildToolCallInlineKeyboard(),
      );
    },
  },

  {
    name: 'transcripts',
    description: 'Choose whether voice transcripts are sent back',
    help: 'choose whether a voice note transcript is sent back to the chat',
    handler: async () => {
      await sendTelegramInlineKeyboard(
        [
          `Current: ${describeTranscriptSetting(showTranscriptsEnabled())}`,
          'Send the voice note transcript back to the chat?',
        ].join('\n'),
        buildTranscriptInlineKeyboard(),
      );
    },
  },

  {
    name: 'subagent_toolcalls',
    description: 'Choose whether sub-agent progress shows tool calls',
    help: 'choose whether a sub-agent job’s progress message shows each worker’s tool calls, then its result',
    handler: async () => {
      await sendTelegramInlineKeyboard(
        [
          `Current: ${describeSubagentToolCallSetting(subagentToolCallsEnabled())}`,
          'Show each worker’s tool calls in the sub-agent progress message?',
        ].join('\n'),
        buildSubagentToolCallInlineKeyboard(),
      );
    },
  },

  {
    name: 'openaiusage',
    description: 'Show OpenAI Codex weekly usage',
    help: 'show OpenAI Codex seven-day usage and reset time',
    handler: async ({ chat }) => {
      const accessToken = await chat.pi.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
      if (!accessToken) {
        await sendTelegramMessage(
          '❌ No OpenAI Codex credentials found. Authenticate with Pi using /login openai-codex, or set OPENAI_CODEX_API_KEY.',
        );
        return;
      }

      await sendTelegramMessage('Fetching OpenAI Codex usage...');

      try {
        const { usage, warnings } = await fetchOpenAIUsage(accessToken);
        await sendTelegramMessage(buildOpenAIUsageTelegramHtml(usage, warnings));
      } catch (error) {
        await sendTelegramMessage(
          `❌ Failed to fetch OpenAI Codex usage: ${escapeTelegramHtml(errorMessage(error))}`,
        );
      }
    },
  },

  {
    name: 'elevenlabsusage',
    description: 'Show ElevenLabs usage',
    help: 'show ElevenLabs credit/character usage',
    handler: async () => {
      if (!ELEVENLABS_API_KEY) {
        await sendTelegramMessage(
          '❌ No ElevenLabs API key found. Set ELEVENLABS_API_KEY in .env.',
        );
        return;
      }

      await sendTelegramMessage('Fetching ElevenLabs usage...');

      try {
        const usage = await fetchElevenLabsUsage(ELEVENLABS_API_KEY);
        await sendTelegramMessage(buildElevenLabsUsageTelegramHtml(usage));
      } catch (error) {
        await sendTelegramMessage(
          `❌ Failed to fetch ElevenLabs usage: ${escapeTelegramHtml(errorMessage(error))}`,
        );
      }
    },
  },

  {
    name: 'abort',
    description: 'Stop the current Pi response',
    help: 'abort the current Pi response and clear pending messages',
    handler: async ({ chat }) => {
      discardPendingIngestion();
      for (const prompt of chat.queue.splice(0)) cleanupAttachments(prompt);
      // False when nothing had reached the model yet (the session was still
      // starting) or the reply was already done: no turn was cut short.
      if (chat.pi.abort()) {
        // Without this the transcript just stops mid-thought, with no way to
        // tell an interruption from a turn that chose to end there.
        await chat.pi.noteEvent('abort', 'The user aborted your previous turn before it finished.');
      }
      await sendTelegramMessage(
        '⏹ Aborting current prompt and clearing queued/steering messages...',
      );
    },
  },

  {
    name: 'new',
    description: "Reset this chat's Pi conversation",
    help: "clear this chat's Pi conversation",
    handler: async ({ chat }) => {
      discardPendingIngestion();
      for (const prompt of chat.queue.splice(0)) cleanupAttachments(prompt);
      // Never force chat.processing or dispose a streaming session here: abort the
      // in-flight response and queue the session swap, which runPrompt applies in
      // its finally, or at the start of the next run if the reply is still being
      // delivered. When the chat is idle, apply the reset immediately.
      chat.pi.abort();
      const thinking = await chat.pi.getThinkingState();
      await chat.pi.requestNewSession();
      if (!chat.processing) chat.pi.reset();
      chat.messageCount = 0;
      chat.startedAt = Date.now();
      await sendTelegramMessage(
        `🔄 Started a new conversation using <code>${escapeTelegramHtml(chat.pi.modelName)}</code>. Reasoning: <b>${escapeTelegramHtml(thinking.level)}</b>.`,
      );
    },
  },

  {
    name: 'restart',
    description: 'Restart the bot process',
    help: 'exit this process so systemd can restart it',
    handler: async ({ restart }) => {
      if (!(await runRestartGate())) return;
      await restart();
    },
  },
];

const HELP_TEXT = [
  'Telegram → Pi bridge commands:',
  ...BOT_COMMANDS.filter((command) => !command.hideFromHelp).map(
    (command) => `/${command.name} — ${command.help ?? command.description}`,
  ),
].join('\n');

const COMMAND_HANDLERS = new Map<string, CommandHandler>(
  BOT_COMMANDS.map((command) => [`/${command.name}`, command.handler]),
);

/** The Telegram command menu, registered with the Bot API on startup. */
export function telegramCommandMenu(): TelegramBotCommand[] {
  return BOT_COMMANDS.map(({ name, description }) => ({ command: name, description }));
}

/** Dispatches a leading-slash command. Returns false when none matches. */
export async function handleCommand(ctx: CommandContext, text: string): Promise<boolean> {
  const [commandRaw] = text.split(/\s+/, 1);
  const command = commandRaw.toLowerCase().replace(/@.+$/, '');

  const handler = COMMAND_HANDLERS.get(command);
  if (!handler) return false;

  await handler(ctx);
  return true;
}

/** Everything /status shows, read from live state at one moment. */
function collectStatus(
  chat: ChatState,
  background: ChatState | null,
  reasoning: string,
): StatusSnapshot {
  const stats = chat.pi.getSessionStats();
  const context = chat.pi.getContextUsage();
  const voice = configuredTextToSpeechProviders();
  return {
    chat: {
      processing: chat.processing,
      model: chat.pi.modelName,
      reasoning,
      messages: chat.messageCount,
      queue: chat.queue.length,
      steering: chat.pi.pendingSteeringCount,
      uptimeMs: Date.now() - chat.startedAt,
    },
    ...(context ? { context } : {}),
    ...(stats ? { tokens: { ...stats.tokens, cost: stats.cost } } : {}),
    background: {
      loaded: Boolean(background),
      processing: Boolean(background?.processing),
      queue: background?.queue.length ?? 0,
      model: background?.pi.modelName ?? '',
      held: backgroundOutbox()?.heldCount ?? 0,
    },
    features: {
      voice: { on: voice.length > 0, detail: voice.length ? voice.join(', ') : 'not configured' },
      heartbeat: heartbeatFeature(),
      cron: cronFeature(),
      subagents: SUBAGENTS_ENABLED,
      toolCalls: describeToolCallMode(toolCallMode()),
      transcripts: showTranscriptsEnabled(),
      subagentToolCalls: subagentToolCallsEnabled(),
    },
  };
}

function heartbeatFeature(): { on: boolean; detail: string } {
  if (!HEARTBEAT_ENABLED || !HEARTBEAT_MODEL) return { on: false, detail: 'off' };
  const minutes = Math.round(HEARTBEAT_INTERVAL_MS / 60_000);
  return { on: true, detail: `every ${minutes}m on ${HEARTBEAT_MODEL}` };
}

function cronFeature(): { on: boolean; detail: string } {
  if (!CRON_JOBS_ENABLED) return { on: false, detail: 'off' };
  try {
    const jobs = readCronJobs();
    const active = jobs.filter((job) => job.enabled).length;
    return { on: true, detail: `${active} of ${jobs.length} active` };
  } catch (error) {
    return { on: true, detail: `error: ${errorMessage(error)}` };
  }
}
