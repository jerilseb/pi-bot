import { formatPreRestartDuration, runPreRestartChecks } from './pre-restart-checks.ts';
import { escapeTelegramHtml } from './telegram-html.ts';
import { sendTelegramMessage } from './telegram.ts';

/**
 * Shared restart gate for the /restart command and the restart_bot tool, so the
 * two entry points cannot drift on which checks run or what the user is told.
 *
 * Announces the checks, runs them, reports the outcome to Telegram, and returns
 * whether the caller may go ahead and restart.
 *
 * `onChecksPassed` runs only after the checks pass, so callers can commit side
 * effects that must not happen on a blocked restart (such as queueing a
 * post-restart task). Any lines it returns are appended to the success message.
 */
export async function runRestartGate(onChecksPassed?: () => string[]): Promise<boolean> {
  await sendTelegramMessage('🧪 Running pre-restart checks...');

  const checks = await runPreRestartChecks();
  const duration = formatPreRestartDuration(checks.durationMs);

  if (!checks.ok) {
    await sendTelegramMessage(
      [
        `❌ Restart blocked. Pre-restart checks failed after ${duration}.`,
        '',
        `<pre><code>${escapeTelegramHtml(checks.output)}</code></pre>`,
      ].join('\n'),
    );
    return false;
  }

  await sendTelegramMessage(
    [
      `✅ Pre-restart checks passed in ${duration}. Restarting bot process. PM2 should bring it back up shortly.`,
      ...(onChecksPassed?.() ?? []),
    ].join('\n'),
  );
  return true;
}
