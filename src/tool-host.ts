import type { ChoiceSpec } from './choices.ts';
import type {
  ChannelCaps,
  ChoiceView,
  Deliverable,
  Receipt,
  SubmitResult,
  UserInput,
} from './contract.ts';
import type { SessionKind } from './types.ts';

/**
 * What the agent's tools need from the core to reach the user: deliveries
 * (files, voice notes, menus), notices, and submitting a menu answer. The tools
 * are registered deep inside a Pi session, so the core is installed here once
 * at startup, as the outbox is, rather than threaded through every session.
 */

/** A delivery before the core decides who it alerts. */
export type DeliveryDraft = Deliverable extends infer Item
  ? Item extends Deliverable
    ? Omit<Item, 'ping'>
    : never
  : never;

export type DeliveryResult = { outcome: 'held' } | { outcome: 'delivered'; receipts: Receipt[] };

export interface ToolHost {
  /**
   * Sends a delivery from one of the bot's sessions: at once from the chat
   * session, once the chat has been idle from the background one. `draft` is
   * built when the delivery goes out, and `after` runs once it has, with its
   * receipts. A held delivery that no channel takes throws into the outbox,
   * which logs it.
   */
  deliver(
    session: SessionKind,
    label: string,
    draft: () => DeliveryDraft,
    after?: (receipts: Receipt[], item: DeliveryDraft) => void,
  ): Promise<DeliveryResult>;
  /** Opens a menu and returns it as channels show it. */
  openChoice(spec: ChoiceSpec): ChoiceView;
  closeChoice(id: string): void;
  submit(input: UserInput): Promise<SubmitResult>;
  /** True when some attached channel has this capability. */
  anyChannelCan(capability: keyof ChannelCaps): boolean;
  /** A notice in Markdown for every channel. */
  notice(markdown: string, level?: 'info' | 'warn' | 'error'): void;
}

let host: ToolHost | null = null;

/** Installs the core. main.ts calls this once at startup; tests install a fake. */
export function setToolHost(next: ToolHost | null): void {
  host = next;
}

export function toolHost(): ToolHost {
  if (!host) throw new Error('No interface is connected to the bot yet.');
  return host;
}

/**
 * What a tool tells the agent about a delivery: nothing extra when every
 * channel that could show it did, which channels failed otherwise. Throws when
 * none took it, as a failed upload always has, so the agent knows.
 */
export function describeReceipts(what: string, receipts: readonly Receipt[]): string {
  const attempted = receipts.filter((receipt) => !receipt.skipped);
  if (attempted.length === 0) throw new Error(`No connected interface can show ${what}.`);
  const failed = attempted.filter((receipt) => !receipt.ok);
  if (failed.length === attempted.length) {
    throw new Error(failed.map((receipt) => receipt.error ?? 'delivery failed').join('; '));
  }
  if (failed.length === 0) return '';
  const list = failed.map((receipt) => `${receipt.channel.id} (${receipt.error ?? 'failed'})`);
  return ` It did not reach ${list.join(', ')}.`;
}
