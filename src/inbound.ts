import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TELEGRAM_DOWNLOAD_LIMIT,
  TELEGRAM_FILE_API,
  TELEGRAM_MEDIA_TIMEOUT_MS,
  TMP_DIR,
  isAllowedTelegramChat,
} from './config.ts';
import { transcribeAudio } from './speech.ts';
import { sendChatAction, telegram } from './telegram.ts';
import type { IncomingPrompt, TelegramMessage } from './types.ts';
import { errorMessage } from './util.ts';

/**
 * Ingestion epoch. Media ingestion (downloads, transcription) runs detached
 * from the polling loop, so /abort and /new bump the epoch to drop ingestion
 * results that finish after the user cancelled. Only ingestTelegramMessage
 * compares epochs, so the counter stays private to this module.
 */
let epoch = 0;

export function discardPendingIngestion(): void {
  epoch++;
}

/**
 * Ingests one Telegram message detached from the polling loop, since media
 * downloads and audio transcription can take minutes. If /abort or /new bumps
 * the ingestion epoch while this is in flight, the result is dropped.
 */
export async function ingestTelegramMessage(
  message: TelegramMessage,
  handleIncoming: (prompt: IncomingPrompt) => Promise<void>,
): Promise<void> {
  const startEpoch = epoch;

  try {
    const incoming = await toIncomingPrompt(message);
    if (!incoming) return;

    if (epoch !== startEpoch) {
      console.log('dropping message ingested before /abort or /new');
      cleanupAttachments(incoming);
      return;
    }

    await handleIncoming(incoming);
  } catch (error) {
    console.error('failed to ingest Telegram message:', errorMessage(error));
  }
}

/**
 * Best-effort removal of the temp downloads this module created for a prompt.
 * Only paths under TMP_DIR are touched, so an attachment pointing at a real file
 * elsewhere is never deleted.
 */
export function cleanupAttachments(prompt: IncomingPrompt): void {
  for (const attachment of prompt.attachments) {
    if (attachment.path?.startsWith(TMP_DIR)) {
      deleteLocalFile(attachment.path);
    }
  }
}

/** Converts one Telegram message into a prompt, downloading media as needed. */
async function toIncomingPrompt(message: TelegramMessage): Promise<IncomingPrompt | null> {
  if (!isAllowedTelegramChat(String(message.chat.id))) return null;

  const caption = message.caption?.trim() ?? '';

  if (message.text) {
    return { text: message.text, attachments: [] };
  }

  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1];
    const downloaded = await downloadTelegramFile(largest.file_id, 'photo.jpg', largest.file_size);
    if (!downloaded) {
      return {
        text: '⚠️ I could not download that photo.',
        attachments: [],
      };
    }
    return {
      text: caption || 'Describe this image.',
      attachments: [
        {
          type: 'image',
          path: downloaded.localPath,
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: downloaded.size,
        },
      ],
    };
  }

  const file = message.document ?? message.voice ?? message.audio ?? message.video;
  if (file) {
    const filename = getTelegramFilename(message, file);
    const mimeType = 'mime_type' in file ? file.mime_type : undefined;
    const downloaded = await downloadTelegramFile(file.file_id, filename, file.file_size);
    if (!downloaded) {
      return {
        text: `⚠️ I could not download ${filename}.`,
        attachments: [],
      };
    }

    if (isTranscribableAudio(message, mimeType, filename)) {
      void sendChatAction();
      const transcription = await transcribeAudio(downloaded.localPath, mimeType, filename);
      if (transcription.ok && transcription.text) {
        deleteLocalFile(downloaded.localPath);
        const label = message.voice ? '🎤 Voice message' : `🎵 Audio: ${filename}`;
        const prefix = caption ? `${caption}\n\n` : '';
        return {
          text: `${prefix}${label}: ${transcription.text}`,
          attachments: [],
        };
      }

      const reason = transcription.error
        ? ` Transcription failed: ${transcription.error}`
        : ' Transcription is not configured.';
      return {
        text: `${caption || `Audio file uploaded: ${filename}.`}${reason}\nLocal file path: ${downloaded.localPath}`,
        attachments: [
          {
            type: 'file',
            path: downloaded.localPath,
            filename,
            mimeType,
            size: downloaded.size,
          },
        ],
      };
    }

    return {
      text:
        caption ||
        `A file was uploaded: ${filename}. Use the attached local path if you need to inspect it.`,
      attachments: [
        {
          type: 'file',
          path: downloaded.localPath,
          filename,
          mimeType,
          size: downloaded.size,
        },
      ],
    };
  }

  return null;
}

function getTelegramFilename(
  message: TelegramMessage,
  file: NonNullable<
    | TelegramMessage['document']
    | TelegramMessage['voice']
    | TelegramMessage['audio']
    | TelegramMessage['video']
  >,
): string {
  if ('file_name' in file && file.file_name) return file.file_name;
  if ('title' in file && file.title) return `${file.title}.mp3`;
  if (message.voice) return 'voice.ogg';
  if (message.video) return 'video.mp4';
  return 'file';
}

function isTranscribableAudio(
  message: TelegramMessage,
  mimeType: string | undefined,
  filename: string,
): boolean {
  if (message.voice || message.audio) return true;
  if (mimeType?.startsWith('audio/')) return true;
  const ext = path.extname(filename).toLowerCase();
  return ['.mp3', '.m4a', '.ogg', '.oga', '.wav', '.webm', '.flac', '.aac'].includes(ext);
}

function deleteLocalFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

async function downloadTelegramFile(
  fileId: string,
  suggestedName: string,
  knownSize = 0,
): Promise<{ localPath: string; size: number } | null> {
  if (knownSize > TELEGRAM_DOWNLOAD_LIMIT) return null;

  try {
    const info = await telegram<{
      ok: boolean;
      result?: { file_path?: string; file_size?: number };
    }>(`getFile?file_id=${encodeURIComponent(fileId)}`);
    if (!info.ok || !info.result?.file_path) return null;
    if ((info.result.file_size ?? 0) > TELEGRAM_DOWNLOAD_LIMIT) return null;

    const res = await fetch(`${TELEGRAM_FILE_API}/${info.result.file_path}`, {
      signal: AbortSignal.timeout(TELEGRAM_MEDIA_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > TELEGRAM_DOWNLOAD_LIMIT) return null;

    const ext = path.extname(info.result.file_path) || path.extname(suggestedName) || '';
    const safeBase =
      path.basename(suggestedName, path.extname(suggestedName)).replace(/[^a-zA-Z0-9._-]/g, '_') ||
      'file';
    const localPath = path.join(TMP_DIR, `${Date.now()}-${safeBase}${ext}`);
    fs.writeFileSync(localPath, buffer);
    return { localPath, size: buffer.length };
  } catch (error) {
    console.error(`Failed to download Telegram file ${fileId}:`, errorMessage(error));
    return null;
  }
}
