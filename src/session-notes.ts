import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { IncomingPrompt } from './types.ts';

/**
 * Notes about the bot itself, written straight into the Pi session file.
 *
 * Slash commands, restarts and model switches are handled entirely by this
 * process, so Pi never sees them: the session resumes mid-thought with no hint
 * that the process died, the model changed, or the last turn was cut off.
 *
 * `appendCustomMessageEntry` is built for exactly this — unlike a plain custom
 * entry it participates in LLM context, so the note is part of the conversation
 * on the next turn without costing a turn of its own. It also means the session
 * file stays the single record: the transcript explains its own gaps, and
 * anything reading the file later (the session explorer, a future resume) sees
 * the same history Pi does.
 *
 * Only record what changes Pi's picture of the world. Every note is context it
 * pays for on every subsequent turn, so `/status` and `/help` stay out.
 *
 * Messages sent from the background session count: scheduled tasks, heartbeat
 * runs, and the completion reports of commands those started all run there, so
 * without a note the chat agent has no idea the user was just sent one and
 * cannot answer "what did this morning's report say?".
 */

/** Marks our entries in the session file so they can be found on reload. */
export const SESSION_EVENT_TYPE = 'telegram-bot-event';

export type SessionEventKind =
  | 'restart'
  | 'restart-unclean'
  | 'model'
  | 'abort'
  | 'scheduled-task'
  | 'heartbeat'
  | 'background-bash';

export interface SessionEventDetails {
  kind: SessionEventKind;
}

/**
 * Append a note as a child of the session's current leaf.
 *
 * `display: true` so it renders as its own thing rather than masquerading as
 * something the user typed.
 */
export function appendSessionEvent(
  manager: SessionManager,
  kind: SessionEventKind,
  text: string,
): void {
  const details: SessionEventDetails = { kind };
  manager.appendCustomMessageEntry(SESSION_EVENT_TYPE, formatSessionEvent(text), true, details);
}

/** The wording Pi reads. Tagged so it cannot be mistaken for user input. */
export function formatSessionEvent(text: string): string {
  return [
    '<bot-event>',
    'Automatic note about this bot, not user input:',
    text,
    '</bot-event>',
  ].join('\n');
}

/**
 * The note recorded in the chat session when a background-session run sends
 * the user a message. Quotes the message so the chat agent can refer back to
 * it. Null for sources that run in the chat session, which needs no note about
 * its own replies.
 */
export function backgroundReportNote(options: {
  source: IncomingPrompt['source'];
  label?: string;
  model?: string;
  report: string;
}): { kind: SessionEventKind; text: string } | null {
  const label = options.label?.trim() ? ` "${options.label.trim()}"` : '';
  const model = options.model ? ` on ${options.model}` : '';
  let kind: SessionEventKind;
  let intro: string;
  switch (options.source) {
    case 'cron':
      kind = 'scheduled-task';
      intro = `A scheduled task${label} ran${model} in a separate background session and sent this report to the user:`;
      break;
    case 'heartbeat':
      kind = 'heartbeat';
      intro = `A heartbeat run${model} in a separate background session sent this message to the user:`;
      break;
    case 'background-bash-report':
      kind = 'background-bash';
      intro = `A background command${label} started from the separate background session finished, and that session${model} sent this message to the user:`;
      break;
    default:
      return null;
  }
  return {
    kind,
    text: [intro, '<background_report>', options.report.trim(), '</background_report>'].join('\n'),
  };
}

/**
 * The kind of the most recent note, or null if the session's last word was
 * anything else.
 *
 * This is how an unclean shutdown is detected: a deliberate restart appends its
 * note on the way out, so finding one here means the process left on purpose.
 * Finding anything else means it crashed or was stopped — and the session file
 * is the only place that memory could have survived.
 */
export function lastSessionEventKind(manager: SessionManager): SessionEventKind | null {
  const entries = manager.getEntries();
  const last = entries.at(-1);
  if (!last || last.type !== 'custom_message' || last.customType !== SESSION_EVENT_TYPE) {
    return null;
  }
  const details = last.details as Partial<SessionEventDetails> | undefined;
  return details?.kind ?? null;
}
