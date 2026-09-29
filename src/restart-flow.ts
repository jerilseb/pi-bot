import { markdownCodeBlock } from './markdown.ts';
import { formatPreRestartDuration, runPreRestartChecks } from './pre-restart-checks.ts';
import type { StatusNotice } from './tool-host.ts';

/**
 * Shared restart gate for the /restart command and the restart_bot tool, so the
 * two entry points cannot drift on which checks run or what the user is told.
 *
 * Announces the checks through `announce` (to every channel, since a restart
 * affects them all), runs them, replaces the announcement with the outcome, and
 * returns whether the caller may go ahead and restart.
 *
 * `onChecksPassed` runs only after the checks pass, so callers can commit side
 * effects that must not happen on a blocked restart (such as queueing a
 * post-restart task). Any lines it returns are appended to the success message.
 */
export async function runRestartGate(
  announce: (markdown: string) => StatusNotice,
  onChecksPassed?: () => string[],
): Promise<boolean> {
  const status = announce('🧪 Running pre-restart checks...');

  const checks = await runPreRestartChecks();
  const duration = formatPreRestartDuration(checks.durationMs);

  if (!checks.ok) {
    status.replace(
      [
        `❌ Restart blocked. Pre-restart checks failed after ${duration}.`,
        '',
        markdownCodeBlock(checks.output),
      ].join('\n'),
    );
    return false;
  }

  status.replace(
    [
      `✅ Pre-restart checks passed in ${duration}. Restarting bot process. systemd should bring it back up shortly.`,
      ...(onChecksPassed?.() ?? []),
    ].join('\n'),
  );
  return true;
}
