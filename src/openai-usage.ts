import { USAGE_FETCH_TIMEOUT_MS } from './config.ts';
import { formatPercent, titleCase, usageBar } from './format.ts';
import { escapeMarkdown, markdownCode as code } from './markdown.ts';
import { errorMessage, isRecord } from './util.ts';

const OPENAI_CODEX_PROVIDER = 'openai-codex';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

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
  windows: UsageWindow[];
}

export interface OpenAIUsageResult {
  usage: OpenAIUsage;
  warnings: string[];
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return undefined;
}

function parseString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

function normalizeResetAt(unixTime: number | undefined): number | undefined {
  if (unixTime === undefined) return undefined;
  // Codex currently returns Unix seconds, but accepting milliseconds makes the
  // display safe if a gateway normalizes the timestamp differently.
  return unixTime > 10_000_000_000 ? Math.round(unixTime / 1_000) : unixTime;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseUsageWindow(value: unknown, name: string): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;

  const usedPercent = parseNumber(value.used_percent);
  const windowMinutes =
    parseNumber(value.window_minutes) ??
    (() => {
      const seconds = parseNumber(value.limit_window_seconds);
      return seconds === undefined ? undefined : Math.ceil(seconds / 60);
    })();
  const resetAt = normalizeResetAt(parseNumber(value.reset_at));
  const serverResetAfter = parseNumber(value.reset_after_seconds);

  if (
    usedPercent === undefined &&
    windowMinutes === undefined &&
    resetAt === undefined &&
    serverResetAfter === undefined
  ) {
    return undefined;
  }

  return {
    name,
    usedPercent: usedPercent === undefined ? undefined : clampPercent(usedPercent),
    resetAfterSeconds:
      serverResetAfter === undefined
        ? resetAt === undefined
          ? undefined
          : Math.max(0, Math.round(resetAt - Date.now() / 1_000))
        : Math.max(0, Math.round(serverResetAfter)),
    resetAt,
    windowMinutes,
  };
}

function parseUsagePayload(response: Response, body: string): OpenAIUsage {
  const payload: unknown = JSON.parse(body);
  if (!isRecord(payload)) throw new Error('Codex usage response was not a JSON object.');

  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined;
  const windows = [
    parseUsageWindow(rateLimit?.primary_window, '5 hour'),
    parseUsageWindow(rateLimit?.secondary_window, '7 day'),
  ].filter((window): window is UsageWindow => window !== undefined);

  if (Array.isArray(payload.additional_rate_limits)) {
    for (const additional of payload.additional_rate_limits) {
      if (!isRecord(additional) || !isRecord(additional.rate_limit)) continue;
      const name =
        parseString(additional.limit_name) ??
        parseString(additional.metered_feature) ??
        'Additional';
      const primary = parseUsageWindow(additional.rate_limit.primary_window, `${name} primary`);
      const secondary = parseUsageWindow(
        additional.rate_limit.secondary_window,
        `${name} secondary`,
      );
      if (primary) windows.push(primary);
      if (secondary) windows.push(secondary);
    }
  }

  const credits = isRecord(payload.credits) ? payload.credits : undefined;
  return {
    status: response.status,
    statusText: response.statusText,
    requestId: response.headers.get('x-oai-request-id') ?? undefined,
    planType: parseString(payload.plan_type),
    activeLimit: parseString(payload.active_limit),
    modelsEtag: response.headers.get('x-models-etag') ?? undefined,
    creditsBalance: credits ? parseString(credits.balance) : undefined,
    creditsHasCredits: credits ? parseBoolean(credits.has_credits) : undefined,
    creditsUnlimited: credits ? parseBoolean(credits.unlimited) : undefined,
    windows,
  };
}

function emptyUsage(response: Response): OpenAIUsage {
  return {
    status: response.status,
    statusText: response.statusText,
    requestId: response.headers.get('x-oai-request-id') ?? undefined,
    windows: [],
  };
}

export async function fetchOpenAIUsage(
  accessToken: string,
  signal?: AbortSignal,
): Promise<OpenAIUsageResult> {
  const accountId = getAccountId(accessToken);
  const response = await fetch(CODEX_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'chatgpt-account-id': accountId,
      originator: 'pi',
      'user-agent': 'pi-bot',
    },
    signal: signal ?? AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
  });

  const body = await response.text().catch(() => '');
  const warnings: string[] = [];
  let usage = emptyUsage(response);
  if (!response.ok) {
    warnings.push(
      `Usage request returned HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ''}`,
    );
  } else {
    try {
      usage = parseUsagePayload(response, body);
    } catch (error) {
      warnings.push(`Could not parse Codex usage response: ${errorMessage(error)}`);
    }
  }

  return { usage, warnings };
}

function windowReport(window: UsageWindow): string[] {
  return [
    `**${escapeMarkdown(titleCase(window.name))} Window**`,
    `• Used: ${code(formatPercent(window.usedPercent))} ${code(usageBar(window.usedPercent))}`,
    `• Window: ${code(formatWindow(window.windowMinutes))}`,
    `• Resets in: ${code(formatSecondsDuration(window.resetAfterSeconds))}`,
    `• Reset at: ${code(formatResetAt(window.resetAt))}`,
  ];
}

export function buildOpenAIUsageMarkdown(usage: OpenAIUsage, warnings: string[]): string {
  const lines = [
    '**OpenAI Codex Usage**',
    '',
    '**Account**',
    `• Plan: ${code(titleCase(usage.planType))}`,
    `• Limit: ${code(titleCase(usage.activeLimit))}`,
    `• Credits: ${code(formatCredits(usage))}`,
  ];

  if (usage.windows.length === 0) {
    lines.push('', 'No Codex rate-limit windows were returned by OpenAI.');
  } else {
    for (const window of usage.windows) {
      lines.push('', ...windowReport(window));
    }
  }

  if (usage.requestId) {
    lines.push('', `Request ID: ${code(usage.requestId)}`);
  }

  if (warnings.length > 0) {
    lines.push('', '**Warnings**');
    for (const warning of warnings) {
      lines.push(`• ${escapeMarkdown(warning)}`);
    }
  }

  return lines.join('\n');
}
