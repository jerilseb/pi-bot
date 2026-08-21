#!/usr/bin/env node

/**
 * Standalone Telegram → Pi chat bridge.
 *
 * Serves the single Telegram chat in TELEGRAM_ALLOWED_CHAT_ID: polls for
 * updates, keeps one foreground and one background Pi SDK session, queues
 * prompts, and sends Pi's final response back. Supports text, images,
 * downloaded files, optional audio transcription, local extensions/skills,
 * generated file uploads, model refs across Pi providers, and scheduled heartbeat prompts.
 *
 * This module is the orchestrator: it constructs the runtimes and sessions,
 * wires the pieces together, and owns the polling loop and process lifecycle.
 * Everything else is a dedicated module — the prompt queue (prompt-queue),
 * message ingestion (inbound), tool-call batching (tool-notification-batch),
 * commands, menus, chat-session, discovery, system-prompt, env-guard,
 * heartbeat, cron.
 */

import * as fs from 'node:fs';
import { buildAgentEnvelope } from './src/agent-envelope.ts';
import {
  formatBackgroundBashReportPrompt,
  setBackgroundBashReportHandler,
  stopAllBackgroundSessions,
} from './src/background-bash.ts';
import { createChatSession } from './src/chat-session.ts';
import { telegramCommandMenu } from './src/commands.ts';
import {
  ALLOWED_CHAT_ID,
  BACKGROUND_MODEL,
  MODEL,
  PI_AGENT_SKILLS_DIR,
  POST_RESTART_TASKS_PATH,
  PROJECT_EXTENSIONS_DIR,
  PROJECT_SKILLS_DIR,
  RESTART_EXIT_DELAY_MS,
  SEND_TOOL_CALLS,
  SESSIONS_DIR,
  TELEGRAM_POLL_TIMEOUT_MS,
  TMP_DIR,
  ensureBotSettingsFile,
  isAllowedTelegramChat,
} from './src/config.ts';
import { collectConfigProblems } from './src/config-validation.ts';
import { createCronController, cronStatusText } from './src/cron.ts';
import { discoverExtensionPaths, discoverSkillPaths } from './src/discovery.ts';
import { protectedEnvToolAccessExtension } from './src/env-guard.ts';
import { createHeartbeatController, heartbeatStatusText } from './src/heartbeat.ts';
import { ingestTelegramMessage } from './src/inbound.ts';
import { handleModelCallbackQuery } from './src/model-menu.ts';
import { createPromptQueue } from './src/prompt-queue.ts';
import { handleReasoningCallbackQuery } from './src/reasoning-menu.ts';
import {
  consumePostRestartTasks,
  ensurePostRestartTasksFile,
  formatPostRestartTask,
  type PostRestartTask,
} from './src/post-restart-tasks.ts';
import { handleTelegramMenuCallbackQuery } from './src/telegram-menu.ts';
import { createPiRuntime, type PiRuntime } from './src/pi-session.ts';
import {
  activeModelSystemPromptExtension,
  ensureMemoryFile,
  memorySystemPromptExtension,
  readSystemPrompt,
} from './src/system-prompt.ts';
import { registerBotCommands, sendTelegramMessage, telegram } from './src/telegram.ts';
import type { TelegramUpdate } from './src/types.ts';
import { errorMessage, sleep } from './src/util.ts';
import { voiceStatusText } from './src/voice.ts';

validateConfiguration();
ensureBotSettingsFile();

const EXTENSION_PATHS = discoverExtensionPaths(PROJECT_EXTENSIONS_DIR);
const SKILL_PATHS = discoverSkillPaths(PROJECT_SKILLS_DIR, PI_AGENT_SKILLS_DIR);

const CHAT_PI_RUNTIME: PiRuntime = await createPiRuntime({
  cwd: process.cwd(),
  model: MODEL,
  sessionPrefix: 'telegram-chat',
  getExtensionPaths: () => EXTENSION_PATHS,
  getSkillPaths: () => SKILL_PATHS,
  systemPromptOverride: () => readSystemPrompt(),
  extensionFactories: [
    memorySystemPromptExtension,
    activeModelSystemPromptExtension,
    protectedEnvToolAccessExtension,
  ],
  requestRestart: restart,
});

const BACKGROUND_PI_RUNTIME: PiRuntime = await createPiRuntime({
  cwd: process.cwd(),
  model: BACKGROUND_MODEL,
  sessionPrefix: 'telegram-background',
  getExtensionPaths: () => EXTENSION_PATHS,
  getSkillPaths: () => SKILL_PATHS,
  systemPromptOverride: () => readSystemPrompt(),
  extensionFactories: [
    memorySystemPromptExtension,
    activeModelSystemPromptExtension,
    protectedEnvToolAccessExtension,
  ],
});

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
ensureMemoryFile();
ensurePostRestartTasksFile();

const chatSession = createChatSession(CHAT_PI_RUNTIME, 'chat');
const backgroundSession = createChatSession(BACKGROUND_PI_RUNTIME, 'background');
let offset = 0;
let running = true;

const { handleIncoming, isAssistantBusy } = createPromptQueue({
  chatSession,
  backgroundSession,
  backgroundModelFallback: BACKGROUND_PI_RUNTIME.modelName,
  restart,
  isRunning: () => running,
});

const heartbeat = createHeartbeatController({
  handleIncoming,
  isChatBusy: isAssistantBusy,
  isRunning: () => running,
});

const cron = createCronController({
  handleIncoming,
  isChatBusy: isAssistantBusy,
  isRunning: () => running,
});

// Backgrounded bash sessions report back to the main chat agent as internal
// background-bash-report prompts that go through the normal prompt queue,
// rather than sending direct Telegram messages.
setBackgroundBashReportHandler(async (report) => {
  await handleIncoming({
    text: formatBackgroundBashReportPrompt(report),
    attachments: [],
    source: 'background-bash-report',
    suppressNoop: true,
  });
});

function validateConfiguration(): void {
  const problems = collectConfigProblems();
  if (problems.length === 0) return;

  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(1);
}

/** Shuts the bot down and exits so systemd brings the process back up. */
async function restart(): Promise<void> {
  await shutdown();
  setTimeout(() => process.exit(0), RESTART_EXIT_DELAY_MS);
}

async function pollTelegram(): Promise<void> {
  logStartupBanner();

  await registerBotCommands(telegramCommandMenu());
  heartbeat.start();
  cron.start();
  await notifyAppStarted();
  await enqueuePostRestartTasks();

  while (running) {
    try {
      const params = new URLSearchParams({
        offset: String(offset),
        timeout: '30',
        allowed_updates: JSON.stringify(['message', 'callback_query']),
      });
      const data = await telegram<{ ok: boolean; result: TelegramUpdate[] }>(
        `getUpdates?${params}`,
        undefined,
        TELEGRAM_POLL_TIMEOUT_MS,
      );
      if (!data.ok) {
        await sleep(5000);
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        if (update.callback_query) {
          await handleModelCallbackQuery(update.callback_query, chatSession);
          await handleReasoningCallbackQuery(update.callback_query, chatSession);
          await handleTelegramMenuCallbackQuery(update.callback_query, handleIncoming);
          continue;
        }

        if (!update.message) continue;

        void ingestTelegramMessage(update.message, handleIncoming);
      }
    } catch (error) {
      if (!running) break;
      console.error('Polling error:', errorMessage(error));
      await sleep(5000);
    }
  }
}

function logStartupBanner(): void {
  console.log('Telegram → Pi bridge started');
  console.log(`Allowed chat: ${ALLOWED_CHAT_ID}`);
  console.log(`Chat model: ${CHAT_PI_RUNTIME.modelName}`);
  console.log(`Background model: ${BACKGROUND_PI_RUNTIME.modelName}`);
  console.log('Pi runtime: SDK');
  console.log(`Extensions: ${EXTENSION_PATHS.length ? EXTENSION_PATHS.join(', ') : 'none'}`);
  console.log(`Skills: ${SKILL_PATHS.length ? SKILL_PATHS.join(', ') : 'none'}`);
  console.log(`Voice note tool: ${voiceStatusText()}`);
  console.log(`Tool call messages: ${SEND_TOOL_CALLS ? 'on' : 'off'}`);
  console.log(heartbeatStatusText());
  console.log(cronStatusText());
  console.log(`Post-restart tasks: ${POST_RESTART_TASKS_PATH}`);
}

async function notifyAppStarted(): Promise<void> {
  try {
    await sendTelegramMessage('✅ Bot is up and running.');
  } catch (error) {
    console.error('failed to send startup notification:', errorMessage(error));
  }
}

async function enqueuePostRestartTasks(): Promise<void> {
  let tasks: PostRestartTask[];
  try {
    tasks = consumePostRestartTasks();
  } catch (error) {
    console.error('Failed to read post-restart tasks:', errorMessage(error));
    return;
  }

  for (const task of tasks) {
    if (!isAllowedTelegramChat(task.chatId)) {
      console.warn(
        `skipping post-restart task from chat ${task.chatId}: ${formatPostRestartTask(task)}`,
      );
      continue;
    }

    console.log(`enqueueing post-restart task: ${formatPostRestartTask(task)}`);
    try {
      await sendTelegramMessage(
        `🔁 Running post-restart task${task.title ? `: ${task.title}` : ''}`,
      );
      await handleIncoming({
        text: buildPostRestartPrompt(task),
        attachments: [],
        source: 'telegram',
      });
    } catch (error) {
      console.error(`failed to enqueue post-restart task ${task.id}:`, errorMessage(error));
    }
  }
}

function buildPostRestartPrompt(task: PostRestartTask): string {
  return buildAgentEnvelope({
    preamble: 'This is a post-restart task for the Telegram assistant.',
    meta: [
      ['Task ID', task.id],
      ['Title', task.title],
      ['Created at', task.createdAt],
      ['Current time', new Date().toISOString()],
    ],
    sections: [
      {
        intro: 'The bot has restarted successfully. Run these instructions now:',
        tag: 'post_restart_instructions',
        body: task.prompt,
      },
    ],
    guidance: [
      'Notify the Telegram user with the result, unless the instructions explicitly say not to.',
    ],
  });
}

async function shutdown(): Promise<void> {
  if (!running) return;
  running = false;
  console.log('Shutting down...');
  heartbeat.stop();
  cron.stop();
  chatSession.clear();
  backgroundSession.clear();
  await stopAllBackgroundSessions();
}

process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

await pollTelegram();
