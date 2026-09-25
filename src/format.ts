/**
 * Small presentational helpers for the bot's own messages, shared by /status
 * and the usage reports. Plain text, so they fit any message format.
 */

export function titleCase(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .split(/[ _-]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(value < 10 && value !== 0 ? 1 : 0)}%`;
}

export function usageBar(percent: number | undefined, width = 18): string {
  const normalized = percent === undefined ? 0 : percent / 100;
  const clamped = Math.max(0, Math.min(1, normalized));
  const filled = Math.round(clamped * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
