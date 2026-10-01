import * as fs from 'node:fs';
import { TMP_DIR } from './config.ts';
import type { IncomingPrompt } from './types.ts';

/**
 * Best-effort removal of the temp downloads behind a prompt's attachments. The
 * core owns what a channel submits, so it calls this once a prompt is done or
 * turned away. Only attachments the channel marked temporary are touched, and
 * only under TMP_DIR: the bot's own files there, such as an image it sent that
 * a terminal then pasted, are not downloads and stay.
 */
export function cleanupAttachments(prompt: Pick<IncomingPrompt, 'attachments'>): void {
  for (const attachment of prompt.attachments) {
    if (attachment.temporary && attachment.path.startsWith(TMP_DIR)) {
      deleteLocalFile(attachment.path);
    }
  }
}

export function deleteLocalFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}
