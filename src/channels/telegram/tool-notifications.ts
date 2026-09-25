import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { DAILY_MEMORY_DIR, MEMORY_PATH } from '../../config.ts';
import { formatFirstToolArgument } from '../../tool-call-description.ts';
import { localDateString } from '../../util.ts';
import { escapeTelegramHtml } from './telegram-html.ts';

/**
 * Formats Pi tool-execution events into short Telegram HTML notifications,
 * with special labels for memory file access.
 */

type ToolExecutionStartEvent = Extract<AgentSessionEvent, { type: 'tool_execution_start' }>;

const MAX_TOOL_NOTIFICATION_DISPLAY_CHARS = 34;

/**
 * Renders one prompt's tool calls as a single collapsed message: a one-line
 * header Telegram shows while the quote is folded, then the calls themselves
 * inside an expandable blockquote. Each line's leading icon is dropped — the
 * header already carries one, and in a folded list the text says what the icon
 * would. `hidden` counts lines left out for size and is reported, not shown.
 */
export function renderCollapsedToolCalls(lines: string[], hidden = 0): string {
  const total = lines.length + hidden;
  const header =
    `🛠 <b>${total} tool ${total === 1 ? 'call' : 'calls'}</b>` +
    (hidden > 0 ? ` <i>(${hidden} not shown)</i>` : '');
  if (lines.length === 0) return header;

  const body = lines.map(stripLeadingIcon).join('\n');
  return `${header}\n<blockquote expandable>${body}</blockquote>`;
}

const LEADING_ICON_RE = /^\p{Extended_Pictographic}\uFE0F?\s+/u;

function stripLeadingIcon(line: string): string {
  return line.replace(LEADING_ICON_RE, '');
}

export function formatToolStartNotification(event: ToolExecutionStartEvent, cwd: string): string {
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

  return appendFirstArgument(`🛠 ${escapeTelegramHtml(event.toolName)}`);
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
