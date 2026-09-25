import { TELEGRAM_POLL_TIMEOUT_MS } from '../../config.ts';
import { errorMessage, sleep } from '../../util.ts';
import { telegram } from './telegram.ts';
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from './types.ts';

/** How long to wait before polling again after a failed getUpdates. */
const POLL_RETRY_DELAY_MS = 5_000;

/**
 * The Bot API long-polling loop. Only one process may poll a given bot token.
 * Callback queries are answered in order, before the next update; messages are
 * handed off without waiting, since ingesting one can take minutes.
 */
export async function pollTelegramUpdates(options: {
  isRunning: () => boolean;
  onMessage: (message: TelegramMessage) => void;
  onCallbackQuery: (query: TelegramCallbackQuery) => Promise<void>;
}): Promise<void> {
  let offset = 0;
  while (options.isRunning()) {
    try {
      const params = new URLSearchParams({
        offset: String(offset),
        timeout: '30',
        allowed_updates: JSON.stringify(['message', 'callback_query']),
      });
      const data = await telegram<{ ok: boolean; result: TelegramUpdate[] }>(
        `getUpdates?${params}`,
        undefined,
        TELEGRAM_POLL_TIMEOUT_MS,
      );
      if (!data.ok) {
        await sleep(POLL_RETRY_DELAY_MS);
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        if (update.callback_query) {
          await options.onCallbackQuery(update.callback_query);
          continue;
        }

        if (update.message) options.onMessage(update.message);
      }
    } catch (error) {
      if (!options.isRunning()) break;
      console.error('Polling error:', errorMessage(error));
      await sleep(POLL_RETRY_DELAY_MS);
    }
  }
}
