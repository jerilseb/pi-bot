import { execFile } from 'node:child_process';
import { TUI_HERDR_RENAME_TIMEOUT_MS } from '../config.ts';

/** Name the calling Herdr tab without delaying startup or writing over the TUI. */
export async function renameHerdrTab(
  env: NodeJS.ProcessEnv = process.env,
  run: typeof runHerdr = runHerdr,
): Promise<void> {
  const tabId = env.HERDR_TAB_ID?.trim();
  if (env.HERDR_ENV !== '1' || !tabId) return;

  try {
    await run(
      env.HERDR_BIN_PATH?.trim() || 'herdr',
      ['tab', 'rename', tabId, 'TUI'],
      TUI_HERDR_RENAME_TIMEOUT_MS,
    );
  } catch {
    // Cosmetic and best-effort: a missing CLI or unavailable server must not stop the TUI.
  }
}

function runHerdr(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
