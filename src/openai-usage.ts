import { escapeTelegramHtml } from './telegram-html.ts';
import { telegramCode as code, titleCase, usageBar } from './telegram-format.ts';
import { isRecord } from './util.ts';

const OPENAI_CODEX_PROVIDER = 'openai-codex';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_USAGE_PROBE_MODEL = 'gpt-5.4-mini';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const FETCH_TIMEOUT_MS = 30_000;

export { OPENAI_CODEX_PROVIDER };

interface UsageWindow {
  name: string;
  usedPercent?: number;
  resetAfterSeconds?: number;
  resetAt?: number;
  windowMinutes?: number;
}

interface OpenAIUsage {
  status: number;
  statusText: string;
  requestId?: string;
  planType?: string;
  activeLimit?: string;
  modelsEtag?: string;
  creditsBalance?: string;
  creditsHasCredits?: boolean;
  creditsUnlimited?: boolean;
  primaryOverSecondaryLimitPercent?: number;
  primary: UsageWindow;
  secondary: UsageWindow;
}

export interface OpenAIUsageResult {
  usage: OpenAIUsage;
  warnings: string[];
}

function parseNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Access token is not a JWT');
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const decoded: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  if (!isRecord(decoded)) {
    throw new Error('JWT payload is not an object');
  }
  return decoded;
}

function getAccountId(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload[JWT_CLAIM_PATH];
  const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('Could not find chatgpt_account_id in the OpenAI Codex access token.');
  }
  return accountId;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return '—';
  return `${value.toFixed(value < 10 && value !== 0 ? 1 : 0)}%`;
}

function formatWindow(minutes: number | undefined): string {
  if (minutes === undefined) return '—';
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatSecondsDuration(totalSeconds: number | undefined): string {
  if (totalSeconds === undefined) return '—';
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function formatResetAt(unixSeconds: number | undefined): string {
  if (unixSeconds === undefined) return '—';
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCredits(usage: OpenAIUsage): string {
  if (usage.creditsUnlimited) return 'Unlimited';
  if (usage.creditsHasCredits) return usage.creditsBalance || 'Available';
  return 'No extra credits';
}

function parseUsageHeaders(response: Response): OpenAIUsage {
  const h = response.headers;
  return {
    status: response.status,
    statusText: response.statusText,
    requestId: h.get('x-oai-request-id') ?? undefined,
    planType: h.get('x-codex-plan-type') ?? undefined,
    activeLimit: h.get('x-codex-active-limit') ?? undefined,
    modelsEtag: h.get('x-models-etag') ?? undefined,
    creditsBalance: h.get('x-codex-credits-balance') ?? undefined,
    creditsHasCredits: parseBoolean(h.get('x-codex-credits-has-credits')),
    creditsUnlimited: parseBoolean(h.get('x-codex-credits-unlimited')),
    primaryOverSecondaryLimitPercent: parseNumber(
      h.get('x-codex-primary-over-secondary-limit-percent'),
    ),
    primary: {
      name: '5 hour',
      usedPercent: parseNumber(h.get('x-codex-primary-used-percent')),
      resetAfterSeconds: parseNumber(h.get('x-codex-primary-reset-after-seconds')),
      resetAt: parseNumber(h.get('x-codex-primary-reset-at')),
      windowMinutes: parseNumber(h.get('x-codex-primary-window-minutes')),
    },
    secondary: {
      name: '7 day',
      usedPercent: parseNumber(h.get('x-codex-secondary-used-percent')),
      resetAfterSeconds: parseNumber(h.get('x-codex-secondary-reset-after-seconds')),
      resetAt: parseNumber(h.get('x-codex-secondary-reset-at')),
      windowMinutes: parseNumber(h.get('x-codex-secondary-window-minutes')),
    },
  };
}

export async function fetchOpenAIUsage(
  accessToken: string,
  signal?: AbortSignal,
): Promise<OpenAIUsageResult> {
  const accountId = getAccountId(accessToken);
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'OpenAI-Beta': 'responses=experimental',
      accept: 'text/event-stream',
      'chatgpt-account-id': accountId,
      'content-type': 'application/json',
      originator: 'pi',
    },
    body: JSON.stringify({
      model: DEFAULT_USAGE_PROBE_MODEL,
      store: false,
      stream: true,
      instructions: 'You are a usage probe. Reply with exactly: ok',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'ok' }],
        },
      ],
      text: { verbosity: 'medium' },
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    }),
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const usage = parseUsageHeaders(response);
  const warnings: string[] = [];
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    warnings.push(
      `Usage probe returned HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`,
    );
  } else {
    await response.body?.cancel();
  }

  return { usage, warnings };
}

function windowReport(window: UsageWindow): string[] {
  return [
    `<b>${escapeTelegramHtml(titleCase(window.name))} Window</b>`,
    `• Used: ${code(formatPercent(window.usedPercent))} ${code(usageBar(window.usedPercent))}`,
    `• Window: ${code(formatWindow(window.windowMinutes))}`,
    `• Resets in: ${code(formatSecondsDuration(window.resetAfterSeconds))}`,
    `• Reset at: ${code(formatResetAt(window.resetAt))}`,
  ];
}

export function buildOpenAIUsageTelegramHtml(usage: OpenAIUsage, warnings: string[]): string {
  const lines = [
    '<b>OpenAI Codex Usage</b>',
    '',
    '<b>Account</b>',
    `• Plan: ${code(titleCase(usage.planType))}`,
    `• Limit: ${code(titleCase(usage.activeLimit))}`,
    `• Credits: ${code(formatCredits(usage))}`,
  ];

  if (usage.primaryOverSecondaryLimitPercent !== undefined) {
    lines.push(`• Overage: ${code(formatPercent(usage.primaryOverSecondaryLimitPercent))}`);
  }

  lines.push('', ...windowReport(usage.primary));
  lines.push('', ...windowReport(usage.secondary));

  if (usage.requestId) {
    lines.push('', `Request ID: ${code(usage.requestId)}`);
  }

  if (warnings.length > 0) {
    lines.push('', '<b>Warnings</b>');
    for (const warning of warnings) {
      lines.push(`• ${escapeTelegramHtml(warning)}`);
    }
  }

  return lines.join('\n');
}
