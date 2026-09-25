#!/usr/bin/env node

/**
 * Standalone Telegram → Pi chat bridge.
 *
 * Serves the single Telegram chat in TELEGRAM_ALLOWED_CHAT_ID: keeps one
 * foreground Pi SDK session plus a background one that starts a fresh
 * transcript for every heartbeat or scheduled-task run, queues prompts, and
 * sends Pi's final response back. Supports text, images, downloaded files,
 * optional audio transcription, local extensions, generated file uploads, model
 * refs across Pi providers, and scheduled heartbeat prompts.
 *
 * This module is the orchestrator: it constructs the runtimes and sessions,
 * the agent core (core) and the Telegram channel attached to it, wires the
 * pieces together, and owns the startup sequence and process lifecycle.
 * Everything else is a dedicated module — the prompt queue (prompt-queue), the
 * Telegram channel and its polling loop (channels/telegram), commands, menus,
 * chat-session, discovery, system-prompt, env-guard, heartbeat, cron.
 */

import * as fs from 'node:fs';
import { buildAgentEnvelope } from './src/agent-envelope.ts';
import {
  backgroundBashReportPrompt,
  setBackgroundBashReportHandler,
  stopAllBackgroundSessions,
} from './src/background-bash.ts';
import { BackgroundOutbox, setBackgroundOutbox } from './src/background-outbox.ts';
import { createChatSession } from './src/chat-session.ts';
import {
  ALLOWED_CHAT_ID,
  HEARTBEAT_MODEL,
  MODEL,
  POST_RESTART_TASKS_PATH,
  PROJECT_EXTENSIONS_DIR,
  CHANNEL_DRAIN_TIMEOUT_MS,
  RESTART_EXIT_DELAY_MS,
  HEARTBEAT_SESSIONS_DIR,
  SCHEDULED_TASKS_SESSIONS_DIR,
  SESSIONS_DIR,
  SUBAGENT_SESSIONS_DIR,
  TMP_DIR,
  ensureBotSettingsFile,
  isAllowedTelegramChat,
  toolCallMode,
} from './src/config.ts';
import { collectConfigProblems } from './src/config-validation.ts';
import {
  contextGistStatusText,
  contextGistSystemPromptExtension,
  loadContextGist,
} from './src/context-gist.ts';
import { LocalCore } from './src/core.ts';
import { createCronController, cronStatusText } from './src/cron.ts';
import { TelegramChannel } from './src/channels/telegram/channel.ts';
import { discoverExtensionPaths } from './src/discovery.ts';
import { protectedEnvToolAccessExtension } from './src/env-guard.ts';
import { createHeartbeatController, heartbeatStatusText } from './src/heartbeat.ts';
import { escapeMarkdown } from './src/markdown.ts';
import { runningJobSnapshots, setJobEventSink } from './src/job-registry.ts';
import {
  consumePostRestartTasks,
  ensurePostRestartTasksFile,
  formatPostRestartTask,
  type PostRestartTask,
} from './src/post-restart-tasks.ts';
import {
  assertModelUsable,
  createPiRuntime,
  NO_MODEL_NAME,
  type PiRuntime,
} from './src/pi-session.ts';
import {
  interruptedSubagentsNote,
  runningSubagentOriginFiles,
  setSubagentReportHandler,
  stopAllSubagents,
  subagentReportPrompt,
  subagentStatusText,
} from './src/subagent.ts';
import {
  activeModelSystemPromptExtension,
  ensureMemoryFile,
  memorySystemPromptExtension,
  readSystemPrompt,
} from './src/system-prompt.ts';
import { setToolHost } from './src/tool-host.ts';
import { errorMessage } from './src/util.ts';
import { voiceStatusText } from './src/voice.ts';

validateConfiguration();
ensureBotSettingsFile();
await loadContextGist();

const EXTENSION_PATHS = discoverExtensionPaths(PROJECT_EXTENSIONS_DIR);

// Both sessions get the same extensions, so one cannot quietly lack a guard or a
// system-prompt block the other has. Sub-agent workers get only the env guard.
const SESSION_EXTENSION_FACTORIES = [
  contextGistSystemPromptExtension,
  memorySystemPromptExtension,
  activeModelSystemPromptExtension,
  protectedEnvToolAccessExtension,
];
const WORKER_EXTENSION_FACTORIES = [protectedEnvToolAccessExtension];

const CHAT_PI_RUNTIME: PiRuntime = await createPiRuntime({
  cwd: process.cwd(),
  model: MODEL,
  sessionPrefix: 'telegram-chat',
  sessionKind: 'chat',
  getExtensionPaths: () => EXTENSION_PATHS,
  systemPromptOverride: () => readSystemPrompt(),
  extensionFactories: SESSION_EXTENSION_FACTORIES,
  workerExtensionFactories: WORKER_EXTENSION_FACTORIES,
  requestRestart: restart,
});

// No default model: heartbeat and cron each name their own on every prompt (the
// heartbeat from .env, each scheduled task from the model pinned to it), so
// there is nothing sensible to run here without one.
const BACKGROUND_PI_RUNTIME: PiRuntime = await createPiRuntime({
  cwd: process.cwd(),
  model: null,
  sessionPrefix: 'telegram-background',
  sessionKind: 'background',
  // The fallback only: each run's transcript goes to the heartbeat or
  // scheduled-tasks directory (see backgroundRunTranscript in prompt-queue).
  sessionDir: SCHEDULED_TASKS_SESSIONS_DIR,
  sessionPerPrompt: true,
  getExtensionPaths: () => EXTENSION_PATHS,
  systemPromptOverride: () => readSystemPrompt(),
  extensionFactories: SESSION_EXTENSION_FACTORIES,
  workerExtensionFactories: WORKER_EXTENSION_FACTORIES,
});

validateModels();

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(SUBAGENT_SESSIONS_DIR, { recursive: true });
fs.mkdirSync(HEARTBEAT_SESSIONS_DIR, { recursive: true });
fs.mkdirSync(SCHEDULED_TASKS_SESSIONS_DIR, { recursive: true });
ensureMemoryFile();
ensurePostRestartTasksFile();

const chatSession = createChatSession(CHAT_PI_RUNTIME);
const backgroundSession = createChatSession(BACKGROUND_PI_RUNTIME);
let running = true;

// What background runs send waits until the chat has been idle for
// BACKGROUND_DELIVERY_COOLDOWN_MS, so a report never interrupts a conversation.
// With no interface attached, it keeps them until one is.
const outbox = new BackgroundOutbox({
  isChatBusy: () => chatSession.isBusy(),
  hasAudience: () => core.hasChannels(),
});
setBackgroundOutbox(outbox);

const core = new LocalCore({
  chatSession,
  backgroundSession,
  restart,
  isRunning: () => running,
  runningJobs: runningJobSnapshots,
});
// The agent's tools reach the user through the core, and so does job progress.
setToolHost(core.toolHost);
setJobEventSink((event) => core.emit(event));
const telegramChannel = new TelegramChannel({ core, cwd: process.cwd() });
core.attach(telegramChannel);

// Neither waits for the chat, only for the background run before it.
const heartbeat = createHeartbeatController({
  handleIncoming: (prompt) => core.enqueue(prompt),
  isBackgroundBusy: () => backgroundSession.isBusy(),
  isRunning: () => running,
});

const cron = createCronController({
  handleIncoming: (prompt) => core.enqueue(prompt),
  isBackgroundBusy: () => backgroundSession.isBusy(),
  isRunning: () => running,
});

// Backgrounded bash sessions report back to the agent that started them as
// internal background-bash-report prompts that go through the normal prompt
// queue, rather than sending messages of their own.
setBackgroundBashReportHandler(async (report) => {
  await core.enqueue(backgroundBashReportPrompt(report));
});
setSubagentReportHandler(async (report) => {
  await core.enqueue(subagentReportPrompt(report));
});

function validateConfiguration(): void {
  const problems = collectConfigProblems();
  if (problems.length === 0) return;

  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(1);
}

/**
 * Resolving a model is no longer a side effect of building a runtime, so each
 * configured model is checked here instead. Unattended runs switch models at run
 * time, which is the worst moment to discover a typo or a missing login.
 */
function validateModels(): void {
  const configured: Array<{ label: string; runtime: PiRuntime; model: string }> = [
    { label: 'Active chat model', runtime: CHAT_PI_RUNTIME, model: MODEL },
  ];
  if (HEARTBEAT_MODEL) {
    configured.push({
      label: 'HEARTBEAT_MODEL in .env',
      runtime: BACKGROUND_PI_RUNTIME,
      model: HEARTBEAT_MODEL,
    });
  }

  for (const { label, runtime, model } of configured) {
    try {
      assertModelUsable(runtime.modelRuntime, model);
    } catch (error) {
      console.error(`${label} (${model}) is not usable: ${errorMessage(error)}`);
      process.exit(1);
    }
  }
}

/** Shuts the bot down and exits so systemd brings the process back up. */
async function restart(): Promise<void> {
  // Before the restart note, which must stay the session's last entry.
  await noteInterruptedSubagents();
  // Written before the session is disposed, and the single seam both the
  // /restart command and the restart_bot tool pass through. Its absence at the
  // next startup is what identifies an exit nobody asked for.
  await chatSession
    .get()
    .pi.noteEventBeforeExit(
      'restart',
      'The bot process was restarted deliberately. This session resumed, but any in-flight work was dropped.',
    );
  await shutdown();
  setTimeout(() => process.exit(0), RESTART_EXIT_DELAY_MS);
}

/**
 * Tell each session about the sub-agent jobs it started that shutdown is about
 * to stop. Their reports would otherwise simply never come, and the next turn
 * would have no way to know the work was lost. Background runs each have their
 * own transcript, so each run that started a job gets its own note.
 */
async function noteInterruptedSubagents(): Promise<void> {
  const chatNote = interruptedSubagentsNote('chat');
  if (chatNote) await chatSession.get().pi.noteEventBeforeExit('subagent', chatNote);
  for (const file of runningSubagentOriginFiles('background')) {
    const note = interruptedSubagentsNote('background', file);
    if (note) await backgroundSession.get().pi.noteEventBeforeExit('subagent', note, file);
  }
}

/**
 * Record an exit nobody announced.
 *
 * A deliberate restart leaves its note as the session's last entry, so finding
 * anything else there means the previous run ended some other way — a crash, or
 * a stop and start. Either way the conversation is about to continue as if
 * nothing happened, which is the confusion worth heading off.
 */
async function noteUncleanExit(): Promise<void> {
  const last = await chatSession.get().pi.lastNoteKind();
  if (last === 'restart' || last === 'restart-unclean') return;
  await chatSession
    .get()
    .pi.noteEvent(
      'restart-unclean',
      'The bot process restarted without a recorded restart command — it crashed or was stopped. Anything it was working on was interrupted.',
    );
}

async function run(): Promise<void> {
  logStartupBanner();

  await telegramChannel.registerCommands();
  await noteUncleanExit();
  heartbeat.start();
  cron.start();
  core.notice('✅ Bot is up and running.');
  await enqueuePostRestartTasks();

  await telegramChannel.poll({ isRunning: () => running });
}

function logStartupBanner(): void {
  console.log('Telegram → Pi bridge started');
  console.log(`Allowed chat: ${ALLOWED_CHAT_ID}`);
  console.log(`Chat model: ${CHAT_PI_RUNTIME.modelName ?? NO_MODEL_NAME}`);
  console.log('Pi runtime: SDK');
  console.log(`Extensions: ${EXTENSION_PATHS.length ? EXTENSION_PATHS.join(', ') : 'none'}`);
  console.log(`Voice note tool: ${voiceStatusText()}`);
  console.log(`Context gist: ${contextGistStatusText()}`);
  console.log(`Tool call messages: ${toolCallMode()}`);
  console.log(`Sub-agents: ${subagentStatusText()}`);
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
    if (!isAllowedTelegramChat(task.chatId)) {
      console.warn(
        `skipping post-restart task from chat ${task.chatId}: ${formatPostRestartTask(task)}`,
      );
      continue;
    }

    console.log(`enqueueing post-restart task: ${formatPostRestartTask(task)}`);
    try {
      core.notice(
        escapeMarkdown(`🔁 Running post-restart task${task.title ? `: ${task.title}` : ''}`),
      );
      // Not user input: that steers a run already in progress, so a second task
      // would be folded into the first one's turn instead of getting its own.
      await core.enqueue({
        text: buildPostRestartPrompt(task),
        attachments: [],
        origin: { kind: 'post-restart', taskId: task.id },
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
  outbox.stop();
  chatSession.clear();
  backgroundSession.clear();
  await stopAllBackgroundSessions();
  await stopAllSubagents();
  // Channels send in the background; let what the cleared turns left go out.
  await core.drain(CHANNEL_DRAIN_TIMEOUT_MS);
}

/** A stop from outside: note what is being cut short, then shut down. */
async function shutdownFromSignal(): Promise<void> {
  if (!running) return;
  await noteInterruptedSubagents();
  await shutdown();
}

process.on('SIGINT', () => void shutdownFromSignal().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdownFromSignal().then(() => process.exit(0)));

await run();
