import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { formatPreRestartDuration, runPreRestartChecks } from './pre-restart-checks.ts';
import { addPostRestartTask, formatPostRestartTask } from './post-restart-tasks.ts';
import { escapeTelegramHtml, sendTelegramMessage } from './telegram.ts';
import { textResult } from './tool-result.ts';
import { errorMessage } from './util.ts';

const RestartBotParams = Type.Object({
  after_restart_prompt: Type.Optional(
    Type.String({
      description:
        'Optional self-contained task to run automatically after the bot restarts. Use when the user asks to restart and then do something.',
      minLength: 1,
    }),
  ),
  after_restart_title: Type.Optional(
    Type.String({ description: 'Optional short title for the post-restart task.' }),
  ),
});

type RestartBotParamsType = Static<typeof RestartBotParams>;

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
        'Restart the Telegram bot process. Use only when the user explicitly asks the assistant to restart itself or restart the bot. Optionally stores a self-contained task to run automatically after PM2 brings the bot back up.',
      promptSnippet:
        'Restart the Telegram bot process when the user explicitly asks for a restart.',
      promptGuidelines: [
        "Use restart_bot only for explicit restart requests, such as 'restart yourself' or 'restart the bot'.",
        'Do not use restart_bot for vague troubleshooting, normal code changes, reloads, updates, model switches, or status checks unless the user explicitly requests a restart.',
        'If the user asks to restart and then do something, put the follow-up work in after_restart_prompt as a self-contained instruction.',
        'After calling restart_bot, do not attempt further work; the bot process will restart shortly. Any after_restart_prompt will run after startup.',
      ],
      parameters: RestartBotParams,

      async execute(_toolCallId, params: RestartBotParamsType) {
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

        const afterRestartPrompt = params.after_restart_prompt?.trim();
        const postRestartTask = afterRestartPrompt
          ? addPostRestartTask({
              chatId,
              prompt: afterRestartPrompt,
              ...(params.after_restart_title?.trim()
                ? { title: params.after_restart_title.trim() }
                : {}),
            })
          : null;

        await sendTelegramMessage(
          chatId,
          [
            `✅ Pre-restart checks passed in ${formatPreRestartDuration(checks.durationMs)}. Restarting bot process. PM2 should bring it back up shortly.`,
            ...(postRestartTask
              ? [`Queued post-restart task: ${formatPostRestartTask(postRestartTask)}`]
              : []),
          ].join('\n'),
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
