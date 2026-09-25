import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ALLOWED_CHAT_ID,
  TELEGRAM_DOCUMENT_UPLOAD_LIMIT,
  TELEGRAM_MEDIA_TIMEOUT_MS,
  TELEGRAM_PHOTO_UPLOAD_LIMIT,
  TELEGRAM_VOICE_UPLOAD_LIMIT,
} from '../../config.ts';
import { telegram } from './telegram.ts';
import { escapeTelegramHtml } from './telegram-html.ts';

/**
 * Multipart uploads of the files the agent sends: photos, documents and voice
 * notes, within Telegram's own size limits. An image too large for a photo
 * goes as a document.
 */

export interface UploadOptions {
  caption?: string;
  silent?: boolean;
}

export async function sendTelegramImage(
  filePath: string,
  options: UploadOptions = {},
): Promise<void> {
  const size = fileSize(filePath, TELEGRAM_DOCUMENT_UPLOAD_LIMIT);
  const asPhoto = size <= TELEGRAM_PHOTO_UPLOAD_LIMIT;
  await upload(
    asPhoto ? 'sendPhoto' : 'sendDocument',
    asPhoto ? 'photo' : 'document',
    filePath,
    imageMimeType(filePath),
    options,
  );
}

export async function sendTelegramDocument(
  filePath: string,
  options: UploadOptions = {},
): Promise<void> {
  fileSize(filePath, TELEGRAM_DOCUMENT_UPLOAD_LIMIT);
  await upload('sendDocument', 'document', filePath, undefined, options);
}

export async function sendTelegramVoice(
  filePath: string,
  options: UploadOptions = {},
): Promise<void> {
  fileSize(filePath, TELEGRAM_VOICE_UPLOAD_LIMIT);
  await upload('sendVoice', 'voice', filePath, 'audio/ogg', options, 'pi-reply.ogg');
}

function fileSize(filePath: string, limit: number): number {
  const { size } = fs.statSync(filePath);
  if (size > limit) {
    throw new Error(`File exceeds Telegram upload limit (${(size / 1024 / 1024).toFixed(1)}MB).`);
  }
  return size;
}

async function upload(
  method: string,
  field: string,
  filePath: string,
  mimeType: string | undefined,
  options: UploadOptions,
  filename = path.basename(filePath),
): Promise<void> {
  const form = new FormData();
  form.append('chat_id', ALLOWED_CHAT_ID);
  form.append(
    field,
    new Blob([fs.readFileSync(filePath)], mimeType ? { type: mimeType } : {}),
    filename,
  );
  if (options.caption) {
    form.append('caption', escapeTelegramHtml(options.caption));
    form.append('parse_mode', 'HTML');
  }
  if (options.silent) form.append('disable_notification', 'true');
  await telegram(method, { method: 'POST', body: form }, TELEGRAM_MEDIA_TIMEOUT_MS);
}

function imageMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}
