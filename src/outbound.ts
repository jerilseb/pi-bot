import { BACKGROUND_BASH_NOOP, CRON_NOOP, HEARTBEAT_NOOP } from './config.ts';
import { sendTelegramMessage } from './telegram.ts';
import type { PiPromptResult } from './types.ts';

export async function sendPiResponse(
  response: PiPromptResult,
  options: { suppressNoop?: boolean } = {},
): Promise<void> {
  if (options.suppressNoop && isNoopResponse(response.text)) {
    console.log('background task completed with no user-visible update');
    return;
  }

  await sendTelegramMessage(response.text);
}

// Match on the bare sentinel name (wrapping underscores stripped) so a model that
// drops the __ wrapper — e.g. emits "HEARTBEAT_NOOP" instead of "__HEARTBEAT_NOOP__"
// — still counts as a noop. The bare form also matches the wrapped form.
const NOOP_MARKERS = [HEARTBEAT_NOOP, CRON_NOOP, BACKGROUND_BASH_NOOP].map((sentinel) =>
  sentinel.replace(/^_+|_+$/g, ''),
);

function isNoopResponse(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  return NOOP_MARKERS.some((marker) => normalized.includes(marker));
}
