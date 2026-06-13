import type { SessionStats } from '@earendil-works/pi-coding-agent';
import type { ChatRegistry, ChatState } from './chat-session.ts';
import { ELEVENLABS_API_KEY, HEARTBEAT_ENABLED, SEND_TOOL_CALLS } from './config.ts';
import { cronStatusText } from './cron.ts';
import { buildElevenLabsUsageTelegramHtml, fetchElevenLabsUsage } from './elevenlabs-usage.ts';
import { buildModelInlineKeyboard } from './model-menu.ts';
import {
  buildOpenAIUsageTelegramHtml,
  fetchOpenAIUsage,
  OPENAI_CODEX_PROVIDER,
} from './openai-usage.ts';
import { discardPendingIngestion } from './inbound.ts';
import { formatPreRestartDuration, runPreRestartChecks } from './pre-restart-checks.ts';
import { cancelChatSubagents, runningSubagentCount } from './subagents.ts';
import { escapeTelegramHtml, sendTelegramInlineKeyboard, sendTelegramMessage } from './telegram.ts';
import { voiceStatusText } from './voice.ts';

export interface CommandContext {
  chat: ChatState;
  registry: ChatRegistry;
  backgroundRegistry: ChatRegistry;
  getBackgroundModelName(chatId: string): string;
  /** Shuts the bot down and exits so PM2 brings it back up. */
  restart(): Promise<void>;
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

const TOKEN_NUMBER_FORMAT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
});

const HELP_TEXT = [
  'Telegram → Pi bridge commands:',
  '/status — show this chat session status',
  '/request_access — request access for a new group',
  '/models — choose an allowed chat model',
  '/openaiusage — show OpenAI Codex usage windows and reset times',
  '/elevenlabsusage — show ElevenLabs credit/character usage',
  '/abort — abort the current Pi response',
  "/new — clear this chat's Pi conversation",
  '/restart — exit this process so PM2 can restart it',
  '/help — show this help',
].join('\n');

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

function formatTokenCount(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  if (rounded < 1000) return String(rounded);

  const units = [
    { suffix: 'b', value: 1_000_000_000 },
    { suffix: 'm', value: 1_000_000 },
    { suffix: 'k', value: 1_000 },
  ] as const;
  const unit = units.find((candidate) => rounded >= candidate.value);
  if (!unit) return String(rounded);

  return `${TOKEN_NUMBER_FORMAT.format(rounded / unit.value)}${unit.suffix}`;
}

const COMMANDS: Record<string, CommandHandler> = {
  '/start': async ({ chat }) => {
    await sendTelegramMessage(
      chat.chatId,
      "👋 Hi! Send me a message and I'll ask Pi. Use /help for commands.",
    );
  },

  '/help': async ({ chat }) => {
    await sendTelegramMessage(chat.chatId, HELP_TEXT);
  },

  '/status': async ({ chat, backgroundRegistry, getBackgroundModelName }) => {
    const uptimeSeconds = Math.floor((Date.now() - chat.startedAt) / 1000);
    const background = backgroundRegistry.getExisting(chat.chatId);
    await sendTelegramMessage(
      chat.chatId,
      [
        'Session status:',
        `- Chat state: ${chat.processing ? 'processing' : 'idle'}`,
        `- Chat messages: ${chat.messageCount}`,
        `- Chat queue: ${chat.queue.length}`,
        `- Chat uptime: ${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`,
        `- Chat model: ${chat.pi.modelName}`,
        `- Session tokens: ${formatSessionTokens(chat.pi.getSessionStats())}`,
        `- Background state: ${background?.processing ? 'processing' : 'idle'}`,
        `- Background queue: ${background?.queue.length ?? 0}`,
        `- Background model: ${getBackgroundModelName(chat.chatId)}`,
        `- Sub-agents running: ${runningSubagentCount(chat.chatId)}`,
        `- Voice note tool: ${voiceStatusText()}`,
        `- Tool call messages: ${SEND_TOOL_CALLS ? 'on' : 'off'}`,
        `- Heartbeat: ${HEARTBEAT_ENABLED ? 'enabled' : 'off'}`,
        `- ${cronStatusText()}`,
      ].join('\n'),
    );
  },

  '/models': async ({ chat, registry }) => {
    if (registry.isBusy(chat.chatId)) {
      await sendTelegramMessage(
        chat.chatId,
        '⚠️ Wait for the current chat response and queue to finish before switching models.',
      );
      return;
    }

    await sendTelegramInlineKeyboard(
      chat.chatId,
      [`Current chat model: ${chat.pi.modelName}`, 'Choose a chat model:'].join('\n'),
      buildModelInlineKeyboard(),
    );
  },

  '/openaiusage': async ({ chat }) => {
    const accessToken = await chat.pi.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
    if (!accessToken) {
      await sendTelegramMessage(
        chat.chatId,
        '❌ No OpenAI Codex credentials found. Authenticate with Pi using /login openai-codex, or set OPENAI_CODEX_API_KEY.',
      );
      return;
    }

    await sendTelegramMessage(chat.chatId, 'Fetching OpenAI Codex usage...');

    try {
      const { usage, warnings } = await fetchOpenAIUsage(accessToken);
      await sendTelegramMessage(chat.chatId, buildOpenAIUsageTelegramHtml(usage, warnings));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sendTelegramMessage(
        chat.chatId,
        `❌ Failed to fetch OpenAI Codex usage: ${escapeTelegramHtml(message)}`,
      );
    }
  },

  '/elevenlabsusage': async ({ chat }) => {
    if (!ELEVENLABS_API_KEY) {
      await sendTelegramMessage(
        chat.chatId,
        '❌ No ElevenLabs API key found. Set ELEVENLABS_API_KEY in .env.',
      );
      return;
    }

    await sendTelegramMessage(chat.chatId, 'Fetching ElevenLabs usage...');

    try {
      const usage = await fetchElevenLabsUsage(ELEVENLABS_API_KEY);
      await sendTelegramMessage(chat.chatId, buildElevenLabsUsageTelegramHtml(usage));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sendTelegramMessage(
        chat.chatId,
        `❌ Failed to fetch ElevenLabs usage: ${escapeTelegramHtml(message)}`,
      );
    }
  },

  '/abort': async ({ chat }) => {
    discardPendingIngestion(chat.chatId);
    chat.queue.length = 0;
    chat.pi.abort();
    const cancelledSubagents = await cancelChatSubagents(chat.chatId);
    await sendTelegramMessage(
      chat.chatId,
      cancelledSubagents > 0
        ? `⏹ Aborting current prompt, clearing queue, and cancelling ${cancelledSubagents} sub-agent${cancelledSubagents === 1 ? '' : 's'}...`
        : '⏹ Aborting current prompt and clearing queue...',
    );
  },

  '/new': async ({ chat }) => {
    discardPendingIngestion(chat.chatId);
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
    await sendTelegramMessage(chat.chatId, '🔄 Started a fresh Pi conversation for this chat.');
  },

  '/restart': async ({ chat, restart }) => {
    await sendTelegramMessage(chat.chatId, '🧪 Running pre-restart checks...');

    const checks = await runPreRestartChecks();
    if (!checks.ok) {
      await sendTelegramMessage(
        chat.chatId,
        [
          `❌ Restart blocked. Pre-restart checks failed after ${formatPreRestartDuration(checks.durationMs)}.`,
          '',
          `<pre><code>${escapeTelegramHtml(checks.output)}</code></pre>`,
        ].join('\n'),
      );
      return;
    }

    await sendTelegramMessage(
      chat.chatId,
      `✅ Pre-restart checks passed in ${formatPreRestartDuration(checks.durationMs)}. Restarting bot process. PM2 should bring it back up shortly.`,
    );
    await restart();
  },
};

/** Dispatches a leading-slash command. Returns false when none matches. */
export async function handleCommand(ctx: CommandContext, text: string): Promise<boolean> {
  const [commandRaw] = text.split(/\s+/, 1);
  const command = commandRaw.toLowerCase().replace(/@.+$/, '');

  const handler = COMMANDS[command];
  if (!handler) return false;

  await handler(ctx);
  return true;
}
