import { BACKGROUND_BASH_NOOP, CRON_NOOP, HEARTBEAT_NOOP, SUBAGENT_NOOP } from './config.ts';
import { sendTelegramMessage } from './telegram.ts';
import type { IncomingPrompt, PiPromptResult } from './types.ts';

/**
 * Deliver a Pi response to the Telegram chat. Resolves true when a message was
 * sent, false when the response was a noop sentinel or blank and nothing reached
 * the user.
 */
export async function sendPiResponse(
  response: PiPromptResult,
  options: { suppressNoop?: boolean; source?: IncomingPrompt['source'] } = {},
): Promise<boolean> {
  if (isSilentResponse(response, options)) {
    console.log('background task completed with no user-visible update');
    return false;
  }

  // Only a reply that must be sent gets here blank: an unattended run's is silent.
  const body = response.text || '(no response)';
  const text = options.source === 'cron' ? `⏰ <b>Scheduled report</b>\n\n${body}` : body;
  await sendTelegramMessage(text);
  return true;
}

/**
 * True when a response has nothing to send: a blank reply from an unattended
 * run is nothing to report, same as the sentinel — sending "(no response)" would
 * only tell the user the model said nothing. The sentinel is looked for in the
 * last message, so narration before it does not make it a report.
 */
export function isSilentResponse(
  response: PiPromptResult,
  options: { suppressNoop?: boolean },
): boolean {
  return Boolean(
    options.suppressNoop &&
      (!response.text.trim() || isNoopResponse(response.finalText ?? response.text)),
  );
}

// Compared against the bare sentinel name so a model that drops the __ wrapper —
// e.g. emits "HEARTBEAT_NOOP" instead of "__HEARTBEAT_NOOP__" — still counts.
const NOOP_MARKERS = new Set(
  [HEARTBEAT_NOOP, CRON_NOOP, BACKGROUND_BASH_NOOP, SUBAGENT_NOOP].map(stripSentinelWrapper),
);

function stripSentinelWrapper(value: string): string {
  return value.replace(/^_+|_+$/g, '');
}

/**
 * True only when the whole response is a sentinel, allowing for the wrappers a
 * model tends to add: a code fence, backticks, bold, or a trailing full stop. A
 * real report that merely mentions a sentinel is delivered, not swallowed.
 */
function isNoopResponse(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
    .replace(/^[`*]+|[`*]+$/g, '')
    .replace(/\.$/, '')
    .trim();

  return NOOP_MARKERS.has(stripSentinelWrapper(normalized));
}
