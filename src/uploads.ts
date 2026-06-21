import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  DOCUMENT_UPLOAD_EXTS,
  DOCUMENT_UPLOAD_LIMIT,
  LOCAL_DOCUMENT_UPLOAD_DIRS,
  LOCAL_IMAGE_UPLOAD_DIRS,
} from './config.ts';
import { register as registerAsset } from './web/assets.ts';
import * as gateway from './web/gateway.ts';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const SendImageParams = Type.Object({
  path: Type.String({
    description:
      'Absolute path to a local image file (.png, .jpg, .jpeg, .webp, .gif). Tilde-prefixed paths are accepted. The file must reside under an allowed upload directory.',
  }),
  caption: Type.Optional(
    Type.String({
      description: 'Optional short caption shown beneath the image in the web UI.',
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
      description: 'Optional short caption shown beneath the document in the web UI.',
    }),
  ),
});

export function imageUploadExtension(chatId: string): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'send_image',
      label: 'Send Image',
      description:
        'Send a local image file to the user so it renders inline in the web UI. Use after generating or otherwise producing an image that the user should see.',
      promptSnippet: 'Send an image file to the user.',
      promptGuidelines: [
        'Call this only when the user should actually see the image — not when merely discussing or analyzing one.',
        'Pass an absolute path to a file that already exists on disk (e.g. output of the create-image skill).',
        'Provide a brief caption when extra context would help; omit it for an unannotated send.',
        'After sending, keep the accompanying text reply short — the image carries the content.',
      ],
      parameters: SendImageParams,
      async execute(_toolCallId, params) {
        const resolved = resolvePath(params.path);
        validateUpload(resolved, IMAGE_EXTS, LOCAL_IMAGE_UPLOAD_DIRS);
        sendAsset(chatId, resolved, 'image', imageMimeType(resolved), params.caption);
        return {
          content: [{ type: 'text', text: `Sent image: ${path.basename(resolved)}` }],
          details: { path: resolved, caption: params.caption ?? null },
        };
      },
    });
  };
}

export function documentUploadExtension(chatId: string): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'send_document',
      label: 'Send Document',
      description: 'Send a local document file (pdf, docx, csv, md, txt, etc.) to the user.',
      promptSnippet: 'Send a document file to the user.',
      promptGuidelines: [
        'Call this only when the user should actually receive the file — not when merely discussing or analyzing it.',
        'Pass an absolute path to a file that already exists on disk.',
        'Supported extensions are configured via PI_CHANNEL_DOCUMENT_UPLOAD_EXTS.',
        'Provide a brief caption when extra context would help; omit it for an unannotated send.',
      ],
      parameters: SendDocumentParams,
      async execute(_toolCallId, params) {
        const resolved = resolvePath(params.path);
        const allowedExts = DOCUMENT_UPLOAD_EXTS.map((ext) => `.${ext}`);
        validateUpload(resolved, allowedExts, LOCAL_DOCUMENT_UPLOAD_DIRS);
        sendAsset(chatId, resolved, 'document', documentMimeType(resolved), params.caption);
        return {
          content: [{ type: 'text', text: `Sent document: ${path.basename(resolved)}` }],
          details: { path: resolved, caption: params.caption ?? null },
        };
      },
    });
  };
}

function sendAsset(
  chatId: string,
  filePath: string,
  kind: 'image' | 'document',
  mimeType: string,
  caption: string | undefined,
): void {
  const name = path.basename(filePath);
  const assetId = registerAsset({ source: filePath, mimeType, kind, name, origin: 'generated' });
  gateway.emit(chatId, {
    type: 'file',
    payload: {
      assetId,
      url: `/api/files/${assetId}`,
      name,
      mimeType,
      kind,
      ...(caption ? { caption } : {}),
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
  if (stat.size > DOCUMENT_UPLOAD_LIMIT) {
    throw new Error(`File exceeds the upload limit (${(stat.size / 1024 / 1024).toFixed(1)}MB).`);
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

function documentMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.pdf':
      return 'application/pdf';
    case '.txt':
      return 'text/plain';
    case '.md':
      return 'text/markdown';
    case '.csv':
      return 'text/csv';
    case '.json':
      return 'application/json';
    case '.doc':
      return 'application/msword';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xls':
      return 'application/vnd.ms-excel';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.ppt':
      return 'application/vnd.ms-powerpoint';
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    default:
      return 'application/octet-stream';
  }
}
