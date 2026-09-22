export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string; first_name?: string };
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string; title?: string };
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{
    file_id: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  voice?: {
    file_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id: string;
    file_name?: string;
    title?: string;
    mime_type?: string;
    file_size?: number;
  };
  video?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
}

export interface Attachment {
  type: 'image' | 'file';
  path: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

/** The bot's two Pi sessions: the Telegram chat and the unattended background one. */
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
   * Where the prompt came from. Only `telegram` (or unset) may steer an active
   * chat run; every internal origin is queued so two of them cannot merge.
   */
  source?: 'telegram' | 'heartbeat' | 'cron' | 'post-restart' | JobReportSource;
  /**
   * Session that runs this prompt. Unset, it follows from source: heartbeat and
   * cron run in the background session, everything else in the chat session. A
   * job report sets it so the result returns to the session that started the
   * work rather than always landing in the chat.
   */
  session?: SessionKind;
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
   * Telegram prompts leave it unset and use the chat's current model.
   */
  model?: string;
  /**
   * Short human-readable name for an internal run, e.g. a scheduled task's
   * title. Used when its delivered output is noted in the chat session.
   */
  label?: string;
}

export interface PiPromptResult {
  text: string;
}

export interface TranscriptionResult {
  ok: boolean;
  text?: string;
  error?: string;
}
