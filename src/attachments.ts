import * as fs from 'node:fs';
import { TMP_DIR } from './config.ts';
import type { IncomingPrompt } from './types.ts';

/**
 * Best-effort removal of the temp downloads behind a prompt's attachments. The
 * core owns what a channel submits, so it calls this once a prompt is done or
 * turned away. Only paths under TMP_DIR are touched, so an attachment pointing
 * at a real file elsewhere is never deleted.
 */
export function cleanupAttachments(prompt: Pick<IncomingPrompt, 'attachments'>): void {
  for (const attachment of prompt.attachments) {
    if (attachment.path?.startsWith(TMP_DIR)) {
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
