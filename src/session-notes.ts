import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { PromptOrigin } from './contract.ts';

/**
 * Notes about the bot itself, recorded in the Pi session.
 *
 * Slash commands, restarts and model switches are handled entirely by this
 * process, so Pi never sees them: the session resumes mid-thought with no hint
 * that the process died, the model changed, or the last turn was cut off.
 *
 * A note is a custom message — unlike a plain custom entry it participates in
 * LLM context, so the note is part of the conversation on the next turn without
 * costing a turn of its own. It also means the session file stays the single
 * record: the transcript explains its own gaps, and anything reading the file
 * later (the session explorer, a future resume) sees the same history Pi does.
 * A live session takes the note through the SDK, which updates the running
 * agent's context as well as the file; see SdkPiSession.noteEvent.
 *
 * Only record what changes Pi's picture of the world. Every note is context it
 * pays for on every subsequent turn, so `/status` and `/help` stay out.
 *
 * Messages sent from background runs count: scheduled tasks and heartbeat runs
 * each run in a fresh session of their own, and the completion reports of jobs
 * they started resume that run's session, so the chat agent never sees any of
 * it. Without a note it has no idea the user was just sent one and cannot
 * answer "what did this morning's report say?".
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
  | 'background-bash'
  | 'subagent';

export interface SessionEventDetails {
  kind: SessionEventKind;
}

/**
 * A note as the custom message the SDK sends into a live session.
 *
 * `display: true` so it renders as its own thing rather than masquerading as
 * something the user typed.
 */
export function sessionEventMessage(
  kind: SessionEventKind,
  text: string,
): { customType: string; content: string; display: boolean; details: SessionEventDetails } {
  return {
    customType: SESSION_EVENT_TYPE,
    content: formatSessionEvent(text),
    display: true,
    details: { kind },
  };
}

/** Append a note straight to the file, as a child of the session's current leaf. */
export function appendSessionEvent(
  manager: SessionManager,
  kind: SessionEventKind,
  text: string,
): void {
  const { customType, content, display, details } = sessionEventMessage(kind, text);
  manager.appendCustomMessageEntry(customType, content, display, details);
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
 * it. Null for origins that run in the chat session, which needs no note about
 * its own replies.
 */
export function backgroundReportNote(options: {
  origin: PromptOrigin;
  label?: string;
  model?: string;
  report: string;
}): { kind: SessionEventKind; text: string } | null {
  const label = options.label?.trim() ? ` "${options.label.trim()}"` : '';
  const model = options.model ? ` on ${options.model}` : '';
  let kind: SessionEventKind;
  let intro: string;
  const { origin } = options;
  switch (origin.kind === 'job-report' ? origin.source : origin.kind) {
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
    case 'subagent-report':
      kind = 'subagent';
      intro = `A sub-agent job${label} started from the separate background session finished, and that session${model} sent this message to the user:`;
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

/**
 * Marks a transcript whose conversation was ended by /new or start_new_session.
 * A plain custom entry rather than a note: it is for the bot, not the model, so
 * it never enters the context.
 *
 * The replacement conversation lives only in memory until its first assistant
 * message, which is when the SDK first writes a session file, and the request to
 * start it lives only in memory too. A restart in between would otherwise resume
 * the conversation that was just ended, since it is still the newest file on
 * disk. The marker is what survives: a marked transcript is never resumed.
 */
export const CONVERSATION_CLEARED_TYPE = 'telegram-bot-conversation-cleared';

/** Appends the cleared marker, once. */
export function markConversationCleared(manager: SessionManager): void {
  if (isConversationCleared(manager)) return;
  manager.appendCustomEntry(CONVERSATION_CLEARED_TYPE, { clearedAt: new Date().toISOString() });
}

/** True when the transcript carries the cleared marker anywhere in its tree. */
export function isConversationCleared(manager: Pick<SessionManager, 'getEntries'>): boolean {
  return manager
    .getEntries()
    .some((entry) => entry.type === 'custom' && entry.customType === CONVERSATION_CLEARED_TYPE);
}
