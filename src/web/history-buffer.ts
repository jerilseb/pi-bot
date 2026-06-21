import * as fs from 'node:fs';
import * as path from 'node:path';
import { WEB_HISTORY_DIR, WEB_HISTORY_MAX, WEB_HISTORY_STATE_PATH } from '../config.ts';
import { errorMessage } from '../util.ts';
import type { ServerEvent } from './protocol.ts';

/**
 * Append-only JSONL of durable records (never deltas) per chatId, capped to the
 * last WEB_HISTORY_MAX records. A process-monotonic `seq` counter is the single
 * ordering authority for both live and replayed events, and is persisted so it
 * stays monotonic across restarts and never collides with live events after a
 * reboot.
 */

let seqCounter: number | null = null;

function ensureDir(): void {
  fs.mkdirSync(WEB_HISTORY_DIR, { recursive: true });
}

function chatFile(chatId: string): string {
  const safe = chatId.replace(/[^A-Za-z0-9._-]+/g, '-') || 'chat';
  return path.join(WEB_HISTORY_DIR, `${safe}.jsonl`);
}

function scanMaxSeq(): number {
  ensureDir();
  let max = 0;

  try {
    const raw = fs.readFileSync(WEB_HISTORY_STATE_PATH, 'utf8').trim();
    if (raw) {
      const parsed = JSON.parse(raw) as { seq?: number };
      if (typeof parsed.seq === 'number' && parsed.seq > max) max = parsed.seq;
    }
  } catch {
    // no state yet
  }

  // Defensive: also scan record files in case the sidecar fell behind.
  try {
    for (const name of fs.readdirSync(WEB_HISTORY_DIR)) {
      if (!name.endsWith('.jsonl')) continue;
      const records = readJsonl(path.join(WEB_HISTORY_DIR, name));
      const last = records[records.length - 1];
      if (last && last.seq > max) max = last.seq;
    }
  } catch {
    // ignore
  }

  return max;
}

function persistSeq(seq: number): void {
  ensureDir();
  try {
    fs.writeFileSync(WEB_HISTORY_STATE_PATH, `${JSON.stringify({ seq })}\n`, 'utf8');
  } catch (error) {
    console.error('Failed to persist history seq:', errorMessage(error));
  }
}

export function nextSeq(): number {
  if (seqCounter === null) seqCounter = scanMaxSeq();
  seqCounter += 1;
  return seqCounter;
}

function readJsonl(file: string): ServerEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const records: ServerEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as ServerEvent);
    } catch {
      // skip corrupt line
    }
  }
  return records;
}

/** Appends a durable record to its chat log, capping to WEB_HISTORY_MAX, and
 * persists the seq high-water mark. */
export function append(record: ServerEvent): void {
  ensureDir();
  const file = chatFile(record.chatId);
  const records = readJsonl(file);
  records.push(record);
  const retained = records.slice(-WEB_HISTORY_MAX);
  try {
    fs.writeFileSync(file, `${retained.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  } catch (error) {
    console.error('Failed to append history record:', errorMessage(error));
  }
  persistSeq(record.seq);
}

/** Returns retained durable records for a chat in seq order. */
export function readRecords(chatId: string): ServerEvent[] {
  return readJsonl(chatFile(chatId)).sort((a, b) => a.seq - b.seq);
}
