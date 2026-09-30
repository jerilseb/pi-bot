import * as fs from 'node:fs';
import * as path from 'node:path';
import { deleteLocalFile } from '../../attachments.ts';
import {
  TELEGRAM_DOWNLOAD_LIMIT,
  TELEGRAM_FILE_API,
  TELEGRAM_MEDIA_TIMEOUT_MS,
  TMP_DIR,
  isAllowedTelegramChat,
  showTranscriptsEnabled,
} from '../../config.ts';
import { transcribeAudio } from '../../speech.ts';
import type { Attachment } from '../../types.ts';
import { errorMessage } from '../../util.ts';
import {
  replaceTelegramMessage,
  sendChatAction,
  sendTelegramHtmlMessage,
  sendTelegramMessage,
  telegram,
} from './telegram.ts';
import { escapeTelegramHtml } from './telegram-html.ts';
import type { TelegramMessage } from './types.ts';

/** A Telegram message as text plus local files, ready to submit. */
export interface TelegramInput {
  text: string;
  attachments: Attachment[];
}

/**
 * Ingests one Telegram message detached from the polling loop, since media
 * downloads and audio transcription can take minutes. The caller takes an
 * ingestion ticket first, so a message the user cancelled with /abort or /new
 * while it was downloading is turned away when it is submitted.
 */
export async function ingestTelegramMessage(
  message: TelegramMessage,
  submit: (input: TelegramInput) => Promise<void>,
): Promise<void> {
  try {
    const incoming = await toTelegramInput(message);
    if (!incoming) return;
    await submit(incoming);
  } catch (error) {
    console.error('failed to ingest Telegram message:', errorMessage(error));
  }
}

/** Converts one Telegram message into input, downloading media as needed. */
async function toTelegramInput(message: TelegramMessage): Promise<TelegramInput | null> {
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
    if (isTranscribableAudio(message, mimeType, filename)) {
      return toTranscribedInput(message, file, filename, mimeType, caption);
    }

    const downloaded = await downloadTelegramFile(file.file_id, filename, file.file_size);
    if (!downloaded) {
      return {
        text: `⚠️ I could not download ${filename}.`,
        attachments: [],
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

/**
 * A voice note or audio file, downloaded and turned into text. With transcripts
 * shown, a "🎤 …" message goes up before the download and becomes the
 * transcript once there is one, or says why there is none.
 */
async function toTranscribedInput(
  message: TelegramMessage,
  file: { file_id: string; file_size?: number },
  filename: string,
  mimeType: string | undefined,
  caption: string,
): Promise<TelegramInput> {
  const status = showTranscriptsEnabled() ? await showTranscribing() : null;
  void sendChatAction();

  const downloaded = await downloadTelegramFile(file.file_id, filename, file.file_size);
  if (!downloaded) {
    await status?.replace(`⚠️ <i>Could not download ${escapeTelegramHtml(filename)}.</i>`);
    return {
      text: `⚠️ I could not download ${filename}.`,
      attachments: [],
    };
  }

  const transcription = await transcribeAudio(downloaded.localPath, mimeType, filename);
  if (transcription.ok && transcription.text) {
    deleteLocalFile(downloaded.localPath);
    await status?.replace(`🎤 <i>${escapeTelegramHtml(transcription.text)}</i>`);
    const label = message.voice ? '🎤 Voice message' : `🎵 Audio: ${filename}`;
    const prefix = caption ? `${caption}\n\n` : '';
    return {
      text: `${prefix}${label}: ${transcription.text}`,
      attachments: [],
    };
  }

  await status?.replace(
    transcription.error
      ? '🎤 ⚠️ <i>Transcription failed.</i>'
      : '🎤 ⚠️ <i>Transcription is not configured.</i>',
  );
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

/**
 * Puts up the "🎤 …" message, to be replaced once transcription ends. When it
 * could not be sent, the replacement is sent as a new message instead. Showing
 * any of this is best-effort: a Telegram error must not lose the voice note
 * itself.
 */
async function showTranscribing(): Promise<{ replace(html: string): Promise<void> }> {
  let messageId: number | null = null;
  try {
    messageId = await sendTelegramHtmlMessage('🎤 …');
  } catch (error) {
    console.error('failed to show the transcribing message:', errorMessage(error));
  }
  return {
    async replace(html) {
      try {
        if (messageId === null) await sendTelegramMessage(html);
        else await replaceTelegramMessage(messageId, html);
      } catch (error) {
        console.error('failed to show the transcript:', errorMessage(error));
      }
    },
  };
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
