import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  WEB_ASSETS_DIR,
  WEB_ASSETS_MANIFEST_PATH,
  WEB_UPLOAD_ABANDONED_TTL_MS,
} from '../config.ts';
import { errorMessage } from '../util.ts';

/**
 * Owned asset store that survives restart. Files (uploads + generated outputs)
 * are copied into `files/web-assets/` immediately on register, and a persisted
 * manifest maps an opaque `assetId` to its stored bytes. The wire only ever
 * exposes `assetId`s, never filesystem paths, which prevents traversal.
 */

export type AssetKind = 'image' | 'document' | 'voice' | 'file';
export type AssetOrigin = 'upload' | 'generated';

interface AssetMeta {
  file: string; // basename within WEB_ASSETS_DIR
  mimeType: string;
  kind: AssetKind;
  name: string;
  origin: AssetOrigin;
  createdAt: number;
  /** Abandoned-upload TTL. null once retained (consumed by a prompt / generated). */
  expiresAt: number | null;
}

export type ResolvedAsset =
  | { status: 'ok'; absPath: string; mimeType: string; name: string }
  | { status: 'expired' }
  | { status: 'missing' };

let manifest: Record<string, AssetMeta> | null = null;

function ensureDir(): void {
  fs.mkdirSync(WEB_ASSETS_DIR, { recursive: true });
}

function load(): Record<string, AssetMeta> {
  if (manifest) return manifest;
  ensureDir();
  try {
    const raw = fs.readFileSync(WEB_ASSETS_MANIFEST_PATH, 'utf8').trim();
    manifest = raw ? (JSON.parse(raw) as Record<string, AssetMeta>) : {};
  } catch {
    manifest = {};
  }
  return manifest;
}

function persist(): void {
  if (!manifest) return;
  ensureDir();
  try {
    fs.writeFileSync(WEB_ASSETS_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('Failed to persist asset manifest:', errorMessage(error));
  }
}

function safeExt(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

export interface RegisterInput {
  /** Either an existing source path to copy, or in-memory bytes. */
  source: string | Buffer;
  mimeType: string;
  kind: AssetKind;
  name: string;
  origin: AssetOrigin;
  /** Abandoned-upload TTL; omit for retained assets (generated / consumed). */
  ttlMs?: number;
}

/** Copies the bytes into the managed dir immediately and returns an opaque id. */
export function register(input: RegisterInput): string {
  const store = load();
  const assetId = randomUUID();
  const file = `${assetId}${safeExt(input.name)}`;
  const dest = path.join(WEB_ASSETS_DIR, file);

  ensureDir();
  if (Buffer.isBuffer(input.source)) {
    fs.writeFileSync(dest, input.source);
  } else {
    fs.copyFileSync(input.source, dest);
  }

  store[assetId] = {
    file,
    mimeType: input.mimeType,
    kind: input.kind,
    name: input.name,
    origin: input.origin,
    createdAt: Date.now(),
    expiresAt: input.ttlMs ? Date.now() + input.ttlMs : null,
  };
  persist();
  return assetId;
}

/** Registers an abandoned-upload asset with the short TTL. */
export function registerUpload(input: Omit<RegisterInput, 'origin' | 'ttlMs'>): string {
  return register({ ...input, origin: 'upload', ttlMs: WEB_UPLOAD_ABANDONED_TTL_MS });
}

/** Marks an upload as consumed by a prompt so it is retained (no abandoned TTL). */
export function markConsumed(assetId: string): void {
  const store = load();
  const meta = store[assetId];
  if (!meta) return;
  meta.expiresAt = null;
  persist();
}

export function getMeta(assetId: string): AssetMeta | null {
  return load()[assetId] ?? null;
}

export function resolve(assetId: string): ResolvedAsset {
  const store = load();
  const meta = store[assetId];
  if (!meta) return { status: 'missing' };

  if (meta.expiresAt !== null && Date.now() > meta.expiresAt) {
    return { status: 'expired' };
  }

  const absPath = path.join(WEB_ASSETS_DIR, meta.file);
  if (!fs.existsSync(absPath)) return { status: 'expired' };

  return { status: 'ok', absPath, mimeType: meta.mimeType, name: meta.name };
}

/** Removes abandoned uploads past their TTL and prunes manifest entries whose
 * backing file is gone. Safe to call periodically. */
export function sweep(): void {
  const store = load();
  const now = Date.now();
  let changed = false;

  for (const [id, meta] of Object.entries(store)) {
    const absPath = path.join(WEB_ASSETS_DIR, meta.file);
    const expired = meta.expiresAt !== null && now > meta.expiresAt;
    if (expired) {
      try {
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      } catch {
        // best-effort
      }
      delete store[id];
      changed = true;
    }
  }

  if (changed) persist();
}
