import {
  ALLOWED_CHAT_ID,
  ALLOWED_MODELS,
  BOT_SETTINGS_PATH,
  BOT_TOKEN,
  CHAT_MODEL,
  MODEL,
} from './config.ts';

/**
 * Validates the bot's startup configuration: the secrets that come from .env,
 * and the active chat model, which files/settings.json can override at runtime.
 *
 * The model constants in src/config.ts are source literals, so only their
 * relationships are checked here — an unusable value fails fast at model
 * resolution instead.
 *
 * Shared by main.ts (which prints the problems and exits) and scripts/smoke.ts
 * (which throws), so the startup gate and the restart gate cannot drift apart.
 */
export function collectConfigProblems(): string[] {
  const problems: string[] = [];
  const requireConfig = (condition: unknown, problem: string): void => {
    if (!condition) problems.push(problem);
  };

  requireConfig(
    BOT_TOKEN,
    'Missing TELEGRAM_BOT_TOKEN in .env. Example: TELEGRAM_BOT_TOKEN=123:abc',
  );
  requireConfig(
    ALLOWED_CHAT_ID,
    'Missing TELEGRAM_ALLOWED_CHAT_ID in .env. Example: TELEGRAM_ALLOWED_CHAT_ID=123456789',
  );
  requireConfig(
    ALLOWED_MODELS.includes(CHAT_MODEL),
    `CHAT_MODEL (${CHAT_MODEL}) must be included in ALLOWED_MODELS in src/config.ts.`,
  );
  requireConfig(
    ALLOWED_MODELS.includes(MODEL),
    `Active chat model (${MODEL}) must be included in ALLOWED_MODELS in src/config.ts. Check ${BOT_SETTINGS_PATH} or CHAT_MODEL in src/config.ts.`,
  );

  return problems;
}
