export interface Attachment {
  type: 'image' | 'file';
  path: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

export interface IncomingPrompt {
  chatId: string;
  text: string;
  attachments: Attachment[];
  source?: 'web' | 'heartbeat' | 'cron' | 'subagent-report' | 'background-bash-report';
  suppressNoop?: boolean;
}

export interface PiPromptResult {
  text: string;
  toolOutput: string;
}

export interface TranscriptionResult {
  ok: boolean;
  text?: string;
  error?: string;
}
