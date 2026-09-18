import type { ImageContent } from '@earendil-works/pi-ai';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { IncomingPrompt } from './types.ts';

export type SteeringDisposition = 'done' | 'deferred';

type SteeringSession = Pick<
  AgentSession,
  'isStreaming' | 'steer' | 'getSteeringMessages' | 'clearQueue' | 'followUp'
>;

/** Owns steered prompts until the run is idle, including their attachment lifetime. */
export class PromptSteering {
  private entries: Array<{ prompt: IncomingPrompt; message: string; delivered: boolean }> = [];
  private accepting = true;
  private cancelled = false;

  private session: SteeringSession;
  private settle: (prompt: IncomingPrompt, disposition: SteeringDisposition) => void;

  constructor(
    session: SteeringSession,
    settle: (prompt: IncomingPrompt, disposition: SteeringDisposition) => void,
  ) {
    this.session = session;
    this.settle = settle;
  }

  get pendingCount(): number {
    return this.entries.filter((entry) => !entry.delivered).length;
  }

  async trySteer(
    prompt: IncomingPrompt,
    prepared: { message: string; images?: ImageContent[] },
  ): Promise<boolean> {
    if (!this.accepting || !this.session.isStreaming) return false;

    // SDK steer() enqueues synchronously before its promise resolves. Capture the
    // expanded text so queue_update can identify when the SDK consumes it.
    const queued = this.session.steer(prepared.message, prepared.images);
    const entry = {
      prompt,
      message: this.session.getSteeringMessages().at(-1) ?? prepared.message,
      delivered: false,
    };
    this.entries.push(entry);
    try {
      await queued;
      return true;
    } catch (error) {
      this.entries = this.entries.filter((candidate) => candidate !== entry);
      throw error;
    }
  }

  observe(event: AgentSessionEvent): void {
    if (event.type === 'agent_end' && !event.willRetry) this.accepting = false;
    if (event.type !== 'queue_update') return;
    const remaining = [...event.steering];
    // Identical messages are consumed FIFO, so match the still-queued copies
    // from newest to oldest. queue_update precedes async extension listeners;
    // message_start can arrive too late to distinguish a newly queued duplicate.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.delivered) continue;
      const index = remaining.indexOf(entry.message);
      if (index === -1) entry.delivered = true;
      else remaining.splice(index, 1);
    }
  }

  cancel(): void {
    this.accepting = false;
    this.cancelled = true;
    this.session.clearQueue();
  }

  async finish(): Promise<void> {
    this.accepting = false;
    const undelivered = this.entries.filter((entry) => !entry.delivered);
    try {
      if (!this.cancelled && undelivered.length > 0) {
        // A message can arrive after the loop's final steering poll but before
        // agent_end. Remove those messages from the SDK and hand them back to the
        // bot queue. Preserve SDK messages queued by extensions, not this bot.
        const remaining = this.session.clearQueue();
        for (const entry of undelivered) {
          const index = remaining.steering.indexOf(entry.message);
          if (index !== -1) remaining.steering.splice(index, 1);
        }
        for (const text of remaining.steering) {
          if (!this.cancelled) await this.session.steer(text);
        }
        for (const text of remaining.followUp) {
          if (!this.cancelled) await this.session.followUp(text);
        }
      }
    } finally {
      for (const entry of this.entries) {
        this.settle(entry.prompt, this.cancelled || entry.delivered ? 'done' : 'deferred');
      }
      this.entries = [];
    }
  }
}
