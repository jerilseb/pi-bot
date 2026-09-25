import type { PromptOrigin } from './contract.ts';

export interface Attachment {
  type: 'image' | 'file';
  path: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

/**
 * The bot's two Pi sessions: the Telegram chat and the unattended background
 * one, which starts a fresh transcript for every run.
 */
export type SessionKind = 'chat' | 'background';

/**
 * Completion reports from background work the agent started earlier. They are
 * the tail of a turn already under way, so the queue admits them even when full.
 */
export type JobReportSource = 'background-bash-report' | 'subagent-report';

export interface IncomingPrompt {
  text: string;
  attachments: Attachment[];
  /**
   * Where the prompt came from. Only user input may steer an active chat run;
   * every internal origin is queued so two of them cannot merge.
   */
  origin: PromptOrigin;
  /**
   * Session that runs this prompt. Unset, it follows from origin: heartbeat and
   * cron run in the background session, everything else in the chat session. A
   * job report sets it so the result returns to the session that started the
   * work rather than always landing in the chat.
   */
  session?: SessionKind;
  /**
   * Transcript a background-session prompt continues instead of starting fresh.
   * Every background run gets a new transcript; a job report sets this so the
   * result returns to the run that started the job.
   */
  resumeSessionFile?: string;
  suppressNoop?: boolean;
  /**
   * Checked when the prompt reaches the front of its queue, not when it is
   * queued; true drops it without a run. A completion report sets it so a result
   * the agent read while the report waited is not delivered a second time.
   */
  isSuperseded?: () => boolean;
  /**
   * Model to run this prompt on, as provider/model. Set by heartbeat and cron so
   * each background run uses its own model regardless of what ran before it;
   * user input leaves it unset and uses the chat's current model.
   */
  model?: string;
  /**
   * Short human-readable name for an internal run, e.g. a scheduled task's
   * title. Used when its delivered output is noted in the chat session.
   */
  label?: string;
}

export interface PiPromptResult {
  /** Every assistant message of the run, a blank line apart; empty when it said nothing. */
  text: string;
  /**
   * The last assistant message on its own, for sentinel checks: a run that
   * narrates and then answers with a sentinel still has nothing to report.
   * runPrompt always sets it; without it, checks fall back to `text`.
   */
  finalText?: string;
}

export interface TranscriptionResult {
  ok: boolean;
  text?: string;
  error?: string;
}
