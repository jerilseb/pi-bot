import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { FILES_DIR, POST_RESTART_TASKS_PATH } from './config.ts';

export interface PostRestartTask {
  id: string;
  chatId: string;
  prompt: string;
  title?: string;
  createdAt: string;
}

export interface CreatePostRestartTaskInput {
  chatId: string;
  prompt: string;
  title?: string;
}

export function ensurePostRestartTasksFile(): void {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  if (!fs.existsSync(POST_RESTART_TASKS_PATH)) {
    writePostRestartTasksFile([]);
  }
}

export function readPostRestartTasks(): PostRestartTask[] {
  ensurePostRestartTasksFile();
  const content = fs.readFileSync(POST_RESTART_TASKS_PATH, 'utf8').trim();
  if (!content) return [];

  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${POST_RESTART_TASKS_PATH} must contain a JSON array`);
  }

  return parsed.map(normalizePostRestartTask);
}

export function addPostRestartTask(input: CreatePostRestartTaskInput): PostRestartTask {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('after_restart_prompt must not be empty');

  const task: PostRestartTask = {
    id: `post_restart_${crypto.randomUUID()}`,
    chatId: input.chatId.trim(),
    prompt,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    createdAt: new Date().toISOString(),
  };

  const tasks = readPostRestartTasks();
  tasks.push(task);
  writePostRestartTasksFile(tasks);
  return task;
}

export function consumePostRestartTasks(): PostRestartTask[] {
  const tasks = readPostRestartTasks();
  if (tasks.length > 0) writePostRestartTasksFile([]);
  return tasks;
}

export function formatPostRestartTask(task: PostRestartTask): string {
  return `${task.id}${task.title ? ` — ${task.title}` : ''}`;
}

function writePostRestartTasksFile(tasks: PostRestartTask[]): void {
  fs.writeFileSync(POST_RESTART_TASKS_PATH, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
}

function normalizePostRestartTask(value: unknown): PostRestartTask {
  if (!value || typeof value !== 'object') {
    throw new Error('Post-restart task entries must be objects');
  }

  const record = value as Partial<PostRestartTask>;
  if (!record.id || typeof record.id !== 'string') {
    throw new Error('Post-restart task requires string id');
  }
  if (!record.chatId || typeof record.chatId !== 'string') {
    throw new Error(`Post-restart task ${record.id} requires string chatId`);
  }
  if (!record.prompt || typeof record.prompt !== 'string') {
    throw new Error(`Post-restart task ${record.id} requires prompt`);
  }

  return {
    id: record.id,
    chatId: record.chatId,
    prompt: record.prompt,
    ...(record.title ? { title: String(record.title) } : {}),
    createdAt: record.createdAt
      ? requireValidDate(record.createdAt, 'createdAt').toISOString()
      : new Date().toISOString(),
  };
}

function requireValidDate(value: unknown, label: string): Date {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO date string`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid ISO date string`);
  return date;
}
