import type { ImageContent } from '@earendil-works/pi-ai';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { IncomingPrompt } from './types.ts';

type SteeringSession = Pick<
  AgentSession,
  'isStreaming' | 'steer' | 'getSteeringMessages' | 'clearQueue'
>;

/**
 * The prompts steered into one run, held until the run is over: an attached
 * file reaches the agent as a path, so it must outlive the message.
 *
 * Delivery is Pi's. prompt() keeps going while anything is queued, so a message
 * that lands after the agent's last look at the queue still gets a turn in this
 * run. Steering closes at the run's final agent_end; later input waits in the
 * bot's queue for a run of its own.
 */
export class PromptSteering {
  private prompts: IncomingPrompt[] = [];
  private accepting = true;

  private session: SteeringSession;
  private settle: (prompt: IncomingPrompt) => void;

  constructor(session: SteeringSession, settle: (prompt: IncomingPrompt) => void) {
    this.session = session;
    this.settle = settle;
  }

  /** Messages Pi has queued but not yet given the agent. */
  get pendingCount(): number {
    return this.session.getSteeringMessages().length;
  }

  async trySteer(
    prompt: IncomingPrompt,
    prepared: { message: string; images?: ImageContent[] },
  ): Promise<boolean> {
    if (!this.accepting || !this.session.isStreaming) return false;
    // Held from before the SDK has it, so a run that ends meanwhile still settles it.
    this.prompts.push(prompt);
    try {
      await this.session.steer(prepared.message, prepared.images);
      return true;
    } catch (error) {
      this.prompts = this.prompts.filter((candidate) => candidate !== prompt);
      throw error;
    }
  }

  observe(event: AgentSessionEvent): void {
    if (event.type === 'agent_end' && !event.willRetry) this.accepting = false;
  }

  /** Discards what Pi has not delivered yet; the prompts are still settled at finish. */
  cancel(): void {
    this.accepting = false;
    this.session.clearQueue();
  }

  finish(): void {
    this.accepting = false;
    for (const prompt of this.prompts.splice(0)) this.settle(prompt);
  }
}
