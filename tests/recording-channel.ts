import type {
  Channel,
  ChannelCaps,
  ChannelRef,
  CoreEvent,
  Deliverable,
  Receipt,
} from '../src/contract.ts';

/**
 * A channel that records what the core sends it, for tests. Deliveries return
 * whatever `receipt` says, ok by default.
 */
export class RecordingChannel implements Channel {
  readonly ref: ChannelRef;
  readonly caps: ChannelCaps;
  readonly events: CoreEvent[] = [];
  readonly deliveries: Deliverable[] = [];
  receipt: (item: Deliverable) => Omit<Receipt, 'channel'> = () => ({ ok: true });

  constructor(ref: ChannelRef = { id: 'test', kind: 'telegram' }, durable = true) {
    this.ref = ref;
    this.caps = { buttons: true, edits: true, files: true, voice: true, durable };
  }

  onEvent(event: CoreEvent): void {
    this.events.push(event);
  }

  async deliver(item: Deliverable): Promise<Receipt> {
    this.deliveries.push(item);
    return { channel: this.ref, ...this.receipt(item) };
  }

  async drain(): Promise<void> {}

  of<T extends CoreEvent['type']>(type: T): Array<Extract<CoreEvent, { type: T }>> {
    return this.events.filter(
      (event): event is Extract<CoreEvent, { type: T }> => event.type === type,
    );
  }

  /** The text of every chat reply, in order. */
  replies(): string[] {
    return this.of('turn_end').flatMap((event) =>
      event.outcome === 'replied' && event.session === 'chat' ? [event.reply.text] : [],
    );
  }

  notices(): string[] {
    return this.of('notice').map((event) => event.text.text);
  }

  /** The text of every background report delivered, in order. */
  reports(): string[] {
    return this.deliveries.flatMap((item) => (item.kind === 'report' ? [item.text.text] : []));
  }
}
