#!/usr/bin/env node

/**
 * Standalone web UI → Pi chat bridge.
 *
 * Serves a browser web UI over HTTP + WebSocket, keeps one Pi SDK session per
 * chat, queues prompts per chat, and streams Pi's response back to the browser
 * live. Supports text, image/file uploads, audio transcription, local
 * extensions/skills, generated file uploads, model refs across Pi providers,
 * scheduled heartbeat/cron prompts, and Web Push notifications.
 *
 * This module is the orchestrator: it wires the pieces together and owns the
 * web server boot, per-chat queue, and process lifecycle. Self-contained
 * concerns live in dedicated modules (commands, chat-session, discovery,
 * system-prompt, env-guard, heartbeat, cron, web/*).
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import {
  formatBackgroundBashReportPrompt,
  setBackgroundBashReportHandler,
  stopAllBackgroundSessions,
} from './src/background-bash.ts';
import { createChatRegistry, type ChatRegistry, type ChatState } from './src/chat-session.ts';
import { handleCommand } from './src/commands.ts';
import {
  ACTIVE_MODEL_PATH,
  ALLOWED_MODELS,
  BACKGROUND_MODEL,
  DEFAULT_MODEL,
  MAX_QUEUE_PER_CHAT,
  MODEL,
  POST_RESTART_TASKS_PATH,
  PROJECT_EXTENSIONS_DIR,
  PROJECT_SKILLS_DIR,
  SESSIONS_DIR,
  SUBAGENT_MODEL,
  TMP_DIR,
  WEB_CHAT_ID,
  WEB_PUSH_ENABLED,
  WEB_PUSH_VAPID_PRIVATE,
  WEB_PUSH_VAPID_PUBLIC,
} from './src/config.ts';
import { createCronController, cronStatusText } from './src/cron.ts';
import { discoverExtensionPaths, discoverSkillPaths } from './src/discovery.ts';
import { protectedEnvToolAccessExtension } from './src/env-guard.ts';
import { createHeartbeatController, heartbeatStatusText } from './src/heartbeat.ts';
import { sendPiResponse } from './src/outbound.ts';
import {
  consumePostRestartTasks,
  ensurePostRestartTasksFile,
  formatPostRestartTask,
  type PostRestartTask,
} from './src/post-restart-tasks.ts';
import { createPiRuntime, type PiRuntime } from './src/pi-session.ts';
import { transcribeAudio } from './src/speech.ts';
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
import type { IncomingPrompt } from './src/types.ts';
import { errorMessage, isBackgroundSource, writeModelState } from './src/util.ts';
import { voiceStatusText } from './src/voice.ts';
import { sweep as sweepAssets } from './src/web/assets.ts';
import * as gateway from './src/web/gateway.ts';
import { createWebServer, type WebServerHandle } from './src/web/server.ts';

validateEnvironment();
writeModelState(ACTIVE_MODEL_PATH, MODEL);

const EXTENSION_PATHS = discoverExtensionPaths(PROJECT_EXTENSIONS_DIR);
const SKILL_PATHS = discoverSkillPaths(PROJECT_SKILLS_DIR);

const CHAT_PI_RUNTIME: PiRuntime = createPiRuntime({
  cwd: process.cwd(),
  model: MODEL,
  sessionPrefix: 'web-chat',
  getExtensionPaths: () => EXTENSION_PATHS,
  getSkillPaths: () => SKILL_PATHS,
  systemPromptOverride: () => readSystemPrompt(),
  extensionFactories: [
    memorySystemPromptExtension,
    activeModelSystemPromptExtension,
    protectedEnvToolAccessExtension,
  ],
  requestRestart: restart,
  writeModelState: (model) => writeModelState(ACTIVE_MODEL_PATH, model),
});

const BACKGROUND_PI_RUNTIME: PiRuntime = createPiRuntime({
  cwd: process.cwd(),
  model: BACKGROUND_MODEL,
  sessionPrefix: 'web-background',
  getExtensionPaths: () => EXTENSION_PATHS,
  getSkillPaths: () => SKILL_PATHS,
  systemPromptOverride: () => readSystemPrompt(),
  extensionFactories: [
    memorySystemPromptExtension,
    activeModelSystemPromptExtension,
    protectedEnvToolAccessExtension,
  ],
  writeModelState: () => undefined,
});

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
ensureMemoryFile();
ensurePostRestartTasksFile();

const chats = createChatRegistry(CHAT_PI_RUNTIME);
const backgroundChats = createChatRegistry(BACKGROUND_PI_RUNTIME);
let running = true;
let webServer: WebServerHandle | null = null;
let assetSweepTimer: ReturnType<typeof setInterval> | null = null;

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
// subagent-report prompts, which go through the normal per-chat queue.
setSubagentReportHandler(async (report) => {
  await handleIncoming({
    chatId: report.chatId,
    text: formatSubagentReportPrompt(report),
    attachments: [],
    source: 'subagent-report',
    suppressNoop: true,
  });
});

// Backgrounded bash sessions report back to the main chat agent as internal
// background-bash-report prompts.
setBackgroundBashReportHandler(async (report) => {
  await handleIncoming({
    chatId: report.chatId,
    text: formatBackgroundBashReportPrompt(report),
    attachments: [],
    source: 'background-bash-report',
    suppressNoop: true,
  });
});

function validateEnvironment(): void {
  if (!DEFAULT_MODEL) {
    console.error(
      'Missing CHAT_MODEL in src/config.ts. Example: CHAT_MODEL = "openrouter/openai/gpt-5.4-mini"',
    );
    process.exit(1);
  }

  if (ALLOWED_MODELS.length === 0) {
    console.error(
      'Missing CONFIG_ALLOWED_MODELS in src/config.ts. Example: CONFIG_ALLOWED_MODELS = ["openrouter/openai/gpt-5.4-mini", "openai-codex/gpt-5.5"]',
    );
    process.exit(1);
  }

  if (!ALLOWED_MODELS.includes(DEFAULT_MODEL)) {
    console.error(
      `CHAT_MODEL (${DEFAULT_MODEL}) must be included in CONFIG_ALLOWED_MODELS in src/config.ts.`,
    );
    process.exit(1);
  }

  if (!ALLOWED_MODELS.includes(MODEL)) {
    console.error(
      `Active chat model (${MODEL}) must be included in CONFIG_ALLOWED_MODELS in src/config.ts. Check ${ACTIVE_MODEL_PATH} or CHAT_MODEL in src/config.ts.`,
    );
    process.exit(1);
  }

  if (!BACKGROUND_MODEL || !ALLOWED_MODELS.includes(BACKGROUND_MODEL)) {
    console.error('CONFIG_BACKGROUND_MODEL must be set and included in CONFIG_ALLOWED_MODELS.');
    process.exit(1);
  }

  if (!SUBAGENT_MODEL || !ALLOWED_MODELS.includes(SUBAGENT_MODEL)) {
    console.error('CONFIG_SUBAGENT_MODEL must be set and included in CONFIG_ALLOWED_MODELS.');
    process.exit(1);
  }

  if (WEB_PUSH_ENABLED && (!WEB_PUSH_VAPID_PUBLIC || !WEB_PUSH_VAPID_PRIVATE)) {
    console.error(
      'WEB_PUSH_ENABLED=true requires WEB_PUSH_VAPID_PUBLIC and WEB_PUSH_VAPID_PRIVATE in .env.',
    );
    process.exit(1);
  }
}

/** Shuts the bot down and exits so PM2 brings the process back up. */
async function restart(): Promise<void> {
  await shutdown();
  setTimeout(() => process.exit(0), 250);
}

async function handleIncoming(prompt: IncomingPrompt): Promise<void> {
  const registry = isBackgroundSource(prompt.source) ? backgroundChats : chats;
  const chat = registry.get(prompt.chatId);
  const trimmed = prompt.text.trim();

  if (prompt.attachments.length === 0 && trimmed.startsWith('/')) {
    const handled = await handleCommand(
      {
        chat,
        registry: chats,
        backgroundRegistry: backgroundChats,
        getBackgroundModelName,
        restart,
      },
      trimmed,
    );
    if (handled) return;
  }

  const bypassQueueLimit =
    prompt.source === 'subagent-report' || prompt.source === 'background-bash-report';
  if (!bypassQueueLimit && chat.queue.length >= MAX_QUEUE_PER_CHAT) {
    if (!isBackgroundSource(prompt.source)) {
      gateway.notice(
        prompt.chatId,
        `⚠️ Queue full (${MAX_QUEUE_PER_CHAT} pending). Wait or use /abort.`,
        'warn',
      );
    }
    return;
  }

  chat.queue.push(prompt);
  chat.messageCount++;
  void processQueue(chat, registry);
}

function isAssistantBusy(chatId: string): boolean {
  return chats.isBusy(chatId) || backgroundChats.isBusy(chatId);
}

function getBackgroundModelName(chatId: string): string {
  return backgroundChats.getExisting(chatId)?.pi.modelName ?? BACKGROUND_PI_RUNTIME.modelName;
}

async function processQueue(chat: ChatState, registry: ChatRegistry): Promise<void> {
  if (chat.processing) return;

  while (chat.queue.length > 0 && running) {
    const prompt = chat.queue.shift();
    if (!prompt) break;
    chat.processing = true;
    registry.resetIdleTimer(chat);

    const runId = randomUUID();
    const source = prompt.source ?? 'web';
    const live = source === 'web';
    gateway.runStart(prompt.chatId, runId, source);
    try {
      console.log(`[${prompt.chatId}] ${source}: ${prompt.text.slice(0, 120)}`);
      const response = await chat.pi.runPrompt(prompt.text, prompt.attachments, {
        onEvent: (event) =>
          live
            ? gateway.stream(prompt.chatId, runId, event)
            : gateway.streamBackground(prompt.chatId, runId, event),
      });
      await sendPiResponse(prompt.chatId, response, {
        suppressNoop: prompt.suppressNoop,
      });
      enqueuePendingNewSessionTask(chat, prompt);
    } catch (error) {
      const message = errorMessage(error);
      console.error(`[${prompt.chatId}] error:`, message);
      gateway.error(prompt.chatId, sanitizeError(message));
    } finally {
      gateway.runEnd(prompt.chatId, runId, source);
      chat.processing = false;
      registry.resetIdleTimer(chat);
    }
  }
}

function enqueuePendingNewSessionTask(chat: ChatState, prompt: IncomingPrompt): void {
  const task = chat.pi.consumePendingNewSessionTask();
  if (!task) return;

  chat.queue.unshift({
    chatId: prompt.chatId,
    text: task,
    attachments: [],
    ...(prompt.source ? { source: prompt.source } : {}),
  });
  chat.messageCount++;
}

function sanitizeError(error: string): string {
  const firstUsefulLine = error
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('at ') && !line.startsWith('node:'));
  const message = firstUsefulLine || 'Something went wrong.';
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function statusText(): string {
  return [
    `chat ${CHAT_PI_RUNTIME.modelName}`,
    `background ${BACKGROUND_PI_RUNTIME.modelName}`,
    heartbeatStatusText(),
    cronStatusText(),
  ].join(' · ');
}

async function setModel(model: string): Promise<void> {
  const trimmed = model.trim();
  if (!ALLOWED_MODELS.includes(trimmed)) {
    throw new Error(`Model ${trimmed} is not in the allowed list.`);
  }
  await chats.get(WEB_CHAT_ID).pi.setModel(trimmed);
}

function start(): void {
  logStartupBanner();

  webServer = createWebServer({
    chatId: WEB_CHAT_ID,
    handleIncoming,
    getModelName: () => chats.get(WEB_CHAT_ID).pi.modelName,
    allowedModels: [...ALLOWED_MODELS],
    setModel,
    isBusy: () => isAssistantBusy(WEB_CHAT_ID),
    statusText,
    transcribe: (filePath, mimeType, name) => transcribeAudio(filePath, mimeType, name),
  });

  sweepAssets();
  assetSweepTimer = setInterval(() => sweepAssets(), 10 * 60_000);

  heartbeat.start();
  cron.start();
  void enqueuePostRestartTasks();
}

function logStartupBanner(): void {
  console.log('Web UI → Pi bridge started');
  console.log(`Chat model: ${CHAT_PI_RUNTIME.modelName}`);
  console.log(`Background model: ${BACKGROUND_PI_RUNTIME.modelName}`);
  console.log(`Sub-agent model: ${SUBAGENT_MODEL}`);
  console.log('Pi runtime: SDK');
  console.log(`Extensions: ${EXTENSION_PATHS.length ? EXTENSION_PATHS.join(', ') : 'none'}`);
  console.log(`Skills: ${SKILL_PATHS.length ? SKILL_PATHS.join(', ') : 'none'}`);
  console.log(`Voice note tool: ${voiceStatusText()}`);
  console.log(`Web Push: ${WEB_PUSH_ENABLED ? 'enabled' : 'off'}`);
  console.log(heartbeatStatusText());
  console.log(cronStatusText());
  console.log(`Post-restart tasks: ${POST_RESTART_TASKS_PATH}`);
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
    console.log(`[${task.chatId}] enqueueing post-restart task: ${formatPostRestartTask(task)}`);
    try {
      gateway.notice(task.chatId, `🔁 Running post-restart task${task.title ? `: ${task.title}` : ''}`);
      await handleIncoming({
        chatId: task.chatId,
        text: buildPostRestartPrompt(task),
        attachments: [],
        source: 'web',
      });
    } catch (error) {
      console.error(
        `[${task.chatId}] failed to enqueue post-restart task ${task.id}:`,
        errorMessage(error),
      );
    }
  }
}

function buildPostRestartPrompt(task: PostRestartTask): string {
  return [
    'This is a post-restart task for the assistant.',
    `Task ID: ${task.id}`,
    ...(task.title ? [`Title: ${task.title}`] : []),
    `Created at: ${task.createdAt}`,
    `Current time: ${new Date().toISOString()}`,
    '',
    'The bot has restarted successfully. Run these instructions now:',
    '<post_restart_instructions>',
    task.prompt,
    '</post_restart_instructions>',
    '',
    'Notify the user with the result, unless the instructions explicitly say not to.',
  ].join('\n');
}

async function shutdown(): Promise<void> {
  if (!running) return;
  running = false;
  console.log('Shutting down...');
  heartbeat.stop();
  cron.stop();
  if (assetSweepTimer) clearInterval(assetSweepTimer);
  chats.clearAll();
  backgroundChats.clearAll();
  await cancelAllSubagents();
  await stopAllBackgroundSessions();
  if (webServer) await webServer.close();
}

process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

start();
