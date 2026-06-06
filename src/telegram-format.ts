import { escapeTelegramHtml } from './telegram.ts';

export function telegramCode(value: string): string {
  return `<code>${escapeTelegramHtml(value)}</code>`;
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .split(/[ _-]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function usageBar(percent: number | undefined, width = 18): string {
  const normalized = percent === undefined ? 0 : percent / 100;
  const clamped = Math.max(0, Math.min(1, normalized));
  const filled = Math.round(clamped * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
