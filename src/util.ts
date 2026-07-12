import type { IncomingPrompt } from './types.ts';

export interface ModelRef {
  provider: string;
  model: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isBackgroundSource(source: IncomingPrompt['source']): boolean {
  return source === 'heartbeat' || source === 'cron';
}

export function parseModelRef(value: string): ModelRef {
  const normalized = normalizeModelRef(value);
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

export function normalizeModelRef(value: string, defaultProvider?: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!defaultProvider || trimmed.startsWith(`${defaultProvider}/`)) {
    return trimmed;
  }
  return `${defaultProvider}/${trimmed}`;
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

