import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  ALLOWED_CHAT_ID,
  DOCUMENT_UPLOAD_EXTS,
  LOCAL_DOCUMENT_UPLOAD_DIRS,
  LOCAL_IMAGE_UPLOAD_DIRS,
  TELEGRAM_DOCUMENT_UPLOAD_LIMIT,
  TELEGRAM_MEDIA_TIMEOUT_MS,
  TELEGRAM_PHOTO_UPLOAD_LIMIT,
} from './config.ts';
import { deliverToChat, heldDeliveryNote } from './background-outbox.ts';
import { escapeTelegramHtml } from './telegram-html.ts';
import { telegram } from './telegram.ts';
import type { SessionKind } from './types.ts';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const SendImageParams = Type.Object({
  path: Type.String({
    description:
      'Absolute path to a local image file (.png, .jpg, .jpeg, .webp, .gif). Tilde-prefixed paths are accepted. The file must reside under an allowed upload directory.',
  }),
  caption: Type.Optional(
    Type.String({
      description: 'Optional short caption shown beneath the image in Telegram.',
    }),
  ),
});

const SendDocumentParams = Type.Object({
  path: Type.String({
    description:
      'Absolute path to a local document file. Tilde-prefixed paths are accepted. The file must reside under an allowed upload directory and have a supported extension.',
  }),
  caption: Type.Optional(
    Type.String({
      description: 'Optional short caption shown beneath the document in Telegram.',
    }),
  ),
});

/** send_image for one of the bot's sessions; the background session's sends are held. */
export function telegramImageExtension(session: SessionKind): (pi: ExtensionAPI) => void {
  return (pi) => registerSendImage(pi, session);
}

function registerSendImage(pi: ExtensionAPI, session: SessionKind): void {
  pi.registerTool({
    name: 'send_image',
    label: 'Send Image',
    description:
      'Upload a local image file to the Telegram user. Use after generating or otherwise producing an image that the user should see.',
    promptSnippet: 'Send an image file to the Telegram user.',
    promptGuidelines: [
      'Call this only when the user should actually see the image — not when merely discussing or analyzing one.',
      'Pass an absolute path to a file that already exists on disk (e.g. a generated image).',
      'Provide a brief caption when extra context would help; omit it for an unannotated send.',
      'After sending, keep the accompanying text reply short — the image carries the content.',
    ],
    parameters: SendImageParams,
    async execute(_toolCallId, params) {
      const resolved = resolvePath(params.path);
      validateUpload(resolved, IMAGE_EXTS, LOCAL_IMAGE_UPLOAD_DIRS);
      const outcome = await deliverToChat(session, 'image', () =>
        uploadImage(resolved, params.caption),
      );
      return {
        content: [
          {
            type: 'text',
            text:
              outcome === 'held'
                ? heldDeliveryNote(`Image ${path.basename(resolved)}`)
                : `Sent image: ${path.basename(resolved)}`,
          },
        ],
        details: { path: resolved, caption: params.caption ?? null },
      };
    },
  });
}

/** send_document for one of the bot's sessions; the background session's sends are held. */
export function telegramDocumentExtension(session: SessionKind): (pi: ExtensionAPI) => void {
  return (pi) => registerSendDocument(pi, session);
}

function registerSendDocument(pi: ExtensionAPI, session: SessionKind): void {
  pi.registerTool({
    name: 'send_document',
    label: 'Send Document',
    description:
      'Upload a local document file (pdf, docx, csv, md, txt, etc.) to the Telegram user.',
    promptSnippet: 'Send a document file to the Telegram user.',
    promptGuidelines: [
      'Call this only when the user should actually receive the file — not when merely discussing or analyzing it.',
      'Pass an absolute path to a file that already exists on disk.',
      'Supported extensions are configured via DOCUMENT_UPLOAD_EXTS in src/config.ts.',
      'Provide a brief caption when extra context would help; omit it for an unannotated send.',
    ],
    parameters: SendDocumentParams,
    async execute(_toolCallId, params) {
      const resolved = resolvePath(params.path);
      const allowedExts = DOCUMENT_UPLOAD_EXTS.map((ext) => `.${ext}`);
      validateUpload(resolved, allowedExts, LOCAL_DOCUMENT_UPLOAD_DIRS);
      const outcome = await deliverToChat(session, 'document', () =>
        uploadDocument(resolved, params.caption),
      );
      return {
        content: [
          {
            type: 'text',
            text:
              outcome === 'held'
                ? heldDeliveryNote(`Document ${path.basename(resolved)}`)
                : `Sent document: ${path.basename(resolved)}`,
          },
        ],
        details: { path: resolved, caption: params.caption ?? null },
      };
    },
  });
}

function resolvePath(input: string): string {
  let filePath = input.trim().replace(/^file:\/\//, '');
  if (filePath.startsWith('~/')) {
    filePath = path.join(os.homedir(), filePath.slice(2));
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: ${input}`);
  }
  return path.resolve(filePath);
}

function validateUpload(filePath: string, allowedExts: string[], allowedDirs: string[]): void {
  const ext = path.extname(filePath).toLowerCase();
  if (!allowedExts.includes(ext)) {
    throw new Error(
      `File extension "${ext || '(none)'}" is not allowed. Supported: ${allowedExts.join(', ')}`,
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Not a regular non-empty file: ${filePath}`);
  }
  if (stat.size > TELEGRAM_DOCUMENT_UPLOAD_LIMIT) {
    throw new Error(
      `File exceeds Telegram upload limit (${(stat.size / 1024 / 1024).toFixed(1)}MB).`,
    );
  }

  let realFile: string;
  try {
    realFile = fs.realpathSync(filePath);
  } catch {
    throw new Error(`Cannot resolve real path: ${filePath}`);
  }

  const ok = allowedDirs.some((dir) => {
    const expanded = dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : dir;
    let resolved = path.resolve(expanded);
    try {
      resolved = fs.realpathSync(resolved);
    } catch {
      // Directory may not yet exist; skip realpath resolution.
    }
    return realFile === resolved || realFile.startsWith(`${resolved}${path.sep}`);
  });

  if (!ok) {
    throw new Error(`File is not under an allowed upload directory: ${filePath}`);
  }
}

async function uploadImage(filePath: string, caption: string | undefined): Promise<void> {
  const stat = fs.statSync(filePath);
  const asPhoto = stat.size <= TELEGRAM_PHOTO_UPLOAD_LIMIT;
  const method = asPhoto ? 'sendPhoto' : 'sendDocument';
  const fieldName = asPhoto ? 'photo' : 'document';
  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('chat_id', ALLOWED_CHAT_ID);
  form.append(
    fieldName,
    new Blob([fileBuffer], { type: imageMimeType(filePath) }),
    path.basename(filePath),
  );
  if (caption) {
    form.append('caption', escapeTelegramHtml(caption));
    form.append('parse_mode', 'HTML');
  }
  await telegram(method, { method: 'POST', body: form }, TELEGRAM_MEDIA_TIMEOUT_MS);
}

async function uploadDocument(filePath: string, caption: string | undefined): Promise<void> {
  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('chat_id', ALLOWED_CHAT_ID);
  form.append('document', new Blob([fileBuffer]), path.basename(filePath));
  if (caption) {
    form.append('caption', escapeTelegramHtml(caption));
    form.append('parse_mode', 'HTML');
  }
  await telegram('sendDocument', { method: 'POST', body: form }, TELEGRAM_MEDIA_TIMEOUT_MS);
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
