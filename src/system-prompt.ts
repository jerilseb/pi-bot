import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  BOT_SETTINGS_PATH,
  DAILY_MEMORY_DIR,
  FILES_DIR,
  MEMORY_PATH,
  SUBAGENT_PROMPT_PATH,
  SYSTEM_PROMPT_PATH,
} from './config.ts';
import { localDateString } from './util.ts';

export function readSystemPrompt(): string {
  return fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8').trim();
}

/**
 * The system prompt a sub-agent worker runs under. Short and standalone on
 * purpose: a worker has no chat history, no memory blocks, and no user to talk
 * to, so the chat prompt's guidance about the conversation would only mislead
 * it. Checked in as a file, like the chat prompt, so it can be tuned without a
 * code change.
 */
export function readSubagentSystemPrompt(): string {
  return fs.readFileSync(SUBAGENT_PROMPT_PATH, 'utf8').trim();
}

export function ensureMemoryFile(): void {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(DAILY_MEMORY_DIR, { recursive: true });
  if (!fs.existsSync(MEMORY_PATH)) {
    fs.writeFileSync(MEMORY_PATH, '# Memory\n\n', 'utf8');
  }
  ensureDailyMemoryFile(todayLocalDate());
}

function ensureDailyMemoryFile(date: string): string {
  fs.mkdirSync(DAILY_MEMORY_DIR, { recursive: true });
  const filePath = dailyMemoryPath(date);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# Daily memory — ${date}\n\n`, 'utf8');
  }
  return filePath;
}

function dailyMemoryPath(date: string): string {
  return path.join(DAILY_MEMORY_DIR, `${date}.md`);
}

function todayLocalDate(): string {
  return localDateString(new Date());
}

function readMemory(): string {
  ensureMemoryFile();
  const content = fs.readFileSync(MEMORY_PATH, 'utf8').trim();
  return markdownBody(content) ? content : '';
}

function markdownBody(content: string): string {
  return content.replace(/^# .+$/m, '').trim();
}

function appendMemoryToSystemPrompt(systemPrompt: string): string {
  const today = todayLocalDate();
  const todayPath = ensureDailyMemoryFile(today);
  const memory = readMemory();

  return [
    systemPrompt,
    '',
    '## Memory system',
    `Long-term memory file: ${MEMORY_PATH}`,
    `Daily notes directory: ${DAILY_MEMORY_DIR}`,
    `Today's daily note file: ${todayPath}`,
    '',
    "Use long-term memory for durable facts, stable user preferences, standing instructions, recurring project context, and explicit 'remember this' requests.",
    "Use today's daily note for session/work logs, commands run, commits, temporary findings, research summaries, decisions that may be useful later, and detailed context that should not always be injected forever.",
    "Daily note contents are not injected automatically to keep the provider prompt cache stable; use the read tool to open today's daily note when session history or detailed recent context is needed.",
    "Before answering continuation/history questions such as 'continue', 'what did we do earlier', 'pick up from last time', or 'check today's notes', read today's daily note first. Read older daily notes only when the user asks for older context or today's note points to them.",
    "Do not read daily notes on every turn; read them only when they are relevant to the user's request.",
    'If a daily note becomes a durable preference or standing instruction, promote a concise summary to long-term memory and remove stale detail when appropriate.',
    'Do not store secrets, API keys, tokens, passwords, or highly sensitive personal data in either memory layer.',
    'Keep both layers concise Markdown bullets. Briefly confirm long-term memory changes to the user; daily note updates do not need confirmation unless relevant.',
    '',
    '## Long-term memory',
    memory || '(No saved long-term memories yet.)',
  ].join('\n');
}

export function memorySystemPromptExtension(pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: appendMemoryToSystemPrompt(event.systemPrompt),
  }));
}

function appendActiveModelToSystemPrompt(systemPrompt: string): string {
  return [
    systemPrompt,
    '',
    '## Active chat settings',
    `The bot stores its active chat model and reasoning level in ${BOT_SETTINGS_PATH}.`,
    'The model is stored as defaultProvider plus defaultModel; reasoning is stored as defaultThinkingLevel.',
    'The scheduled heartbeat runs only when that file sets "heartbeat": true and HEARTBEAT_MODEL is set in .env; scheduled tasks run only when it sets "cronJobs": true. Cron jobs and scheduled tasks are the same feature; the terms are interchangeable. Both settings default to off and are read at startup, so changing either requires a restart to take effect. A heartbeat switched on without its model is a startup error, so the bot will not run in that state.',
    'When "cronJobs" is false the scheduled-task tools are not registered at all, so tell the user to enable that setting and restart rather than claiming a schedule was created.',
    'The heartbeat model is HEARTBEAT_MODEL in .env and cannot be changed from Telegram. A scheduled task is pinned to the chat model active when it is created; later /models switches do not change existing tasks. A task can instead be given a specific model through the model parameter of create_schedule_task or update_scheduled_task, and passing "default" to update_scheduled_task re-pins it to the current chat model.',
    'Sub-agent tools (subagent_run and friends) are registered only when ENABLE_SUBAGENTS=true in .env, read at startup. When they are absent, tell the user to enable that variable and restart rather than claiming to have delegated work.',
    'When the Telegram user changes chat models with /models or reasoning with /reasoning, the bot updates this bot-specific settings file.',
    'These settings are isolated from ~/.pi/agent/settings.json.',
  ].join('\n');
}

export function activeModelSystemPromptExtension(pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: appendActiveModelToSystemPrompt(event.systemPrompt),
  }));
}
