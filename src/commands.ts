import { cleanupAttachments } from './attachments.ts';
import { backgroundOutbox } from './background-outbox.ts';
import type { ChatSession, ChatState } from './chat-session.ts';
import type { ChoiceRegistry, ChoiceSpec } from './choices.ts';
import {
  CRON_JOBS_ENABLED,
  ELEVENLABS_API_KEY,
  HEARTBEAT_ENABLED,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MODEL,
  SUBAGENTS_ENABLED,
} from './config.ts';
import type { ChannelRef, ChannelStatus, CommandInfo } from './contract.ts';
import { readCronJobs } from './cron-store.ts';
import { buildElevenLabsUsageMarkdown, fetchElevenLabsUsage } from './elevenlabs-usage.ts';
import { discardPendingIngestion } from './ingestion.ts';
import { escapeMarkdown, markdownCode } from './markdown.ts';
import { defineModelChoice, modelChoice } from './model-menu.ts';
import {
  buildOpenAIUsageMarkdown,
  fetchOpenAIUsage,
  OPENAI_CODEX_PROVIDER,
} from './openai-usage.ts';
import {
  defineReasoningChoice,
  reasoningChoice,
  selectableReasoningLevels,
} from './reasoning-menu.ts';
import { runRestartGate } from './restart-flow.ts';
import { configuredTextToSpeechProviders } from './speech.ts';
import { renderStatus, type StatusSnapshot } from './status.ts';
import { errorMessage } from './util.ts';

/**
 * The core's slash commands, the same from every channel. A command answers
 * through its context rather than any one interface: `reply` sends Markdown to
 * the channel that asked, or to every channel for a change they all need to
 * know about (/new, /abort, the restart checks), and `offer` opens a menu for
 * the channel that asked. A channel's own commands (Telegram's display
 * settings, say) are the channel's, listed alongside these in its command menu
 * and in /help.
 */

export interface CommandContext {
  from: ChannelRef;
  chat: ChatState;
  session: ChatSession;
  backgroundSession: ChatSession;
  /** Shuts the bot down and exits so systemd brings it back up. */
  restart(): Promise<void>;
  /** Sends Markdown to the channel that asked, or to every channel. */
  reply(markdown: string, options?: { to?: 'all' }): void;
  /** Opens a menu for the channel that asked. */
  offer(choice: ChoiceSpec): Promise<void>;
  /** Tells every channel the conversation was reset. */
  announceReset(): void;
  /** The commands the asking channel can use: these plus its own. */
  commandList(): CommandInfo[];
  /** The settings of every attached channel that has some, for /status. */
  channelStatuses(): ChannelStatus[];
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

interface CoreCommand extends CommandInfo {
  handler: CommandHandler;
}

const CORE_COMMANDS: CoreCommand[] = [
  {
    name: 'help',
    description: 'Show commands',
    help: 'show this help',
    handler: async (ctx) => {
      ctx.reply(helpText(ctx.commandList()));
    },
  },

  {
    name: 'status',
    description: 'Show chat session status',
    help: 'show this chat session status',
    handler: async (ctx) => {
      // Loads the transcript if it is not yet, so the context and usage below are real.
      const thinking = await ctx.chat.pi.getThinkingState();
      ctx.reply(
        renderStatus(
          collectStatus(ctx.chat, ctx.backgroundSession.existing(), thinking.level, ctx),
        ),
      );
    },
  },

  {
    name: 'models',
    description: 'Switch chat model',
    help: 'choose an allowed chat model',
    handler: async (ctx) => {
      if (ctx.session.isBusy()) {
        ctx.reply(
          '⚠️ Wait for the current chat response and queue to finish before switching models.',
        );
        return;
      }
      await ctx.offer(modelChoice(ctx.session, ctx.from));
    },
  },

  {
    name: 'reasoning',
    description: 'Switch chat reasoning level',
    help: 'choose the chat reasoning level',
    handler: async (ctx) => {
      if (ctx.session.isBusy()) {
        ctx.reply(
          '⚠️ Wait for the current chat response and queue to finish before switching reasoning.',
        );
        return;
      }
      const thinking = await ctx.chat.pi.getThinkingState();
      const levels = selectableReasoningLevels(thinking.availableLevels);
      await ctx.offer(reasoningChoice(ctx.session, levels, ctx.from, thinking.level));
    },
  },

  {
    name: 'openaiusage',
    description: 'Show OpenAI Codex weekly usage',
    help: 'show OpenAI Codex seven-day usage and reset time',
    handler: async (ctx) => {
      const accessToken = await ctx.chat.pi.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
      if (!accessToken) {
        ctx.reply(
          `❌ No OpenAI Codex credentials found. Authenticate with Pi using ${markdownCode('/login openai-codex')}, or set ${markdownCode('OPENAI_CODEX_API_KEY')}.`,
        );
        return;
      }

      ctx.reply('Fetching OpenAI Codex usage...');

      try {
        const { usage, warnings } = await fetchOpenAIUsage(accessToken);
        ctx.reply(buildOpenAIUsageMarkdown(usage, warnings));
      } catch (error) {
        ctx.reply(`❌ Failed to fetch OpenAI Codex usage: ${escapeMarkdown(errorMessage(error))}`);
      }
    },
  },

  {
    name: 'elevenlabsusage',
    description: 'Show ElevenLabs usage',
    help: 'show ElevenLabs credit/character usage',
    handler: async (ctx) => {
      if (!ELEVENLABS_API_KEY) {
        ctx.reply(
          `❌ No ElevenLabs API key found. Set ${markdownCode('ELEVENLABS_API_KEY')} in .env.`,
        );
        return;
      }

      ctx.reply('Fetching ElevenLabs usage...');

      try {
        const usage = await fetchElevenLabsUsage(ELEVENLABS_API_KEY);
        ctx.reply(buildElevenLabsUsageMarkdown(usage));
      } catch (error) {
        ctx.reply(`❌ Failed to fetch ElevenLabs usage: ${escapeMarkdown(errorMessage(error))}`);
      }
    },
  },

  {
    name: 'abort',
    description: 'Stop the current Pi response',
    help: 'abort the current Pi response and clear pending messages',
    handler: async (ctx) => {
      const { chat } = ctx;
      discardPendingIngestion();
      for (const prompt of chat.queue.splice(0)) cleanupAttachments(prompt);
      // False when nothing had reached the model yet (the session was still
      // starting) or the reply was already done: no turn was cut short.
      if (chat.pi.abort()) {
        // Without this the transcript just stops mid-thought, with no way to
        // tell an interruption from a turn that chose to end there.
        await chat.pi.noteEvent('abort', 'The user aborted your previous turn before it finished.');
      }
      ctx.reply('⏹ Aborting current prompt and clearing queued/steering messages...', {
        to: 'all',
      });
    },
  },

  {
    name: 'new',
    description: "Reset this chat's Pi conversation",
    help: "clear this chat's Pi conversation",
    handler: async (ctx) => {
      const { chat } = ctx;
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
      ctx.announceReset();
      ctx.reply(
        `🔄 Started a new conversation using ${markdownCode(chat.pi.modelName)}. Reasoning: **${escapeMarkdown(thinking.level)}**.`,
        { to: 'all' },
      );
    },
  },

  {
    name: 'restart',
    description: 'Restart the bot process',
    help: 'exit this process so systemd can restart it',
    handler: async (ctx) => {
      if (!(await runRestartGate((text) => ctx.reply(text, { to: 'all' })))) return;
      await ctx.restart();
    },
  },
];

const COMMAND_HANDLERS = new Map<string, CommandHandler>(
  CORE_COMMANDS.map((command) => [`/${command.name}`, command.handler]),
);

/** The core's commands, without their handlers. */
export function coreCommands(): CommandInfo[] {
  return CORE_COMMANDS.map(({ handler: _handler, ...info }) => info);
}

/** The name a slash-command line invokes, lowercased and without a `@botname` suffix. */
export function commandName(line: string): string {
  const [commandRaw = ''] = line.trim().split(/\s+/, 1);
  return commandRaw.toLowerCase().replace(/@.+$/, '').replace(/^\//, '');
}

/** Dispatches a leading-slash command. Returns false when none matches. */
export async function handleCommand(ctx: CommandContext, text: string): Promise<boolean> {
  const handler = COMMAND_HANDLERS.get(`/${commandName(text)}`);
  if (!handler) return false;

  await handler(ctx);
  return true;
}

/** Registers the menus commands open that must keep working after a restart. */
export function defineCommandChoices(registry: ChoiceRegistry, session: ChatSession): void {
  defineModelChoice(registry, session);
  defineReasoningChoice(registry, session);
}

function helpText(commands: CommandInfo[]): string {
  return [
    escapeMarkdown('Telegram → Pi bridge commands:'),
    ...commands
      .filter((command) => !command.hideFromHelp)
      .map(
        (command) =>
          `${escapeMarkdown(`/${command.name}`)} — ${escapeMarkdown(command.help ?? command.description)}`,
      ),
  ].join('\n');
}

/** Everything /status shows, read from live state at one moment. */
function collectStatus(
  chat: ChatState,
  background: ChatState | null,
  reasoning: string,
  ctx: CommandContext,
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
    },
    channels: ctx.channelStatuses(),
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
