import * as fs from 'node:fs';
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

export function configNumber(value: number, defaultValue: number, minimum: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(minimum, parsed);
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

export function readActiveModelRaw(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8').trim() || null;
}

export function readActiveModel(
  filePath: string,
  allowedModels: string[],
  defaultModel: string,
): string | null {
  const raw = readActiveModelRaw(filePath);
  if (!raw) return null;

  const candidates = [normalizeModelRef(raw), normalizeModelRef(raw, 'openrouter')]
    .filter(Boolean)
    .filter((model, index, models) => models.indexOf(model) === index);

  return (
    candidates.find((model) => allowedModels.includes(model)) ??
    candidates.find((model) => model === defaultModel) ??
    candidates[0] ??
    null
  );
}

export function writeModelState(filePath: string, model: string): void {
  fs.writeFileSync(filePath, `${normalizeModelRef(model)}\n`, 'utf8');
}
