import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { formatPreRestartDuration, runPreRestartChecks } from './pre-restart-checks.ts';
import { escapeTelegramHtml, sendTelegramMessage } from './telegram.ts';
import { textResult } from './tool-result.ts';
import { errorMessage } from './util.ts';

const RestartBotParams = Type.Object({});
const RESTART_DELAY_MS = 300;

export function telegramRestartToolExtension(
  chatId: string,
  restart: () => Promise<void>,
): (pi: ExtensionAPI) => void {
  let restartRequested = false;

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'restart_bot',
      label: 'Restart Bot',
      description:
        'Restart the Telegram bot process. Use only when the user explicitly asks the assistant to restart itself or restart the bot. Sends a confirmation message, then exits gracefully so PM2 can bring the bot back up.',
      promptSnippet:
        'Restart the Telegram bot process when the user explicitly asks for a restart.',
      promptGuidelines: [
        "Use restart_bot only for explicit restart requests, such as 'restart yourself' or 'restart the bot'.",
        'Do not use restart_bot for vague troubleshooting, normal code changes, reloads, updates, model switches, or status checks unless the user explicitly requests a restart.',
        'After calling restart_bot, do not attempt further work; the bot process will restart shortly.',
      ],
      parameters: RestartBotParams,

      async execute() {
        if (restartRequested) {
          return textResult(
            'Restart already requested. The bot process will exit shortly so PM2 can restart it.',
          );
        }

        restartRequested = true;
        await sendTelegramMessage(chatId, '🧪 Running pre-restart checks...');

        const checks = await runPreRestartChecks();
        if (!checks.ok) {
          restartRequested = false;
          await sendTelegramMessage(
            chatId,
            [
              `❌ Restart blocked. Pre-restart checks failed after ${formatPreRestartDuration(checks.durationMs)}.`,
              '',
              `<pre><code>${escapeTelegramHtml(checks.output)}</code></pre>`,
            ].join('\n'),
          );
          return textResult('Restart blocked because pre-restart checks failed.');
        }

        await sendTelegramMessage(
          chatId,
          `✅ Pre-restart checks passed in ${formatPreRestartDuration(checks.durationMs)}. Restarting bot process. PM2 should bring it back up shortly.`,
        );

        setTimeout(() => {
          void restart().catch((error) => {
            console.error('Restart tool failed:', errorMessage(error));
          });
        }, RESTART_DELAY_MS);

        return textResult(
          'Restart scheduled after successful pre-restart checks. The bot process will exit shortly so PM2 can restart it.',
        );
      },
    });
  };
}
