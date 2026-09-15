import {
  ALLOWED_CHAT_ID,
  ALLOWED_MODELS,
  BOT_SETTINGS_PATH,
  BOT_TOKEN,
  CHAT_MODEL,
  CRON_JOBS_ENABLED,
  HEARTBEAT_ENABLED,
  HEARTBEAT_MODEL,
  MODEL,
  SCHEDULED_TASK_MODEL,
} from './config.ts';
import { parseModelRef } from './util.ts';

/**
 * Validates the bot's startup configuration: the secrets that come from .env,
 * the active chat model, which files/settings.json can override at runtime, and
 * the agreement between each unattended feature's switch and its model.
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
  problems.push(...unattendedModelProblems());

  return problems;
}

/**
 * The two unattended features have no default model, so each one's switch in
 * files/settings.json and its model in .env must agree. Enabled without a model
 * is the case worth catching: the bot would start looking healthy and then do
 * nothing at the scheduled moment.
 */
function unattendedModelProblems(): string[] {
  const problems: string[] = [];

  for (const feature of [
    {
      setting: 'heartbeat',
      envVar: 'HEARTBEAT_MODEL',
      model: HEARTBEAT_MODEL,
      enabled: HEARTBEAT_ENABLED,
      example: 'openai-codex/gpt-5.6-terra',
    },
    {
      setting: 'cronJobs',
      envVar: 'SCHEDULED_TASK_MODEL',
      model: SCHEDULED_TASK_MODEL,
      enabled: CRON_JOBS_ENABLED,
      example: 'openai-codex/gpt-5.6-terra',
    },
  ]) {
    if (feature.enabled && !feature.model) {
      problems.push(
        `"${feature.setting}" is true in ${BOT_SETTINGS_PATH} but ${feature.envVar} is not set in .env. Example: ${feature.envVar}=${feature.example}`,
      );
      continue;
    }
    if (feature.model && !isModelRef(feature.model)) {
      problems.push(
        `${feature.envVar} in .env (${feature.model}) must be in provider/model form. Example: ${feature.envVar}=${feature.example}`,
      );
    }
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
