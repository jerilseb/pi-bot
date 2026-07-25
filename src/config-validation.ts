import {
  ALLOWED_CHAT_ID,
  ALLOWED_MODELS,
  BACKGROUND_MODEL,
  BOT_SETTINGS_PATH,
  BOT_TOKEN,
  DEFAULT_MODEL,
  MODEL,
  SUBAGENT_MODEL,
} from './config.ts';

/**
 * Validates the bot's startup configuration: the secrets that come from .env,
 * the model choices hardcoded in src/config.ts, and the active chat model
 * persisted in files/settings.json.
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
    DEFAULT_MODEL,
    'Missing CHAT_MODEL in src/config.ts. Example: CHAT_MODEL = "openrouter/openai/gpt-5.4-mini"',
  );
  requireConfig(
    BACKGROUND_MODEL,
    'Missing CONFIG_BACKGROUND_MODEL in src/config.ts. Example: CONFIG_BACKGROUND_MODEL = "openai-codex/gpt-5.5"',
  );
  requireConfig(
    SUBAGENT_MODEL,
    'Missing CONFIG_SUBAGENT_MODEL in src/config.ts. Example: CONFIG_SUBAGENT_MODEL = "openai-codex/gpt-5.4-mini"',
  );
  requireConfig(
    ALLOWED_MODELS.length > 0,
    'Missing CONFIG_ALLOWED_MODELS in src/config.ts. Example: CONFIG_ALLOWED_MODELS = ["openrouter/openai/gpt-5.4-mini", "openai-codex/gpt-5.5"]',
  );

  // Membership only means something once there is a list to be a member of.
  if (ALLOWED_MODELS.length > 0) {
    const allowsDefault = ALLOWED_MODELS.includes(DEFAULT_MODEL);
    const allowsActive = ALLOWED_MODELS.includes(MODEL);
    requireConfig(
      allowsDefault,
      `CHAT_MODEL (${DEFAULT_MODEL}) must be included in CONFIG_ALLOWED_MODELS in src/config.ts.`,
    );
    requireConfig(
      allowsActive,
      `Active chat model (${MODEL}) must be included in CONFIG_ALLOWED_MODELS in src/config.ts. Check ${BOT_SETTINGS_PATH} or CHAT_MODEL in src/config.ts.`,
    );
  }

  return problems;
}
