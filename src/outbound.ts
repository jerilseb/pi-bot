import { BACKGROUND_BASH_NOOP, CRON_NOOP, HEARTBEAT_NOOP, SUBAGENT_NOOP } from './config.ts';
import type { PiPromptResult } from './types.ts';

/**
 * Whether a reply has anything to show. The check is the core's, so no channel
 * can disagree on whether an unattended run said something; sending the reply
 * is each channel's.
 */

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
