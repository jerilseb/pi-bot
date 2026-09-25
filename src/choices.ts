import { randomUUID } from 'node:crypto';
import type {
  ChannelRef,
  ChoiceOutcome,
  ChoiceView,
  CoreEvent,
  RichText,
  SubmitResult,
} from './contract.ts';
import { errorMessage, summarizeError } from './util.ts';

/**
 * Menus, as the core keeps them: the lifecycle every menu shares, whichever
 * channel shows it and whoever answers.
 *
 * The same things happen in the same order for every tap: honour Cancel,
 * refuse while the bot cannot take the change (a busy chat, for the model and
 * reasoning menus), apply the option, and close the menu so it cannot be
 * answered twice. The first answer wins, from any channel, and every copy then
 * reads what the answer did. A menu supplies only the parts that differ.
 *
 * A menu that must keep working after a restart, as the /models and
 * /reasoning buttons do, has a stable ID and a definition: a tap on a copy
 * from before the restart rebuilds the menu from it. An ID may carry a
 * parameter after a dot (`reasoning.low-medium-high`), for a menu whose
 * options depend on something that can change.
 */

/** What a tap did: the toast for the one who tapped, and what every copy now reads. */
export interface ChoiceReply {
  toast: string;
  /** Plain text. */
  text: string;
  submitted?: SubmitResult;
}

export interface ChoiceSpec {
  /** A stable ID, for a menu with a definition. Otherwise one is made up. */
  id?: string;
  /** Plain text above the options. */
  text: string;
  options: Array<{ label: string }>;
  columns?: number;
  cancellable: boolean;
  /** What the menu reads once cancelled, when it has no cancel(). */
  cancelText?: string;
  /** What the menu reads when the option tapped is stale or unknown. */
  unknownOptionText: string;
  /** Toast when select throws; the menu gets the error itself. */
  failureToast: string;
  /** What the menu reads when answered after it expired. */
  expiredText?: string;
  expiresAt?: number;
  audience: 'all' | ChannelRef;
  /** Checked after Cancel and before select. A reply refuses the tap with it. */
  refuse?(): ChoiceReply | null;
  /** Applies option `index`. Null means the option is stale or unknown. */
  select(index: number, by: ChannelRef): Promise<ChoiceReply | null>;
  cancel?(by: ChannelRef): Promise<ChoiceReply>;
}

/** Rebuilds a menu with a stable ID, for the one who tapped it. Null when the parameter is unusable. */
export type ChoiceDefinition = (param: string | undefined, by: ChannelRef) => ChoiceSpec | null;

type OpenChoice = ChoiceSpec & { id: string };

/** How long an expired menu is kept, so a late tap says it expired rather than that it is gone. */
const EXPIRED_RETAIN_MS = 24 * 60 * 60_000;

export class ChoiceRegistry {
  private readonly open = new Map<string, OpenChoice>();
  private readonly definitions = new Map<string, ChoiceDefinition>();
  private readonly emit: (event: CoreEvent) => void;
  private readonly now: () => number;

  constructor(emit: (event: CoreEvent) => void, now: () => number = Date.now) {
    this.emit = emit;
    this.now = now;
  }

  /** Registers how the menus whose ID is `name`, or starts `name.`, are rebuilt. */
  define(name: string, build: ChoiceDefinition): void {
    this.definitions.set(name, build);
  }

  /** Opens a menu and returns it as channels show it. An open menu with the same ID is replaced. */
  add(spec: ChoiceSpec): ChoiceView {
    this.prune();
    const id = spec.id ?? randomUUID().replace(/-/g, '').slice(0, 12);
    const choice: OpenChoice = { ...spec, id };
    this.open.set(id, choice);
    return view(choice);
  }

  /** Forgets a menu that could not be shown anywhere. */
  remove(id: string): void {
    this.open.delete(id);
  }

  views(): ChoiceView[] {
    this.prune();
    return [...this.open.values()].map(view);
  }

  async choose(id: string, option: number | 'cancel', by: ChannelRef): Promise<ChoiceOutcome> {
    this.prune();
    // Taken before anything is awaited, so a second tap finds nothing to answer.
    const open = this.open.get(id);
    if (open) this.open.delete(id);
    const choice = open ?? this.rebuild(id, by);
    if (!choice) {
      return {
        toast: 'Menu expired.',
        text: plain('⏱ This menu is no longer available.'),
        closed: false,
      };
    }
    const reply = await this.answer(choice, option, by);
    const text = plain(reply.text);
    this.emit({ type: 'choice_closed', choiceId: id, text, by });
    return {
      toast: reply.toast,
      text,
      closed: true,
      ...(reply.submitted ? { submitted: reply.submitted } : {}),
    };
  }

  private async answer(
    choice: OpenChoice,
    option: number | 'cancel',
    by: ChannelRef,
  ): Promise<ChoiceReply> {
    if (choice.expiresAt !== undefined && choice.expiresAt <= this.now()) {
      return { toast: 'Menu expired.', text: choice.expiredText ?? '⏱ This menu has expired.' };
    }
    const unknown = { toast: 'Unknown option.', text: choice.unknownOptionText };
    try {
      if (option === 'cancel') {
        if (!choice.cancellable) return unknown;
        return choice.cancel
          ? await choice.cancel(by)
          : { toast: 'Cancelled', text: choice.cancelText ?? 'Cancelled.' };
      }
      const refused = choice.refuse?.();
      if (refused) return refused;
      if (!Number.isInteger(option) || option < 0 || option >= choice.options.length) {
        return unknown;
      }
      return (await choice.select(option, by)) ?? unknown;
    } catch (error) {
      return { toast: choice.failureToast, text: `❌ ${summarizeError(errorMessage(error))}` };
    }
  }

  private rebuild(id: string, by: ChannelRef): OpenChoice | null {
    const dot = id.indexOf('.');
    const name = dot < 0 ? id : id.slice(0, dot);
    const param = dot < 0 ? undefined : id.slice(dot + 1);
    const spec = this.definitions.get(name)?.(param, by);
    return spec ? { ...spec, id } : null;
  }

  private prune(): void {
    const cutoff = this.now() - EXPIRED_RETAIN_MS;
    for (const [id, choice] of this.open) {
      if (choice.expiresAt !== undefined && choice.expiresAt <= cutoff) this.open.delete(id);
    }
  }
}

function view(choice: OpenChoice): ChoiceView {
  return {
    id: choice.id,
    text: plain(choice.text),
    options: choice.options.map((option) => option.label),
    columns: choice.columns ?? 1,
    cancellable: choice.cancellable,
    ...(choice.expiresAt !== undefined ? { expiresAt: choice.expiresAt } : {}),
    audience: choice.audience,
  };
}

function plain(text: string): RichText {
  return { format: 'plain', text };
}
