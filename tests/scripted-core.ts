import type {
  AgentCore,
  Channel,
  ChannelRef,
  ChoiceOutcome,
  CommandInfo,
  CoreEvent,
  CoreSnapshot,
  Deliverable,
  JobStopOutcome,
  Receipt,
  SubmitResult,
  UserInput,
} from '../src/contract.ts';

/**
 * An AgentCore that does what a test scripts: it records what it is asked,
 * answers from its fields, and sends events and deliveries to whatever
 * channels are attached. For the terminal UI's socket, whose tests are about
 * carrying the contract, not about what the real core decides.
 */
export class ScriptedCore implements AgentCore {
  readonly channels = new Map<string, Channel>();
  readonly submitted: UserInput[] = [];
  readonly commandsRun: Array<{ line: string; from: ChannelRef }> = [];
  readonly stops: Array<{ jobId: string; task: number | undefined; from: ChannelRef }> = [];
  detached: string[] = [];
  submitResult: SubmitResult = { status: 'queued' };
  /** How a command answers; a promise lets a test hold it. */
  command: (line: string, from: ChannelRef) => Promise<boolean> = async (line, from) => {
    this.commandsRun.push({ line, from });
    return true;
  };
  snapshotResult: () => Promise<CoreSnapshot> = async () => emptySnapshot();
  coreCommands: CommandInfo[] = [{ name: 'help', description: 'Show commands' }];
  /** Called as a channel is attached, before attach returns. */
  onAttach: (channel: Channel) => void = () => {};

  async submit(input: UserInput): Promise<SubmitResult> {
    this.submitted.push(input);
    return this.submitResult;
  }

  commands(from: ChannelRef): CommandInfo[] {
    return [...this.coreCommands, ...(this.channels.get(from.id)?.commands ?? [])];
  }

  async choose(choiceId: string, option: number | 'cancel'): Promise<ChoiceOutcome> {
    return {
      toast: 'ok',
      text: { format: 'plain', text: `${choiceId}:${option}` },
      closed: true,
    };
  }

  async stopJob(
    jobId: string,
    task: number | undefined,
    from: ChannelRef,
  ): Promise<JobStopOutcome> {
    this.stops.push({ jobId, task, from });
    return 'stopping';
  }

  async beginIngestion() {
    return { epoch: 7 };
  }

  attach(channel: Channel): () => void {
    this.channels.set(channel.ref.id, channel);
    this.onAttach(channel);
    return () => {
      this.channels.delete(channel.ref.id);
      this.detached.push(channel.ref.id);
    };
  }

  snapshot(): Promise<CoreSnapshot> {
    return this.snapshotResult();
  }

  emit(event: CoreEvent): void {
    for (const channel of this.channels.values()) channel.onEvent(event);
  }

  deliver(to: string, item: Deliverable): Promise<Receipt> {
    const channel = this.channels.get(to);
    if (!channel) throw new Error(`no channel ${to}`);
    return channel.deliver(item);
  }
}

export function emptySnapshot(): CoreSnapshot {
  return {
    history: [],
    jobs: [],
    choices: [],
    state: {
      chat: { busy: false, queued: 0, steering: 0, model: 'test/model' },
      background: { busy: false, queued: 0, steering: 0, model: 'per-prompt' },
      held: 0,
    },
    channels: [],
  };
}

export async function until(check: () => boolean, what = 'the condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}
