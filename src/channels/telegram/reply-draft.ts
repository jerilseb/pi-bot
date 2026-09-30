import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { REPLY_DRAFT_INTERVAL_MS, REPLY_DRAFT_KEEPALIVE_MS } from '../../config.ts';
import { RunText } from '../../run-text.ts';
import { errorMessage } from '../../util.ts';
import { markdownToTelegramHtml } from './markdown.ts';
import { sendTelegramDraft, telegramRetryAfterMs } from './telegram.ts';

/**
 * A chat turn's reply, shown as a Telegram draft while it is written. The draft
 * holds the text the reply will have, built by the same RunText from the same
 * events, so the reply replaces it with the same words.
 *
 * While the model thinks, the draft says so in an italic "Thinking…", under
 * the text so far, never with the thinking's words.
 *
 * Updates are paced: the first text goes out at once, and later changes at most
 * one per `intervalMs`, each with all the text so far, so a burst of tokens
 * costs one call. While the text holds still (tools running), the same draft is
 * sent again every `keepAliveMs`, since Telegram drops a draft 30 seconds after
 * its last update and whenever a message arrives.
 *
 * Nothing is sent before `after` settles: the channel passes the point in its
 * send queue where the turn began, so the reply to the turn before cannot wipe
 * the draft. The reply must wait for what stop() returns: a draft that landed
 * after it would stay under the reply.
 *
 * Best-effort, like the typing indicator: a rate limit pauses it for as long as
 * Telegram asks, and any other failure ends it for the turn, logged. The reply
 * is sent either way.
 */

export interface ReplyDraft {
  /** One of the turn's SDK events; those that add text change the draft. */
  observe(event: AgentSessionEvent): void;
  /** Sends nothing more, and settles once a draft in flight has. Never rejects. */
  stop(): Promise<void>;
}

export interface ReplyDraftOptions {
  after?: Promise<unknown>;
  intervalMs?: number;
  keepAliveMs?: number;
  /** The transport; tests pass their own. */
  send?: (draftId: number, html: string) => Promise<void>;
}

/** Each turn's draft has an ID of its own, so one never animates into another. */
let lastDraftId = 0;

export function createReplyDraft(options: ReplyDraftOptions = {}): ReplyDraft {
  const {
    after,
    intervalMs = REPLY_DRAFT_INTERVAL_MS,
    keepAliveMs = REPLY_DRAFT_KEEPALIVE_MS,
    send = sendTelegramDraft,
  } = options;
  const draftId = ++lastDraftId;
  const text = new RunText();
  /** What the draft shows, as HTML; empty until the first is sent. */
  let shown = '';
  /** Whether the model is in a thinking block. */
  let thinking = false;
  /** Set by every event, cleared when one is sent: the text may have moved on. */
  let changed = false;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let pausedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = Number.POSITIVE_INFINITY;
  let sending: Promise<void> | null = null;
  let stopped = false;

  function observe(event: AgentSessionEvent): void {
    if (stopped) return;
    thinking = thinkingAfter(event, thinking);
    text.observe(event);
    changed = true;
    if (!sending) scheduleNext();
  }

  function stop(): Promise<void> {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    dueAt = Number.POSITIVE_INFINITY;
    return sending ?? Promise.resolve();
  }

  /** A change goes out after the interval; unchanged text is sent again to keep it shown. */
  function scheduleNext(): void {
    if (changed) wakeAt(Math.max(lastSentAt + intervalMs, pausedUntil));
    else if (shown) wakeAt(Math.max(lastSentAt + keepAliveMs, pausedUntil));
  }

  /** One timer at a time, moved sooner when something is due before it. */
  function wakeAt(at: number): void {
    if (stopped || at >= dueAt) return;
    if (timer) clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(
      () => {
        timer = null;
        dueAt = Number.POSITIVE_INFINITY;
        update();
      },
      Math.max(0, at - Date.now()),
    );
  }

  function update(): void {
    if (stopped || sending) return;
    sending = sendLatest().finally(() => {
      sending = null;
      scheduleNext();
    });
  }

  async function sendLatest(): Promise<void> {
    try {
      if (after) await after.catch(() => undefined);
      const html = draftHtml(text.result().text, thinking);
      changed = false;
      if (stopped || !html) return;
      if (html === shown && Date.now() - lastSentAt < keepAliveMs) return;
      try {
        await send(draftId, html);
        shown = html;
      } finally {
        lastSentAt = Date.now();
      }
    } catch (error) {
      fail(error);
    }
  }

  function fail(error: unknown): void {
    const waitMs = telegramRetryAfterMs(error);
    if (waitMs !== null) {
      pausedUntil = Date.now() + waitMs;
      // What was refused goes again once the pause is over.
      changed = true;
      console.warn(`Telegram is limiting drafts; the next in ${waitMs / 1000}s`);
      return;
    }
    stopped = true;
    console.error('reply draft failed; the reply will arrive whole:', errorMessage(error));
  }

  return { observe, stop };
}

const THINKING_HTML = '<i>Thinking…</i>';

/** The draft for the text so far, with "Thinking…" under it while the model thinks. */
function draftHtml(markdown: string, thinking: boolean): string {
  const html = markdown ? markdownToTelegramHtml(markdown) : '';
  const shown = html.trim() ? html : '';
  if (!thinking) return shown;
  return shown ? `${shown.trimEnd()}\n\n${THINKING_HTML}` : THINKING_HTML;
}

/** Whether the model is thinking after `event`: from a thinking block's start until what follows it. */
function thinkingAfter(event: AgentSessionEvent, thinking: boolean): boolean {
  if (event.type === 'message_update') {
    const { type } = event.assistantMessageEvent;
    if (type === 'thinking_start' || type === 'thinking_delta') return true;
    return type === 'start' ? thinking : false;
  }
  if (event.type === 'message_end' || event.type === 'auto_retry_start') return false;
  return thinking;
}
