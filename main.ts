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
 * This module is the orchestrator: it wires the pieces together and owns the
 * polling loop, prompt queue, and process lifecycle. Self-contained concerns
 * live in dedicated modules (commands, model-menu, chat-session, discovery,
 * system-prompt, env-guard, heartbeat, cron).
 */

import * as fs from 'node:fs';
import { buildAgentEnvelope } from './src/agent-envelope.ts';
import {
  formatBackgroundBashReportPrompt,
  setBackgroundBashReportHandler,
  stopAllBackgroundSessions,
} from './src/background-bash.ts';
import { createChatSession, type ChatSession, type ChatState } from './src/chat-session.ts';
import { handleCommand, telegramCommandMenu } from './src/commands.ts';
import {
  ALLOWED_CHAT_ID,
  BACKGROUND_MODEL,
  MAX_QUEUED_PROMPTS,
  MODEL,
  POST_RESTART_TASKS_PATH,
  PROJECT_EXTENSIONS_DIR,
  PROJECT_SKILLS_DIR,
  RESTART_EXIT_DELAY_MS,
  SEND_TOOL_CALLS,
  SESSIONS_DIR,
  SUBAGENT_MODEL,
  TELEGRAM_POLL_TIMEOUT_MS,
  TMP_DIR,
  TOOL_CALL_BATCH_MAX_ITEMS,
  ensureBotSettingsFile,
  TOOL_CALL_BATCH_MS,
  isAllowedTelegramChat,
} from './src/config.ts';
import { collectConfigProblems } from './src/config-validation.ts';
import { createCronController, cronStatusText } from './src/cron.ts';
import { discoverExtensionPaths, discoverSkillPaths } from './src/discovery.ts';
import { protectedEnvToolAccessExtension } from './src/env-guard.ts';
import { createHeartbeatController, heartbeatStatusText } from './src/heartbeat.ts';
import { ingestionEpoch, toIncomingPrompt } from './src/inbound.ts';
import { handleModelCallbackQuery } from './src/model-menu.ts';
import { sendPiResponse } from './src/outbound.ts';
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
  cancelAllSubagents,
  formatSubagentReportPrompt,
  setSubagentReportHandler,
} from './src/subagents.ts';
import {
  activeModelSystemPromptExtension,
  ensureMemoryFile,
  memorySystemPromptExtension,
  readSystemPrompt,
} from './src/system-prompt.ts';
import {
  registerBotCommands,
  sanitizeError,
  sendTelegramMessage,
  startTyping,
  telegram,
} from './src/telegram.ts';
import type { IncomingPrompt, TelegramMessage, TelegramUpdate } from './src/types.ts';
import { errorMessage, isBackgroundSource, sleep } from './src/util.ts';
import { voiceStatusText } from './src/voice.ts';

validateConfiguration();
ensureBotSettingsFile();

const EXTENSION_PATHS = discoverExtensionPaths(PROJECT_EXTENSIONS_DIR);
const SKILL_PATHS = discoverSkillPaths(PROJECT_SKILLS_DIR);

const CHAT_PI_RUNTIME: PiRuntime = createPiRuntime({
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

const BACKGROUND_PI_RUNTIME: PiRuntime = createPiRuntime({
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

interface ToolNotificationBatch {
  notifications: string[];
  timer: ReturnType<typeof setTimeout> | null;
  sending: Promise<void> | null;
}

const toolNotifications: ToolNotificationBatch = { notifications: [], timer: null, sending: null };

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

// Backgrounded sub-agents report back to the main chat agent as internal
// subagent-report prompts, which go through the normal prompt queue.
setSubagentReportHandler(async (report) => {
  await handleIncoming({
    text: formatSubagentReportPrompt(report),
    attachments: [],
    source: 'subagent-report',
    suppressNoop: true,
  });
});

// Backgrounded bash sessions report back to the main chat agent as internal
// background-bash-report prompts instead of sending direct Telegram messages.
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

async function handleIncoming(prompt: IncomingPrompt): Promise<void> {
  const session = isBackgroundSource(prompt.source) ? backgroundSession : chatSession;
  const chat = session.get();
  const trimmed = prompt.text.trim();

  if (prompt.attachments.length === 0 && trimmed.startsWith('/')) {
    const handled = await handleCommand(
      {
        chat,
        session: chatSession,
        backgroundSession,
        getBackgroundModelName,
        restart,
      },
      trimmed,
    );
    if (handled) return;
  }

  const bypassQueueLimit =
    prompt.source === 'subagent-report' || prompt.source === 'background-bash-report';
  if (!bypassQueueLimit && chat.queue.length >= MAX_QUEUED_PROMPTS) {
    cleanupAttachments(prompt);
    if (!isBackgroundSource(prompt.source)) {
      await sendTelegramMessage(
        `⚠️ Queue full (${MAX_QUEUED_PROMPTS} pending). Wait or use /abort.`,
      );
    }
    return;
  }

  chat.queue.push(prompt);
  chat.messageCount++;
  startQueueProcessing(chat, session);
}

function startQueueProcessing(chat: ChatState, session: ChatSession): void {
  void processQueue(chat, session).catch((error) => {
    console.error('queue worker failed unexpectedly:', errorMessage(error));
    chat.processing = false;

    if (running && chat.queue.length > 0) {
      setTimeout(() => startQueueProcessing(chat, session), 1_000);
    }
  });
}

function isAssistantBusy(): boolean {
  return chatSession.isBusy() || backgroundSession.isBusy();
}

function getBackgroundModelName(): string {
  return backgroundSession.existing()?.pi.modelName ?? BACKGROUND_PI_RUNTIME.modelName;
}

async function processQueue(chat: ChatState, session: ChatSession): Promise<void> {
  if (chat.processing) return;

  while (chat.queue.length > 0 && running) {
    const prompt = chat.queue.shift();
    if (!prompt) break;
    chat.processing = true;
    session.resetIdleTimer(chat);

    const typing = isBackgroundSource(prompt.source) ? { stop: () => undefined } : startTyping();
    try {
      const logLabel = prompt.source && prompt.source !== 'telegram' ? prompt.source : 'prompt';
      console.log(`${logLabel}: ${prompt.text.slice(0, 120)}`);
      const response = await chat.pi.runPrompt(prompt.text, prompt.attachments, {
        onToolCall: SEND_TOOL_CALLS
          ? (notification) => notifyToolCall(notification, prompt.source)
          : undefined,
      });
      await flushToolNotifications();
      await sendPiResponse(response, {
        suppressNoop: prompt.suppressNoop,
      });
      cleanupAttachments(prompt);
      enqueuePendingNewSessionTask(chat, prompt);
    } catch (error) {
      const message = errorMessage(error);
      console.error('error:', message);
      await flushToolNotifications();
      try {
        await sendTelegramMessage(`❌ ${sanitizeError(message)}`);
      } catch (notificationError) {
        console.error('failed to send prompt error notification:', errorMessage(notificationError));
      }
    } finally {
      typing.stop();
      chat.processing = false;
      session.resetIdleTimer(chat);
    }
  }
}

function enqueuePendingNewSessionTask(chat: ChatState, prompt: IncomingPrompt): void {
  const task = chat.pi.consumePendingNewSessionTask();
  if (!task) return;

  chat.queue.unshift({
    text: task,
    attachments: [],
    ...(prompt.source ? { source: prompt.source } : {}),
  });
  chat.messageCount++;
}

/** Best-effort removal of temp downloads created for this prompt. */
function cleanupAttachments(prompt: IncomingPrompt): void {
  for (const attachment of prompt.attachments) {
    if (attachment.path?.startsWith(TMP_DIR)) {
      try {
        fs.unlinkSync(attachment.path);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
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

        void ingestTelegramMessage(update.message);
      }
    } catch (error) {
      if (!running) break;
      console.error('Polling error:', errorMessage(error));
      await sleep(5000);
    }
  }
}

/**
 * Ingests one Telegram message detached from the polling loop, since media
 * downloads and audio transcription can take minutes. If /abort or /new bumps
 * the chat's ingestion epoch while this is in flight, the result is dropped.
 */
async function ingestTelegramMessage(message: TelegramMessage): Promise<void> {
  const epoch = ingestionEpoch();

  try {
    const incoming = await toIncomingPrompt(message);
    if (!incoming) return;

    if (ingestionEpoch() !== epoch) {
      console.log('dropping message ingested before /abort or /new');
      cleanupAttachments(incoming);
      return;
    }

    await handleIncoming(incoming);
  } catch (error) {
    console.error('failed to ingest Telegram message:', errorMessage(error));
  }
}

function logStartupBanner(): void {
  console.log('Telegram → Pi bridge started');
  console.log(`Allowed chat: ${ALLOWED_CHAT_ID}`);
  console.log(`Chat model: ${CHAT_PI_RUNTIME.modelName}`);
  console.log(`Background model: ${BACKGROUND_PI_RUNTIME.modelName}`);
  console.log(`Sub-agent model: ${SUBAGENT_MODEL}`);
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

function notifyToolCall(notification: string, source: IncomingPrompt['source']): void {
  if (isBackgroundSource(source)) return;

  toolNotifications.notifications.push(notification);

  if (
    toolNotifications.notifications.length >= TOOL_CALL_BATCH_MAX_ITEMS ||
    TOOL_CALL_BATCH_MS <= 0
  ) {
    void flushToolNotifications();
    return;
  }

  if (toolNotifications.timer) {
    clearTimeout(toolNotifications.timer);
  }
  toolNotifications.timer = setTimeout(() => {
    void flushToolNotifications();
  }, TOOL_CALL_BATCH_MS);
}

async function flushToolNotifications(): Promise<void> {
  if (toolNotifications.sending) await toolNotifications.sending;

  if (toolNotifications.timer) {
    clearTimeout(toolNotifications.timer);
    toolNotifications.timer = null;
  }

  const notifications = toolNotifications.notifications.splice(0);
  if (notifications.length === 0) return;

  toolNotifications.sending = sendTelegramMessage(notifications.join('\n'))
    .catch((error) => {
      console.error('failed to send tool notifications:', errorMessage(error));
    })
    .finally(() => {
      toolNotifications.sending = null;
    });

  await toolNotifications.sending;
}

async function shutdown(): Promise<void> {
  if (!running) return;
  running = false;
  console.log('Shutting down...');
  heartbeat.stop();
  cron.stop();
  chatSession.clear();
  backgroundSession.clear();
  await cancelAllSubagents();
  await stopAllBackgroundSessions();
}

process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

await pollTelegram();
