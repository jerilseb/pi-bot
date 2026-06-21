import { code, titleCase, usageBar } from './format.ts';

const ELEVENLABS_SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';
const FETCH_TIMEOUT_MS = 30_000;

interface MoneyAmount {
  amount?: string;
  currency?: string;
}

interface ElevenLabsSubscription {
  tier?: string;
  character_count?: number;
  character_limit?: number;
  max_credit_limit_extension?: number | 'unlimited';
  can_extend_character_limit?: boolean;
  voice_slots_used?: number;
  professional_voice_slots_used?: number;
  voice_limit?: number;
  professional_voice_limit?: number;
  current_overage?: MoneyAmount;
  status?: string;
  has_open_invoices?: boolean;
  next_character_count_reset_unix?: number | null;
  currency?: string | null;
  billing_period?: string | null;
  character_refresh_period?: string | null;
}

export async function fetchElevenLabsUsage(
  apiKey: string,
  signal?: AbortSignal,
): Promise<ElevenLabsSubscription> {
  const response = await fetch(ELEVENLABS_SUBSCRIPTION_URL, {
    headers: {
      'xi-api-key': apiKey,
      Accept: 'application/json',
    },
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `ElevenLabs API error ${response.status}: ${body.slice(0, 200) || response.statusText}`,
    );
  }

  return (await response.json()) as ElevenLabsSubscription;
}

function formatNumber(value: number | undefined | null): string {
  if (value === undefined || value === null) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(value < 10 && value !== 0 ? 1 : 0)}%`;
}

function formatResetAt(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMaxCreditExtension(
  value: ElevenLabsSubscription['max_credit_limit_extension'],
): string {
  if (value === undefined || value === null) return '—';
  if (value === 'unlimited') return 'Unlimited';
  if (value === 0) return 'Disabled';
  return formatNumber(value);
}

function formatMoney(value: MoneyAmount | undefined): string {
  if (!value?.amount) return '—';
  const currency = value.currency?.toUpperCase();
  return currency ? `${value.amount} ${currency}` : value.amount;
}

export function buildElevenLabsUsageMarkdown(usage: ElevenLabsSubscription): string {
  const used = usage.character_count;
  const limit = usage.character_limit;
  const remaining = used === undefined || limit === undefined ? undefined : limit - used;
  const usedPercent =
    used === undefined || limit === undefined || limit <= 0 ? undefined : (used / limit) * 100;

  return [
    '**ElevenLabs Usage**',
    '',
    '**Credits / Characters**',
    `- Used: ${code(formatNumber(used))} ${code(usageBar(usedPercent))}`,
    `- Limit: ${code(formatNumber(limit))}`,
    `- Remaining: ${code(formatNumber(remaining))}`,
    `- Used %: ${code(formatPercent(usedPercent))}`,
    `- Reset at: ${code(formatResetAt(usage.next_character_count_reset_unix))}`,
    '',
    '**Subscription**',
    `- Tier: ${code(titleCase(usage.tier))}`,
    `- Status: ${code(titleCase(usage.status))}`,
    `- Billing period: ${code(titleCase(usage.billing_period))}`,
    `- Refresh period: ${code(titleCase(usage.character_refresh_period))}`,
    `- Overage cap: ${code(formatMaxCreditExtension(usage.max_credit_limit_extension))}`,
    `- Current overage: ${code(formatMoney(usage.current_overage))}`,
    `- Open invoices: ${code(usage.has_open_invoices ? 'Yes' : 'No')}`,
    '',
    '**Voices**',
    `- Voice slots: ${code(`${formatNumber(usage.voice_slots_used)} / ${formatNumber(usage.voice_limit)}`)}`,
    `- Professional voices: ${code(`${formatNumber(usage.professional_voice_slots_used)} / ${formatNumber(usage.professional_voice_limit)}`)}`,
  ].join('\n');
}
