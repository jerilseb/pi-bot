import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { Busboy, type BusboyHeaders } from '@fastify/busboy';
import { Value } from 'typebox/value';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  TMP_DIR,
  WEB_DIST_DIR,
  WEB_UI_HOST,
  WEB_UI_PORT,
  WEB_UPLOAD_MAX_BYTES,
} from '../config.ts';
import type { Attachment, IncomingPrompt, TranscriptionResult } from '../types.ts';
import { errorMessage } from '../util.ts';
import {
  type AssetKind,
  registerUpload,
  resolve as resolveAsset,
  markConsumed,
  getMeta,
} from './assets.ts';
import * as gateway from './gateway.ts';
import { resolveMenuSelection } from './menu.ts';
import { ClientMessageSchema, type ClientMessage } from './protocol.ts';
import { addSubscription, getVapidPublicKey, isPushEnabled, removeSubscription } from './push.ts';

export interface WebServerDeps {
  chatId: string;
  handleIncoming: (prompt: IncomingPrompt) => Promise<void>;
  getModelName: () => string;
  allowedModels: string[];
  setModel: (model: string) => Promise<void>;
  isBusy: () => boolean;
  statusText: () => string;
  transcribe: (
    filePath: string,
    mimeType: string | undefined,
    name: string,
  ) => Promise<TranscriptionResult>;
}

const MAX_WS_PAYLOAD = WEB_UPLOAD_MAX_BYTES + 1024;

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DOC_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);
const AUDIO_PREFIX = 'audio/';

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sanitizeBaseName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  return base.replace(/^\.+/, '') || 'file';
}

function uploadKind(mimeType: string): AssetKind | null {
  if (IMAGE_MIME.has(mimeType)) return 'image';
  if (DOC_MIME.has(mimeType)) return 'document';
  return null;
}

interface ParsedUpload {
  buffer: Buffer;
  name: string;
  mimeType: string;
}

interface ParsedForm {
  files: ParsedUpload[];
  tooLarge: boolean;
}

function parseMultipart(req: http.IncomingMessage, maxFileBytes: number): Promise<ParsedForm> {
  return new Promise((resolve, reject) => {
    let bb: Busboy;
    try {
      bb = new Busboy({
        headers: req.headers as BusboyHeaders,
        limits: { fileSize: maxFileBytes, files: 20 },
      });
    } catch (error) {
      reject(error);
      return;
    }

    const files: ParsedUpload[] = [];
    let tooLarge = false;
    const pending: Array<Promise<void>> = [];

    bb.on('file', (_field, stream, filename, _encoding, mimeType) => {
      const chunks: Buffer[] = [];
      let truncated = false;
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => {
        truncated = true;
        tooLarge = true;
      });
      pending.push(
        new Promise<void>((res) => {
          stream.on('close', () => {
            if (!truncated) {
              files.push({
                buffer: Buffer.concat(chunks),
                name: sanitizeBaseName(filename || 'file'),
                mimeType: (mimeType || 'application/octet-stream').toLowerCase(),
              });
            }
            res();
          });
        }),
      );
    });

    bb.on('error', reject);
    bb.on('finish', () => {
      void Promise.all(pending).then(() => resolve({ files, tooLarge }));
    });
    req.pipe(bb);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readJsonBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function handleUpload(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
  let form: ParsedForm;
  try {
    form = await parseMultipart(req, WEB_UPLOAD_MAX_BYTES);
  } catch (error) {
    sendJson(res, 400, { error: errorMessage(error) });
    return;
  }

  if (form.tooLarge) {
    sendJson(res, 413, { error: 'One or more files exceed the upload size limit.' });
    return;
  }

  const uploads: Array<{ uploadId: string; name: string; mimeType: string; kind: AssetKind }> = [];
  for (const file of form.files) {
    const kind = uploadKind(file.mimeType);
    if (!kind) {
      sendJson(res, 415, { error: `Unsupported file type: ${file.mimeType}` });
      return;
    }
    const uploadId = registerUpload({
      source: file.buffer,
      mimeType: file.mimeType,
      kind,
      name: file.name,
    });
    uploads.push({ uploadId, name: file.name, mimeType: file.mimeType, kind });
  }

  sendJson(res, 200, { uploads });
}

async function handleTranscribe(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  deps: WebServerDeps,
): Promise<void> {
  let form: ParsedForm;
  try {
    form = await parseMultipart(req, WEB_UPLOAD_MAX_BYTES);
  } catch (error) {
    sendJson(res, 400, { error: errorMessage(error) });
    return;
  }

  const file = form.files[0];
  if (!file) {
    sendJson(res, 400, { error: 'No audio file provided.' });
    return;
  }
  if (!file.mimeType.startsWith(AUDIO_PREFIX) && file.mimeType !== 'application/octet-stream') {
    sendJson(res, 415, { error: `Unsupported audio type: ${file.mimeType}` });
    return;
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tmpPath = path.join(TMP_DIR, `${randomUUID()}-${file.name}`);
  fs.writeFileSync(tmpPath, file.buffer);
  try {
    const result = await deps.transcribe(tmpPath, file.mimeType, file.name);
    if (result.ok && result.text) {
      sendJson(res, 200, { text: result.text });
    } else {
      sendJson(res, 422, { error: result.error || 'Transcription not configured.' });
    }
  } catch (error) {
    sendJson(res, 500, { error: errorMessage(error) });
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort
    }
  }
}

function handleFile(res: http.ServerResponse, assetId: string): void {
  const resolved = resolveAsset(assetId);
  if (resolved.status === 'missing') {
    res.writeHead(404).end('Not found');
    return;
  }
  if (resolved.status === 'expired') {
    res.writeHead(410).end('This attachment has expired.');
    return;
  }
  res.writeHead(200, {
    'content-type': resolved.mimeType,
    'content-disposition': `inline; filename="${encodeURIComponent(resolved.name)}"`,
    'cache-control': 'private, max-age=86400',
  });
  fs.createReadStream(resolved.absPath).pipe(res);
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  if (!fs.existsSync(WEB_DIST_DIR)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Web UI is not built. Run `npm run build` to produce web/dist.');
    return;
  }

  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const target = path.normalize(path.join(WEB_DIST_DIR, rel));

  if (!target.startsWith(WEB_DIST_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    res.writeHead(200, {
      'content-type':
        STATIC_CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      ...(rel.startsWith('assets/')
        ? { 'cache-control': 'public, max-age=31536000, immutable' }
        : {}),
    });
    fs.createReadStream(target).pipe(res);
    return;
  }

  // SPA fallback.
  const indexPath = path.join(WEB_DIST_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(indexPath).pipe(res);
    return;
  }
  res.writeHead(404).end('Not found');
}

function buildReady(deps: WebServerDeps) {
  return {
    type: 'ready' as const,
    payload: {
      model: deps.getModelName(),
      allowedModels: deps.allowedModels,
      vapidPublicKey: getVapidPublicKey(),
      pushEnabled: isPushEnabled(),
      status: deps.statusText(),
      serverSeq: 0,
    },
  };
}

async function resolvePromptAttachments(uploadIds: string[]): Promise<{
  attachments: Attachment[];
  error?: string;
}> {
  const attachments: Attachment[] = [];
  for (const uploadId of uploadIds) {
    const meta = getMeta(uploadId);
    const resolved = resolveAsset(uploadId);
    if (!meta || resolved.status !== 'ok') {
      return { attachments, error: `Upload ${uploadId} is no longer available.` };
    }
    markConsumed(uploadId);
    attachments.push({
      type: meta.kind === 'image' ? 'image' : 'file',
      path: resolved.absPath,
      filename: meta.name,
      mimeType: meta.mimeType,
    });
  }
  return { attachments };
}

function attachmentRefs(uploadIds: string[]) {
  return uploadIds
    .map((id) => {
      const meta = getMeta(id);
      if (!meta) return null;
      return {
        assetId: id,
        url: `/api/files/${id}`,
        name: meta.name,
        mimeType: meta.mimeType,
        kind: (meta.kind === 'image' ? 'image' : 'file') as 'image' | 'file',
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}

async function handleClientMessage(
  ws: WebSocket,
  message: ClientMessage,
  deps: WebServerDeps,
): Promise<void> {
  const { chatId } = deps;

  switch (message.type) {
    case 'prompt': {
      const uploadIds = message.uploadIds ?? [];
      const { attachments, error } = await resolvePromptAttachments(uploadIds);
      if (error) {
        gateway.sendTo(ws, { type: 'error', payload: { message: error } }, chatId);
        return;
      }
      const text = message.text;
      if (!text.trim() && attachments.length === 0) return;
      gateway.emit(chatId, {
        type: 'user_message',
        payload: { text, attachments: attachmentRefs(uploadIds) },
      });
      await deps.handleIncoming({
        chatId,
        text: text || 'Describe this attachment.',
        attachments,
        source: 'web',
      });
      return;
    }

    case 'menu_select': {
      const selection = message.cancel ? { cancel: true } : { optionIndex: message.optionIndex };
      const result = resolveMenuSelection(chatId, message.menuId, selection);
      if ('error' in result) {
        gateway.sendTo(ws, { type: 'error', payload: { message: result.error } }, chatId);
        return;
      }
      const echo = message.cancel ? 'Cancelled.' : 'Selection sent.';
      gateway.emit(chatId, { type: 'user_message', payload: { text: echo, attachments: [] } });
      await deps.handleIncoming({
        chatId,
        text: result.promptText,
        attachments: [],
        source: 'web',
      });
      return;
    }

    case 'abort':
      await deps.handleIncoming({ chatId, text: '/abort', attachments: [], source: 'web' });
      return;

    case 'new':
      await deps.handleIncoming({ chatId, text: '/new', attachments: [], source: 'web' });
      return;

    case 'set_model': {
      if (deps.isBusy()) {
        gateway.sendTo(
          ws,
          {
            type: 'error',
            payload: {
              message: 'Wait for the current response to finish before switching models.',
            },
          },
          chatId,
        );
        return;
      }
      try {
        await deps.setModel(message.model);
        gateway.modelChanged(chatId, deps.getModelName());
      } catch (error) {
        gateway.sendTo(ws, { type: 'error', payload: { message: errorMessage(error) } }, chatId);
      }
      return;
    }

    case 'visibility':
      gateway.setVisibility(ws, message.visible);
      return;

    case 'ack':
      return;
  }
}

export interface WebServerHandle {
  close(): Promise<void>;
}

export function createWebServer(deps: WebServerDeps): WebServerHandle {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    void (async () => {
      try {
        if (url.startsWith('/api/files/')) {
          handleFile(res, decodeURIComponent(url.slice('/api/files/'.length).split('?')[0]));
          return;
        }
        if (url === '/api/upload' && method === 'POST') {
          await handleUpload(res, req);
          return;
        }
        if (url === '/api/transcribe' && method === 'POST') {
          await handleTranscribe(res, req, deps);
          return;
        }
        if (url === '/api/push/subscribe') {
          if (method === 'POST') {
            const body = await readJsonBody(req);
            addSubscription(body);
            sendJson(res, 200, { ok: true });
            return;
          }
          if (method === 'DELETE') {
            const body = (await readJsonBody(req)) as { endpoint?: string };
            if (body?.endpoint) removeSubscription(body.endpoint);
            sendJson(res, 200, { ok: true });
            return;
          }
        }
        serveStatic(res, url);
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) });
        else res.end();
      }
    })();
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_PAYLOAD });

  wss.on('connection', (ws: WebSocket) => {
    gateway.addClient(ws, deps.chatId);
    gateway.sendTo(ws, buildReady(deps), deps.chatId);
    gateway.replayTo(ws, deps.chatId);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        gateway.sendTo(
          ws,
          { type: 'error', payload: { message: 'Binary frames are not accepted.' } },
          deps.chatId,
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        gateway.sendTo(ws, { type: 'error', payload: { message: 'Invalid JSON.' } }, deps.chatId);
        return;
      }
      if (!Value.Check(ClientMessageSchema, parsed)) {
        gateway.sendTo(
          ws,
          { type: 'error', payload: { message: 'Invalid message.' } },
          deps.chatId,
        );
        return;
      }
      void handleClientMessage(ws, parsed, deps).catch((error) => {
        gateway.error(deps.chatId, errorMessage(error));
      });
    });

    ws.on('close', () => gateway.removeClient(ws));
    ws.on('error', () => gateway.removeClient(ws));
  });

  server.listen(WEB_UI_PORT, WEB_UI_HOST, () => {
    console.log(`Web UI server: http://${WEB_UI_HOST}:${WEB_UI_PORT}`);
  });

  return {
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const client of wss.clients) {
          try {
            client.close();
          } catch {
            // ignore
          }
        }
        wss.close();
        server.close(() => resolve());
      });
    },
  };
}
