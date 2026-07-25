import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { DAILY_MEMORY_DIR, MEMORY_PATH } from './config.ts';
import { escapeTelegramHtml } from './telegram.ts';
import { localDateString } from './util.ts';

/**
 * Formats Pi tool-execution events into short Telegram HTML notifications,
 * with special labels for memory file access and skill reads.
 */

type ToolExecutionStartEvent = Extract<AgentSessionEvent, { type: 'tool_execution_start' }>;

const MAX_TOOL_NOTIFICATION_DISPLAY_CHARS = 34;

export function formatToolStartNotification(
  event: ToolExecutionStartEvent,
  session: AgentSession,
  cwd: string,
): string {
  const firstArgument = formatFirstToolArgument(event.args);
  const appendFirstArgument = (label: string) => {
    if (!firstArgument) return label;

    const maxArgumentChars = Math.max(
      8,
      MAX_TOOL_NOTIFICATION_DISPLAY_CHARS - visibleTextLength(label) - 3,
    );
    return `${label} (<code>${escapeTelegramHtml(
      truncateToolArgument(firstArgument, maxArgumentChars),
    )}</code>)`;
  };

  const memoryUpdateKind = getMemoryUpdateKind(event, cwd);
  if (memoryUpdateKind === 'long-term') {
    return appendFirstArgument('🧠 memory updated');
  }
  if (memoryUpdateKind === 'daily') {
    return appendFirstArgument('🧠 daily memory updated');
  }

  const dailyMemoryReadLabel = getDailyMemoryReadLabel(event, cwd);
  if (dailyMemoryReadLabel) {
    return `🧠 read daily memory (<code>${escapeTelegramHtml(dailyMemoryReadLabel)}</code>)`;
  }

  const skillName = skillNameForReadTool(event, session, cwd);
  return appendFirstArgument(
    skillName ? `📗 ${escapeTelegramHtml(skillName)}` : `🛠 ${escapeTelegramHtml(event.toolName)}`,
  );
}

function formatFirstToolArgument(args: unknown): string | null {
  const firstArgument = extractFirstToolArgument(args);
  if (!firstArgument) return null;

  return formatToolArgumentValue(firstArgument.value);
}

function extractFirstToolArgument(args: unknown): { name?: string; value: unknown } | null {
  if (args === null || args === undefined) return null;
  if (Array.isArray(args)) {
    return args.length > 0 ? { value: args[0] } : null;
  }
  if (typeof args !== 'object') return { value: args };

  const [firstEntry] = Object.entries(args as Record<string, unknown>);
  if (!firstEntry) return null;

  const [name, value] = firstEntry;
  return { name, value };
}

function formatToolArgumentValue(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value.trim() ? value : JSON.stringify(value);
  } else if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'undefined'
  ) {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  const compacted = text.replace(/\s+/g, ' ').trim();
  return abbreviateHomePath(compacted || text);
}

function abbreviateHomePath(value: string): string {
  const homeDir = os.homedir();
  if (!homeDir) return value;

  const normalizedHomeDir = path.normalize(homeDir);
  const escapedHomeDir = normalizedHomeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`${escapedHomeDir}(?=$|/)`, 'g'), '~');
}

function truncateToolArgument(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  if (maxChars === 1) return '…';
  return `${value.slice(0, maxChars - 1)}…`;
}

function visibleTextLength(value: string): number {
  return value.replace(/<[^>]*>/g, '').length;
}

function getMemoryUpdateKind(
  event: ToolExecutionStartEvent,
  cwd: string,
): 'long-term' | 'daily' | null {
  if (event.toolName !== 'edit' && event.toolName !== 'write') return null;

  const editPath = extractToolPath(event.args);
  if (!editPath) return null;

  const normalizedEditPath = normalizeFilePath(editPath, cwd);
  if (normalizedEditPath === normalizeFilePath(MEMORY_PATH, cwd)) {
    return 'long-term';
  }
  if (isPathInside(normalizedEditPath, normalizeFilePath(DAILY_MEMORY_DIR, cwd))) {
    return 'daily';
  }
  return null;
}

function getDailyMemoryReadLabel(event: ToolExecutionStartEvent, cwd: string): string | null {
  if (event.toolName !== 'read') return null;

  const readPath = extractToolPath(event.args);
  if (!readPath) return null;

  const normalizedReadPath = normalizeFilePath(readPath, cwd);
  if (!isPathInside(normalizedReadPath, normalizeFilePath(DAILY_MEMORY_DIR, cwd))) {
    return null;
  }

  const date = dailyMemoryDateFromPath(normalizedReadPath);
  if (!date) return 'unknown day';

  const today = localDateString(new Date());
  if (date === today) return 'today';

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date === localDateString(yesterday)) return 'yesterday';

  return date;
}

function dailyMemoryDateFromPath(filePath: string): string | null {
  return path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2})\.md$/)?.[1] ?? null;
}

function skillNameForReadTool(
  event: ToolExecutionStartEvent,
  session: AgentSession,
  cwd: string,
): string | null {
  if (event.toolName !== 'read') return null;

  const readPath = extractToolPath(event.args);
  if (!readPath) return null;

  const normalizedReadPath = normalizeFilePath(readPath, cwd);
  const skill = session.resourceLoader
    .getSkills()
    .skills.find((skill) => normalizeFilePath(skill.filePath, cwd) === normalizedReadPath);

  return skill?.name ?? null;
}

function extractToolPath(args: unknown): string | null {
  if (!args || typeof args !== 'object' || !('path' in args)) return null;
  return typeof args.path === 'string' ? args.path : null;
}

function normalizeFilePath(filePath: string, cwd: string): string {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    return path.normalize(absolutePath);
  }
}

function isPathInside(filePath: string, directoryPath: string): boolean {
  const relativePath = path.relative(directoryPath, filePath);
  return Boolean(relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}
