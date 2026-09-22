import { JOB_PROGRESS_UPDATE_MS } from './config.ts';
import { editTelegramMessageHtml, sendTelegramHtmlMessage } from './telegram.ts';
import { errorMessage } from './util.ts';

/**
 * A live Telegram message for one backgrounded job, kept current by the bot
 * itself. The user sees how a long command or sub-agent job is going without
 * the agent polling it: no model call is involved, so a refresh costs one
 * Telegram edit and no context.
 *
 * Best-effort throughout. A failed send is retried on the next refresh; a
 * failed edit (the user may have deleted the message) ends the updates rather
 * than resending every interval. Nothing here ever rejects into the job.
 */

export interface ProgressTransport {
  /** Sends the message and returns its ID. */
  send(html: string): Promise<number>;
  edit(messageId: number, html: string): Promise<void>;
}

const telegramTransport: ProgressTransport = {
  // Silent: progress is ambient, and the job's report is what warrants a ping.
  send: (html) => sendTelegramHtmlMessage(html, { silent: true }),
  edit: editTelegramMessageHtml,
};

export interface ProgressMessageOptions {
  transport?: ProgressTransport;
  intervalMs?: number;
}

export interface ProgressMessage {
  /** Stops refreshing and shows the final render. Idempotent; never rejects. */
  finish(): Promise<void>;
}

/** Sends render() now and refreshes it every interval until finish(). */
export function startProgressMessage(
  render: () => string,
  options: ProgressMessageOptions = {},
): ProgressMessage {
  const transport = options.transport ?? telegramTransport;
  let messageId: number | null = null;
  let shown = '';
  let abandoned = false;
  let busy = false;
  let finishing: Promise<void> | null = null;
  // Every Telegram call goes through this chain, so an edit can never overtake
  // the send it depends on, and the final state is always the last one written.
  let chain: Promise<void> = Promise.resolve();

  const update = (): Promise<void> => {
    busy = true;
    chain = chain
      .then(async () => {
        if (abandoned) return;
        const html = render();
        if (html === shown) return;
        if (messageId === null) {
          try {
            messageId = await transport.send(html);
            shown = html;
          } catch (error) {
            console.error('failed to send job progress message:', errorMessage(error));
          }
          return;
        }
        try {
          await transport.edit(messageId, html);
          shown = html;
        } catch (error) {
          abandoned = true;
          console.error('failed to edit job progress message; stopping:', errorMessage(error));
        }
      })
      .catch((error) => {
        console.error('failed to render job progress:', errorMessage(error));
      })
      .finally(() => {
        busy = false;
      });
    return chain;
  };

  const timer = setInterval(() => {
    // A slow Telegram call must not pile refreshes up behind it.
    if (!busy) void update();
  }, options.intervalMs ?? JOB_PROGRESS_UPDATE_MS);
  timer.unref?.();
  void update();

  return {
    finish(): Promise<void> {
      if (!finishing) {
        clearInterval(timer);
        finishing = update();
      }
      return finishing;
    },
  };
}
