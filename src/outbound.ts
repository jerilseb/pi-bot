import { BACKGROUND_BASH_NOOP, CRON_NOOP, HEARTBEAT_NOOP } from './config.ts';
import type { PiPromptResult } from './types.ts';
import * as gateway from './web/gateway.ts';

/** Delivers Pi's final response to the web UI as a durable assistant_message
 * record (buffered for replay + fires Web Push when no client is visible). */
export async function sendPiResponse(
  chatId: string,
  response: PiPromptResult,
  options: { suppressNoop?: boolean } = {},
): Promise<void> {
  if (options.suppressNoop && isNoopResponse(response.text)) {
    console.log(`[${chatId}] background task completed with no user-visible update`);
    return;
  }

  gateway.emit(chatId, { type: 'assistant_message', payload: { text: response.text } });
}

function isNoopResponse(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  return (
    normalized.includes(HEARTBEAT_NOOP) ||
    normalized.includes(CRON_NOOP) ||
    normalized.includes(BACKGROUND_BASH_NOOP) ||
    normalized.includes('HEARTBEAT_NOOP') ||
    normalized.includes('CRON_NOOP') ||
    normalized.includes('BACKGROUND_BASH_NOOP')
  );
}
