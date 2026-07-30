import type { SessionStats } from '@earendil-works/pi-coding-agent';
import type { ChatSession, ChatState } from './chat-session.ts';
import { ELEVENLABS_API_KEY, HEARTBEAT_ENABLED, SEND_TOOL_CALLS } from './config.ts';
import { cronStatusText } from './cron.ts';
import { buildElevenLabsUsageTelegramHtml, fetchElevenLabsUsage } from './elevenlabs-usage.ts';
import { buildModelInlineKeyboard } from './model-menu.ts';
import { buildReasoningInlineKeyboard } from './reasoning-menu.ts';
import {
  buildOpenAIUsageTelegramHtml,
  fetchOpenAIUsage,
  OPENAI_CODEX_PROVIDER,
} from './openai-usage.ts';
import { discardPendingIngestion } from './inbound.ts';
import { runRestartGate } from './restart-flow.ts';
import { cancelAllSubagents, runningSubagentCount } from './subagents.ts';
import { escapeTelegramHtml } from './telegram-html.ts';
import {
  sendTelegramInlineKeyboard,
  sendTelegramMessage,
  type TelegramBotCommand,
} from './telegram.ts';
import { errorMessage } from './util.ts';
import { voiceStatusText } from './voice.ts';

export interface CommandContext {
  chat: ChatState;
  session: ChatSession;
  backgroundSession: ChatSession;
  getBackgroundModelName(): string;
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

const TOKEN_NUMBER_FORMAT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
});

function formatSessionTokens(stats: SessionStats | null): string {
  if (!stats) return 'not loaded';

  // Match pi-tps semantics: display input as billable/request input,
  // including provider cache reads and cache writes. Cache hits are cacheRead.
  const totalInput = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
  const cacheDetails = [`cache hits ${formatTokenCount(stats.tokens.cacheRead)}`];
  if (stats.tokens.cacheWrite > 0) {
    cacheDetails.push(`writes ${formatTokenCount(stats.tokens.cacheWrite)}`);
  }

  return [
    `in ${formatTokenCount(totalInput)}`,
    `(${cacheDetails.join(', ')})`,
    `out ${formatTokenCount(stats.tokens.output)}`,
  ].join(', ');
}

const TOKEN_UNITS = [
  { suffix: 'b', value: 1_000_000_000 },
  { suffix: 'm', value: 1_000_000 },
] as const;
/** Smallest abbreviated unit; anything at or above it is abbreviated. */
const TOKEN_BASE_UNIT = { suffix: 'k', value: 1_000 } as const;

function formatTokenCount(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  if (rounded < TOKEN_BASE_UNIT.value) return String(rounded);

  const unit = TOKEN_UNITS.find((candidate) => rounded >= candidate.value) ?? TOKEN_BASE_UNIT;
  return `${TOKEN_NUMBER_FORMAT.format(rounded / unit.value)}${unit.suffix}`;
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
    handler: async ({ chat, backgroundSession, getBackgroundModelName }) => {
      const uptimeSeconds = Math.floor((Date.now() - chat.startedAt) / 1000);
      const background = backgroundSession.existing();
      const thinking = await chat.pi.getThinkingState();
      await sendTelegramMessage(
        [
          'Session status:',
          `- Chat state: ${chat.processing ? 'processing' : 'idle'}`,
          `- Chat messages: ${chat.messageCount}`,
          `- Chat queue: ${chat.queue.length}`,
          `- Chat uptime: ${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`,
          `- Chat model: ${chat.pi.modelName}`,
          `- Chat reasoning: ${thinking.level}`,
          `- Session tokens: ${formatSessionTokens(chat.pi.getSessionStats())}`,
          `- Background state: ${background?.processing ? 'processing' : 'idle'}`,
          `- Background queue: ${background?.queue.length ?? 0}`,
          `- Background model: ${getBackgroundModelName()}`,
          `- Sub-agents running: ${runningSubagentCount()}`,
          `- Voice note tool: ${voiceStatusText()}`,
          `- Tool call messages: ${SEND_TOOL_CALLS ? 'on' : 'off'}`,
          `- Heartbeat: ${HEARTBEAT_ENABLED ? 'enabled' : 'off'}`,
          `- ${cronStatusText()}`,
        ].join('\n'),
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
    name: 'openaiusage',
    description: 'Show OpenAI Codex usage',
    help: 'show OpenAI Codex usage windows and reset times',
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
    help: 'abort the current Pi response',
    handler: async ({ chat }) => {
      discardPendingIngestion();
      chat.queue.length = 0;
      chat.pi.abort();
      const cancelledSubagents = await cancelAllSubagents();
      await sendTelegramMessage(
        cancelledSubagents > 0
          ? `⏹ Aborting current prompt, clearing queue, and cancelling ${cancelledSubagents} sub-agent${cancelledSubagents === 1 ? '' : 's'}...`
          : '⏹ Aborting current prompt and clearing queue...',
      );
    },
  },

  {
    name: 'new',
    description: "Reset this chat's Pi conversation",
    help: "clear this chat's Pi conversation",
    handler: async ({ chat }) => {
      discardPendingIngestion();
      chat.queue.length = 0;
      // Never force chat.processing or dispose a streaming session here: abort the
      // in-flight response and queue the session swap, which runPrompt applies in
      // its finally. When the chat is idle there is no finally coming, so apply
      // the reset immediately.
      chat.pi.abort();
      await chat.pi.requestNewSession();
      if (!chat.processing) chat.pi.reset();
      chat.messageCount = 0;
      chat.startedAt = Date.now();
      await sendTelegramMessage('🔄 Started a fresh Pi conversation for this chat.');
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
