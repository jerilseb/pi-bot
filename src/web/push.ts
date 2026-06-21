import * as fs from 'node:fs';
import webpush, { type PushSubscription } from 'web-push';
import {
  WEB_PUSH_ENABLED,
  WEB_PUSH_SUBJECT,
  WEB_PUSH_SUBSCRIPTIONS_PATH,
  WEB_PUSH_VAPID_PRIVATE,
  WEB_PUSH_VAPID_PUBLIC,
} from '../config.ts';
import { errorMessage } from '../util.ts';

/**
 * VAPID-based Web Push, gated behind WEB_PUSH_ENABLED. When off (or keys are
 * absent) the app runs with live + replay only and never touches push code.
 */

let configured = false;

export function isPushEnabled(): boolean {
  return WEB_PUSH_ENABLED && Boolean(WEB_PUSH_VAPID_PUBLIC && WEB_PUSH_VAPID_PRIVATE);
}

export function getVapidPublicKey(): string | null {
  return isPushEnabled() ? WEB_PUSH_VAPID_PUBLIC : null;
}

function ensureConfigured(): boolean {
  if (!isPushEnabled()) return false;
  if (configured) return true;
  try {
    webpush.setVapidDetails(WEB_PUSH_SUBJECT, WEB_PUSH_VAPID_PUBLIC, WEB_PUSH_VAPID_PRIVATE);
    configured = true;
  } catch (error) {
    console.error('Web Push VAPID config failed:', errorMessage(error));
    return false;
  }
  return true;
}

function readSubscriptions(): PushSubscription[] {
  try {
    const raw = fs.readFileSync(WEB_PUSH_SUBSCRIPTIONS_PATH, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PushSubscription[]) : [];
  } catch {
    return [];
  }
}

function writeSubscriptions(subs: PushSubscription[]): void {
  try {
    fs.writeFileSync(WEB_PUSH_SUBSCRIPTIONS_PATH, `${JSON.stringify(subs, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('Failed to persist push subscriptions:', errorMessage(error));
  }
}

/** Adds a subscription, deduped by endpoint. Validates the basic shape. */
export function addSubscription(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const candidate = raw as { endpoint?: unknown; keys?: unknown };
  if (typeof candidate.endpoint !== 'string' || !candidate.keys) return;
  const sub = raw as PushSubscription;
  const subs = readSubscriptions().filter((s) => s.endpoint !== sub.endpoint);
  subs.push(sub);
  writeSubscriptions(subs);
}

export function removeSubscription(endpoint: string): void {
  if (!endpoint) return;
  const subs = readSubscriptions().filter((s) => s.endpoint !== endpoint);
  writeSubscriptions(subs);
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/** Sends a push to all stored subscriptions, pruning any that return 404/410. */
export async function sendPush(_chatId: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return;

  const subs = readSubscriptions();
  if (subs.length === 0) return;

  const data = JSON.stringify(payload);
  const stale: string[] = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, data);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          stale.push(sub.endpoint);
        } else {
          console.error('Web Push send failed:', errorMessage(error));
        }
      }
    }),
  );

  if (stale.length > 0) {
    writeSubscriptions(readSubscriptions().filter((s) => !stale.includes(s.endpoint)));
  }
}
