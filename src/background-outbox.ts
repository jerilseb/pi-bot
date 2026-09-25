import { BACKGROUND_DELIVERY_COOLDOWN_MS, BACKGROUND_DELIVERY_POLL_MS } from './config.ts';
import type { SessionKind } from './types.ts';
import { errorMessage } from './util.ts';

/**
 * Holds what background runs send the user until the chat has been left alone
 * for a while, and while no channel is attached to send it to.
 *
 * Scheduled tasks and heartbeat runs no longer wait for the chat, so their
 * reports can be ready while the user is mid-conversation. A report arriving
 * then interrupts; this delays it until the chat has been idle — no prompt
 * processing, nothing queued, no new message — for the whole cooldown. Every
 * user message or chat turn restarts the cooldown.
 *
 * A delivery is a closure, so everything that must happen with the message
 * happens at delivery time: the report is noted in the chat session only once
 * the user has actually been sent it. Deliveries go out in the order queued.
 *
 * Held deliveries live in memory only; a restart drops them. When nothing is
 * held and the chat is already past its cooldown, a delivery runs immediately
 * and its failure reaches the caller, just as a direct send's would.
 */

export type DeliveryOutcome = 'delivered' | 'held';

export interface BackgroundOutboxOptions {
  /** True while the chat session is processing a prompt or has one queued. */
  isChatBusy: () => boolean;
  /** False while no channel is attached to deliver to; held deliveries wait. Defaults to true. */
  hasAudience?: () => boolean;
  cooldownMs?: number;
  /** How often a held delivery rechecks while the chat is busy. */
  pollMs?: number;
  now?: () => number;
}

interface HeldDelivery {
  label: string;
  deliver: () => Promise<void>;
}

export class BackgroundOutbox {
  private readonly pending: HeldDelivery[] = [];
  private readonly options: BackgroundOutboxOptions;
  private readonly cooldownMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private lastChatActivityAt: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private stopped = false;

  constructor(options: BackgroundOutboxOptions) {
    this.options = options;
    this.cooldownMs = options.cooldownMs ?? BACKGROUND_DELIVERY_COOLDOWN_MS;
    this.pollMs = options.pollMs ?? BACKGROUND_DELIVERY_POLL_MS;
    this.now = options.now ?? Date.now;
    // A restart is usually asked for from the chat, so startup counts as activity.
    this.lastChatActivityAt = this.now();
  }

  get heldCount(): number {
    return this.pending.length;
  }

  /** Records chat activity: a user message, or a chat turn starting or ending. */
  noteChatActivity(): void {
    this.lastChatActivityAt = this.now();
    this.schedule();
  }

  /**
   * Delivers now if nothing is held and the chat has been idle for the
   * cooldown; otherwise holds the delivery behind any already waiting.
   */
  async send(label: string, deliver: () => Promise<void>): Promise<DeliveryOutcome> {
    if (this.pending.length === 0 && !this.flushing && this.canDeliver()) {
      await deliver();
      return 'delivered';
    }
    this.pending.push({ label, deliver });
    console.log(`background ${label} held until the chat is idle (${this.pending.length} held)`);
    this.schedule();
    return 'held';
  }

  /** Drops whatever is held and stops the timer. Called on shutdown. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length > 0) {
      console.log(`dropping ${this.pending.length} held background delivery(ies) on shutdown`);
      this.pending.length = 0;
    }
  }

  private canDeliver(): boolean {
    return (
      !this.stopped &&
      this.hasAudience() &&
      !this.options.isChatBusy() &&
      this.now() - this.lastChatActivityAt >= this.cooldownMs
    );
  }

  private hasAudience(): boolean {
    return this.options.hasAudience?.() ?? true;
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.pending.length === 0) return;
    const untilCooldown = this.lastChatActivityAt + this.cooldownMs - this.now();
    // Busy, or nobody attached, has no end time to wait for, so poll; idle
    // waits out the cooldown. Either way a recheck decides, so activity after
    // scheduling only means an early wake-up.
    const delay =
      this.options.isChatBusy() || !this.hasAudience()
        ? this.pollMs
        : Math.max(0, Math.min(untilCooldown, this.pollMs));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // Rechecked per delivery: a message the user sends mid-flush holds the rest.
      while (this.pending.length > 0 && this.canDeliver()) {
        const next = this.pending.shift();
        if (!next) break;
        try {
          await next.deliver();
          console.log(`background ${next.label} delivered after the chat cooldown`);
        } catch (error) {
          console.error(`failed to deliver held background ${next.label}:`, errorMessage(error));
        }
      }
    } finally {
      this.flushing = false;
      this.schedule();
    }
  }
}

let outbox: BackgroundOutbox | null = null;

/** Installs the process-wide outbox. main.ts calls this once at startup. */
export function setBackgroundOutbox(next: BackgroundOutbox | null): void {
  outbox = next;
}

export function backgroundOutbox(): BackgroundOutbox | null {
  return outbox;
}

/**
 * The one door from a Pi session to the user. The chat session sends directly;
 * the background session goes through the outbox. Without an outbox (tests,
 * the smoke check) everything is sent directly.
 */
export async function deliverToChat(
  session: SessionKind,
  label: string,
  deliver: () => Promise<void>,
): Promise<DeliveryOutcome> {
  if (session !== 'background' || !outbox) {
    await deliver();
    return 'delivered';
  }
  return outbox.send(label, deliver);
}

/** What a Telegram tool tells the agent when its send was held. */
export function heldDeliveryNote(what: string): string {
  const minutes = Math.round(BACKGROUND_DELIVERY_COOLDOWN_MS / 60_000);
  return `${what} queued: the user is busy in the chat, so it will be delivered once the chat has been idle for ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
