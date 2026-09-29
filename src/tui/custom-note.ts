import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { type Component, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import {
  SESSION_EVENT_TYPE,
  type SessionEventDetails,
  type SessionEventKind,
} from '../session-notes.ts';
import { dim } from './style.ts';

type CustomMessage = Extract<AgentMessage, { role: 'custom' }>;

/**
 * A custom message the transcript shows, most often a note the bot wrote about
 * itself (a restart, a model change, a report the background session sent),
 * drawn as the divider /new draws, `── Bot restarted ──`, named for the user
 * rather than in the words the model reads. /expand adds those words under it,
 * without the envelope. Another kind of message is named by its type.
 */
export class CustomNote implements Component {
  private readonly title: string;
  private readonly text: string;
  private expanded = false;
  private cache: { width: number; lines: string[] } | null = null;

  constructor(message: CustomMessage) {
    this.text = noteText(message);
    this.title =
      message.customType === SESSION_EVENT_TYPE
        ? eventTitle(message.details as Partial<SessionEventDetails> | undefined, this.text)
        : message.customType;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.invalidate();
  }

  invalidate(): void {
    this.cache = null;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const room = Math.max(1, width - 2);
    const lines = [` ${dim(truncateToWidth(`── ${this.title} ──`, room, '…'))}`];
    if (this.expanded) {
      for (const line of this.text.split('\n')) {
        lines.push(
          ...wrapTextWithAnsi(line, Math.max(1, room - 3)).map((row) => `    ${dim(row)}`),
        );
      }
    }
    this.cache = { width, lines };
    return lines;
  }
}

/** What happened, in a few words, for each kind of note the bot writes. */
const EVENT_TITLES: Record<SessionEventKind, (text: string) => string> = {
  restart: () => 'Bot restarted',
  'restart-unclean': () => 'Bot restarted after it crashed or was stopped',
  model: (text) => {
    const next = / to (\S+)\.$/.exec(text.split('\n', 1)[0] ?? '')?.[1];
    return next ? `Model changed to ${next}` : 'Model changed';
  },
  abort: () => 'Turn aborted',
  'scheduled-task': (text) => `Scheduled task${label(text)} sent a report`,
  heartbeat: () => 'Heartbeat sent a message',
  'background-bash': (text) => `Background command${label(text)} reported`,
  subagent: (text) => `Sub-agent job${label(text)} reported`,
};

function eventTitle(details: Partial<SessionEventDetails> | undefined, text: string): string {
  const kind = details?.kind;
  if (kind && kind in EVENT_TITLES) return EVENT_TITLES[kind](text);
  return /^[^\n]*?[.:](?=\s|$)/.exec(text)?.[0].replace(/[.:]$/, '') ?? 'Note';
}

/** The quoted name a report's note gives its task, command or job, with its leading space. */
function label(text: string): string {
  return /^A [a-z -]+?( "[^"\n]*")? (?:ran|started)\b/.exec(text)?.[1] ?? '';
}

function noteText(message: CustomMessage): string {
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
  if (message.customType !== SESSION_EVENT_TYPE) return text.trim();
  return text
    .replace(/^\s*<bot-event>\n(?:Automatic note about this bot, not user input:\n)?/, '')
    .replace(/\n<\/bot-event>\s*$/, '')
    .trim();
}
