import { escapeTelegramHtml } from './telegram-html.ts';
import { usageBar } from './telegram-format.ts';

/**
 * The /status message, rendered from a plain snapshot so the layout is pure and
 * testable. commands.ts gathers the snapshot; nothing here reads live state.
 *
 * Layout: a header, then one section per concern — chat, context, tokens,
 * background, features — each a bold emoji title with its details below. Long
 * values (paths, raw setting names) are left to /help and the logs; this is a
 * glance, not a config dump.
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
    toolCalls: string;
    transcripts: boolean;
    /** Whether sub-agent progress messages show each worker's tool calls. */
    subagentToolCalls: boolean;
  };
}

export function renderStatus(snapshot: StatusSnapshot): string {
  return [
    '📊 <b>Pi Bot · Status</b>',
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
  ].join('\n');
}

function chatSection(chat: StatusSnapshot['chat']): string[] {
  const state = chat.processing ? '🟡 working' : '🟢 idle';
  const pending = [`📥 Queue <b>${chat.queue}</b>`, `↪️ Steering <b>${chat.steering}</b>`];
  return [
    `💬 <b>Chat</b> · ${state}`,
    `<blockquote>🤖 <code>${escapeTelegramHtml(chat.model)}</code>`,
    `💡 Reasoning <b>${escapeTelegramHtml(chat.reasoning)}</b>`,
    `${pending.join(' · ')}`,
    `✉️ ${chat.messages} message${chat.messages === 1 ? '' : 's'} · ⏱ up ${formatUptime(chat.uptimeMs)}</blockquote>`,
  ];
}

function contextSection(context: StatusContext | undefined): string[] {
  if (!context) return ['🧠 <b>Context</b> · <i>no session loaded</i>'];
  const window = compactTokens(context.contextWindow);
  if (context.tokens === null || context.percent === null) {
    return [
      `🧠 <b>Context</b> · ? / ${window}`,
      '<i>Just compacted — measured again after the next reply.</i>',
    ];
  }
  const percent = Math.round(context.percent);
  const free = Math.max(0, context.contextWindow - context.tokens);
  return [
    `🧠 <b>Context</b> · ${contextLight(context.percent)} ${percent}% used`,
    `<code>${usageBar(context.percent, 20)}</code>`,
    `${compactTokens(context.tokens)} of ${window} · ${compactTokens(free)} free`,
  ];
}

function tokenSection(tokens: StatusSnapshot['tokens']): string[] {
  if (!tokens) return ['💰 <b>Session usage</b> · <i>no session loaded</i>'];
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
  return ['💰 <b>Session usage</b>', `<pre>${escapeTelegramHtml(body)}</pre>`];
}

function backgroundSection(background: StatusSnapshot['background']): string[] {
  if (!background.loaded) return ['🌙 <b>Background</b> · 💤 not started'];
  const state = background.processing ? '🟡 working' : '🟢 idle';
  const held = background.held ? ` · 📬 Held <b>${background.held}</b>` : '';
  return [
    `🌙 <b>Background</b> · ${state}`,
    `<blockquote>🤖 <code>${escapeTelegramHtml(background.model)}</code> · 📥 Queue <b>${background.queue}</b>${held}</blockquote>`,
  ];
}

function featureSection(features: StatusSnapshot['features']): string[] {
  const line = (on: boolean, label: string, detail?: string): string =>
    `${on ? '✅' : '⛔'} ${label}${detail ? ` · <i>${escapeTelegramHtml(detail)}</i>` : ''}`;
  return [
    '⚙️ <b>Features</b>',
    line(features.voice.on, 'Voice notes', features.voice.detail),
    line(features.heartbeat.on, 'Heartbeat', features.heartbeat.detail),
    line(features.cron.on, 'Scheduled tasks', features.cron.detail),
    line(features.subagents, 'Sub-agents'),
    line(features.subagentToolCalls, 'Sub-agent tool calls'),
    line(features.transcripts, 'Voice transcripts'),
    `🛠 Tool calls · <i>${escapeTelegramHtml(features.toolCalls)}</i>`,
  ];
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
