import {
  ALLOWED_CHAT_ID,
  ALLOWED_MODELS,
  BOT_SETTINGS_PATH,
  BOT_TOKEN,
  CHAT_MODEL,
  ENABLE_SUBAGENTS,
  HEARTBEAT_ENABLED,
  HEARTBEAT_MODEL,
  MODEL,
} from './config.ts';
import { parseModelRef } from './util.ts';

/**
 * Validates the bot's startup configuration: the secrets that come from .env,
 * the active chat model, which files/settings.json can override at runtime, and
 * the agreement between the heartbeat switch and its model.
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
  problems.push(...heartbeatModelProblems());
  requireConfig(
    ['', 'true', 'false'].includes(ENABLE_SUBAGENTS.toLowerCase()),
    `ENABLE_SUBAGENTS in .env (${ENABLE_SUBAGENTS}) must be true or false.`,
  );

  return problems;
}

/**
 * The heartbeat has no default model, so its switch in files/settings.json and
 * its model in .env must agree. Enabled without a model is the case worth
 * catching: the bot would start looking healthy and then do nothing at the
 * scheduled moment. Scheduled tasks fall back to the chat model, which is
 * validated above, so they need no check here.
 */
function heartbeatModelProblems(): string[] {
  const problems: string[] = [];
  const example = 'openai-codex/gpt-5.6-terra';

  if (HEARTBEAT_ENABLED && !HEARTBEAT_MODEL) {
    problems.push(
      `"heartbeat" is true in ${BOT_SETTINGS_PATH} but HEARTBEAT_MODEL is not set in .env. Example: HEARTBEAT_MODEL=${example}`,
    );
  } else if (HEARTBEAT_MODEL && !isModelRef(HEARTBEAT_MODEL)) {
    problems.push(
      `HEARTBEAT_MODEL in .env (${HEARTBEAT_MODEL}) must be in provider/model form. Example: HEARTBEAT_MODEL=${example}`,
    );
  }

  return problems;
}

/** Whether the model is usable is checked against the model runtime at startup. */
function isModelRef(value: string): boolean {
  try {
    parseModelRef(value);
    return true;
  } catch {
    return false;
  }
}
