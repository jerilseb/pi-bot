import type { ChannelStatus } from './contract.ts';
import { usageBar } from './format.ts';
import { escapeMarkdown, markdownCode, markdownCodeBlock, markdownQuote } from './markdown.ts';

/**
 * The /status message, rendered as Markdown from a plain snapshot so the
 * layout is pure and testable. commands.ts gathers the snapshot; nothing here
 * reads live state.
 *
 * Layout: a header, then one section per concern — chat, context, tokens,
 * background, features, then each attached interface's own settings — each a
 * bold emoji title with its details below. Long values (paths, raw setting
 * names) are left to /help and the logs; this is a glance, not a config dump.
 */

export interface StatusContext {
  /** Estimated tokens in use, or null right after a compaction until the next reply. */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface StatusSnapshot {
  chat: {
    processing: boolean;
    model: string;
    reasoning: string;
    messages: number;
    queue: number;
    steering: number;
    uptimeMs: number;
  };
  /** Undefined when no transcript is loaded yet. */
  context?: StatusContext;
  /** Undefined when no transcript is loaded yet. */
  tokens?: { input: number; cacheRead: number; cacheWrite: number; output: number; cost: number };
  background: {
    loaded: boolean;
    processing: boolean;
    queue: number;
    model: string;
    /** Messages waiting for the chat's idle cooldown (src/background-outbox.ts). */
    held?: number;
  };
  features: {
    voice: { on: boolean; detail: string };
    heartbeat: { on: boolean; detail: string };
    cron: { on: boolean; detail: string };
    subagents: boolean;
  };
  /** The settings of each attached interface that has some. */
  channels: ChannelStatus[];
}

export function renderStatus(snapshot: StatusSnapshot): string {
  return [
    '📊 **Pi Bot · Status**',
    '',
    ...chatSection(snapshot.chat),
    '',
    ...contextSection(snapshot.context),
    '',
    ...tokenSection(snapshot.tokens),
    '',
    ...backgroundSection(snapshot.background),
    '',
    ...featureSection(snapshot.features),
    ...snapshot.channels.flatMap((channel) => ['', ...channelSection(channel)]),
  ].join('\n');
}

function chatSection(chat: StatusSnapshot['chat']): string[] {
  const state = chat.processing ? '🟡 working' : '🟢 idle';
  const pending = [`📥 Queue **${chat.queue}**`, `↪️ Steering **${chat.steering}**`];
  return [
    `💬 **Chat** · ${state}`,
    markdownQuote([
      `🤖 ${markdownCode(chat.model)}`,
      `💡 Reasoning **${escapeMarkdown(chat.reasoning)}**`,
      pending.join(' · '),
      `✉️ ${chat.messages} message${chat.messages === 1 ? '' : 's'} · ⏱ up ${formatUptime(chat.uptimeMs)}`,
    ]),
  ];
}

function contextSection(context: StatusContext | undefined): string[] {
  if (!context) return ['🧠 **Context** · _no session loaded_'];
  const window = compactTokens(context.contextWindow);
  if (context.tokens === null || context.percent === null) {
    return [
      `🧠 **Context** · ? / ${window}`,
      '_Just compacted — measured again after the next reply._',
    ];
  }
  const percent = Math.round(context.percent);
  const free = Math.max(0, context.contextWindow - context.tokens);
  return [
    `🧠 **Context** · ${contextLight(context.percent)} ${percent}% used`,
    markdownCode(usageBar(context.percent, 20)),
    `${compactTokens(context.tokens)} of ${window} · ${compactTokens(free)} free`,
  ];
}

function tokenSection(tokens: StatusSnapshot['tokens']): string[] {
  if (!tokens) return ['💰 **Session usage** · _no session loaded_'];
  // Input counts what was billed as input: fresh tokens plus cache reads and writes.
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const hitRate = input > 0 ? Math.round((tokens.cacheRead / input) * 100) : 0;
  const rows: Array<[string, string]> = [
    ['Input', compactTokens(input)],
    ['Cached', `${compactTokens(tokens.cacheRead)} (${hitRate}%)`],
    ['Output', compactTokens(tokens.output)],
    ['Cost', `$${tokens.cost.toFixed(tokens.cost < 1 ? 4 : 2)}`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const body = rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
  return ['💰 **Session usage**', markdownCodeBlock(body)];
}

function backgroundSection(background: StatusSnapshot['background']): string[] {
  if (!background.loaded) return ['🌙 **Background** · 💤 not started'];
  const state = background.processing ? '🟡 working' : '🟢 idle';
  const held = background.held ? ` · 📬 Held **${background.held}**` : '';
  return [
    `🌙 **Background** · ${state}`,
    markdownQuote([
      `🤖 ${markdownCode(background.model)} · 📥 Queue **${background.queue}**${held}`,
    ]),
  ];
}

function featureSection(features: StatusSnapshot['features']): string[] {
  return [
    '⚙️ **Features**',
    settingLine({ on: features.voice.on, label: 'Voice notes', detail: features.voice.detail }),
    settingLine({
      on: features.heartbeat.on,
      label: 'Heartbeat',
      detail: features.heartbeat.detail,
    }),
    settingLine({ on: features.cron.on, label: 'Scheduled tasks', detail: features.cron.detail }),
    settingLine({ on: features.subagents, label: 'Sub-agents' }),
  ];
}

function channelSection(channel: ChannelStatus): string[] {
  return [`📱 **${escapeMarkdown(channel.title)}**`, ...channel.settings.map(settingLine)];
}

/** ✅ or ⛔ for a switch; a setting with no on/off shows its label as it is. */
function settingLine(setting: ChannelStatus['settings'][number]): string {
  const label = escapeMarkdown(setting.label);
  const head = setting.on === undefined ? label : `${setting.on ? '✅' : '⛔'} ${label}`;
  return setting.detail ? `${head} · _${escapeMarkdown(setting.detail)}_` : head;
}

/** 🟢 under half, 🟡 under 80%, 🔴 beyond — when compaction is getting close. */
export function contextLight(percent: number): string {
  if (percent < 50) return '🟢';
  if (percent < 80) return '🟡';
  return '🔴';
}

/** A token count at a glance: 950, 84k, 1.2m. */
export function compactTokens(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

/** 45s, 12m, 3h 5m, 2d 4h. */
export function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
