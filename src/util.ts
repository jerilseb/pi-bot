import type { PromptOrigin } from './contract.ts';
import type { IncomingPrompt, SessionKind } from './types.ts';

export interface ModelRef {
  provider: string;
  model: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Which of the bot's two Pi sessions runs a prompt. An explicit session wins over origin. */
export function promptSessionKind(prompt: Pick<IncomingPrompt, 'origin' | 'session'>): SessionKind {
  if (prompt.session) return prompt.session;
  const { kind } = prompt.origin;
  return kind === 'heartbeat' || kind === 'cron' ? 'background' : 'chat';
}

/** True for prompts that run unattended in the background session. */
export function isBackgroundPrompt(prompt: Pick<IncomingPrompt, 'origin' | 'session'>): boolean {
  return promptSessionKind(prompt) === 'background';
}

/** True for a completion report from background work (background bash, sub-agents). */
export function isJobReportPrompt(prompt: Pick<IncomingPrompt, 'origin'>): boolean {
  return prompt.origin.kind === 'job-report';
}

/** A short name for where a prompt came from, for logs and outbox labels. */
export function originLabel(origin: PromptOrigin): string {
  if (origin.kind === 'user') return 'prompt';
  if (origin.kind === 'job-report') return origin.source;
  return origin.kind;
}

/** Reduces a thrown error to one length-capped line fit for a chat message. Not escaped. */
export function summarizeError(error: string): string {
  const firstUsefulLine = error
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('at ') && !line.startsWith('node:'));
  const message = firstUsefulLine || 'Something went wrong.';
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

/** The text on one line, cut to maxChars so it fits a label or a note. */
export function oneLineLabel(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars - 1)}…`;
}

export function parseModelRef(value: string): ModelRef {
  const normalized = value.trim();
  const slash = normalized.indexOf('/');
  if (slash <= 0 || slash === normalized.length - 1) {
    throw new Error(
      `Model must be in provider/model form, e.g. openrouter/openai/gpt-5.4-mini: ${value}`,
    );
  }
  return {
    provider: normalized.slice(0, slash),
    model: normalized.slice(slash + 1),
  };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Formats a millisecond duration as `45s`, `3m 20s`, or `2h 15m`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

/** Local-timezone YYYY-MM-DD, used for daily memory note filenames. */
export function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function requireValidDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Missing required date field ${field}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for ${field}: ${value}`);
  }
  return date;
}
