import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import {
  CombinedAutocompleteProvider,
  Container,
  matchesKey,
  Spacer,
  type Terminal,
  Text,
  type TUI,
  TuiMainScreen,
} from '@earendil-works/pi-tui';
import type { Welcome } from '../channels/socket/protocol.ts';
import { MAX_QUEUED_PROMPTS } from '../config.ts';
import type {
  Channel,
  ChannelCaps,
  ChannelRef,
  ChoiceView,
  CommandInfo,
  CoreEvent,
  CoreState,
  Deliverable,
  JobStopOutcome,
  Receipt,
  RichText,
  SubmitResult,
} from '../contract.ts';
import { escapeMarkdown } from '../markdown.ts';
import type { Attachment } from '../types.ts';
import { errorMessage } from '../util.ts';
import { ChatView } from './chat-view.ts';
import { type FooterState, footerLine } from './footer.ts';
import { JobsWidget, jobSummary } from './jobs.ts';
import { Picker } from './picker.ts';
import { RemoteCore } from './remote-core.ts';
import { cyan, dim, levelColor, red, yellow } from './style.ts';
import { WorkingEditor } from './working-editor.ts';

/**
 * The terminal UI: a channel of the agent core like Telegram, reached through
 * the bot's socket, drawn with Pi's TUI in the terminal's main screen, so its
 * scrollback is the terminal's own.
 *
 * It shows the whole chat as it happens, whichever channel the input came
 * from: replies streaming, tool calls with their output, notes. What a
 * background run sends arrives as deliveries, as it does in Telegram. Menus
 * take the editor's place and are answered from the keyboard; the first
 * answer from any channel closes every copy. It rings the terminal bell for
 * what alerts it: a reply to what it sent, or anything unprompted while it is
 * the channel used last, but not for the answer to a command typed here.
 *
 * Its own commands are handled here before anything reaches the core: /quit,
 * /expand, /jobs, and /attach for files, which it can name by path since it
 * shares the bot's filesystem.
 */

interface TerminalCommand extends CommandInfo {
  run(app: TerminalApp, args: string): void;
}

const TERMINAL_COMMANDS: TerminalCommand[] = [
  {
    name: 'attach',
    description: 'Attach a file to your next message',
    help: 'attach a local file to your next message; with no path, drop what is attached',
    run: (app, args) => app.attach(args),
  },
  {
    name: 'jobs',
    description: 'Stop a running job',
    help: 'pick a running command or sub-agent task to stop',
    run: (app) => app.pickJobToStop(),
  },
  {
    name: 'expand',
    description: 'Show or hide full tool output and thinking',
    help: 'show or hide full tool output and thinking in this terminal',
    run: (app) => app.toggleExpanded(),
  },
  {
    name: 'quit',
    description: 'Close this terminal',
    help: 'close this terminal; the bot keeps running',
    run: (app) => app.quit(),
  },
];

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface TerminalAppOptions {
  terminal: Terminal;
  /** Opens a connection to the bot's socket. */
  connect: () => Promise<Duplex>;
  /** For tool renderers and /attach paths. */
  cwd: string;
  onQuit: () => void;
}

export class TerminalApp implements Channel {
  readonly caps: ChannelCaps = {
    buttons: true,
    edits: true,
    files: true,
    voice: false,
    durable: false,
  };
  readonly commands: readonly CommandInfo[] = TERMINAL_COMMANDS.map(
    ({ run: _run, ...info }) => info,
  );

  private readonly core: RemoteCore;
  private readonly tui: TUI;
  private readonly cwd: string;
  private readonly onQuit: () => void;
  private readonly chat: ChatView;
  private readonly jobs: JobsWidget;
  private readonly pending = new Text('', 1, 0);
  private readonly inputArea = new Container();
  /** Shows the chat working in its top border, whichever channel the turn came from. */
  private readonly editor: WorkingEditor;
  private readonly footer = new Text('', 1, 0);
  private detach: (() => void) | null = null;
  private footerState: FooterState = {
    connection: { status: 'connecting' },
    state: null,
    channels: [],
    self: null,
    jobs: 0,
  };
  private everConnected = false;
  private busy = false;
  /** Core menus waiting their turn in the input area, oldest first; the first is open. */
  private menus: ChoiceView[] = [];
  /** The menu open in the input area, or null for the editor. */
  private open: { id: string | null; picker: Picker } | null = null;
  private staged: Attachment[] = [];
  /** Commands sent from here that have yet to answer: what they send is expected, not rung for. */
  private commandsInFlight = 0;

  constructor(options: TerminalAppOptions) {
    this.cwd = options.cwd;
    this.onQuit = options.onQuit;
    this.tui = new TuiMainScreen(options.terminal);
    this.chat = new ChatView(this.tui, this.cwd);
    this.jobs = new JobsWidget(this.tui);
    this.editor = new WorkingEditor(this.tui, {
      borderColor: dim,
      selectList: getSelectListTheme(),
    });
    this.editor.onSubmit = (text) => this.submitLine(text);
    this.core = new RemoteCore({
      connect: options.connect,
      onConnect: (welcome) => this.connected(welcome),
      onDisconnect: (reason, retryInMs) => this.disconnected(reason, retryInMs),
    });

    this.tui.addChild(this.chat.container);
    this.tui.addChild(this.jobs);
    this.tui.addChild(this.pending);
    // A margin between the chat and the editor, or a menu in its place.
    this.tui.addChild(new Spacer(1));
    this.tui.addChild(this.inputArea);
    this.tui.addChild(this.footer);
    this.inputArea.addChild(this.editor);
    this.tui.addInputListener((data) => this.handleKey(data));
    this.refreshFooter();
  }

  /** The channel the bot attached this terminal as; a placeholder until it has. */
  get ref(): ChannelRef {
    return this.core.ref ?? { id: 'tui', kind: 'tui' };
  }

  start(): void {
    this.tui.setFocus(this.editor);
    this.tui.start();
    this.detach = this.core.attach(this);
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
    this.editor.setWorking(false);
    this.jobs.dispose();
    this.tui.stop();
  }

  onEvent(event: CoreEvent): void {
    switch (event.type) {
      case 'input':
        this.chat.input(event.from, event.text);
        break;
      case 'turn_start':
        if (event.session === 'chat') this.chat.turnStart(event.origin);
        break;
      case 'agent':
        if (event.session === 'chat') this.chat.agentEvent(event.event);
        break;
      case 'turn_end':
        if (event.session !== 'chat') break;
        this.chat.turnEnd();
        if (event.outcome === 'error') this.chat.note(red(`❌ ${event.error}`));
        this.ringIfPinged(event.ping);
        break;
      case 'job':
        this.jobs.update(event.job, event.final === true);
        if (event.final) this.chat.note(dim(jobSummary(event.job, Date.now())));
        break;
      case 'choice_closed':
        this.closeMenu(event.choiceId);
        this.show(event.text, dim);
        break;
      case 'notice':
        this.show(event.text, levelColor(event.level));
        this.ringIfPinged(event.ping);
        break;
      case 'state':
        this.setState(event.state);
        break;
      case 'reset':
        this.chat.reset();
        break;
      case 'channels':
        this.footerState.channels = event.attached;
        break;
    }
    this.refreshPending();
    this.refreshFooter();
  }

  async deliver(item: Deliverable): Promise<Receipt> {
    switch (item.kind) {
      case 'report':
        this.chat.note(cyan(reportTitle(item)));
        this.show(item.text);
        break;
      case 'image':
      case 'document':
        this.chat.note(
          `${item.kind === 'image' ? '🖼' : '📄'} ${item.path}${item.caption ? dim(` · ${item.caption}`) : ''}`,
        );
        break;
      case 'voice':
        this.chat.note(`🔊 ${item.text}${item.path ? dim(` (${item.path})`) : ''}`);
        break;
      case 'choice':
        this.queueMenu(item.choice);
        break;
    }
    this.ringIfPinged(item.ping);
    return { channel: this.ref, ok: true };
  }

  async drain(): Promise<void> {}

  attach(args: string): void {
    const target = args.trim();
    if (!target) {
      this.staged = [];
      this.chat.note(dim('📎 Nothing attached.'));
      this.refreshPending();
      return;
    }
    const resolved = path.resolve(this.cwd, target.replace(/^~(?=$|\/)/, os.homedir()));
    let size: number;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) throw new Error('not a file');
      size = stat.size;
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      this.chat.note(
        red(`❌ Cannot attach ${resolved}: ${missing ? 'no such file' : errorMessage(error)}`),
      );
      return;
    }
    const mimeType = IMAGE_TYPES[path.extname(resolved).toLowerCase()];
    this.staged.push({
      type: mimeType ? 'image' : 'file',
      path: resolved,
      filename: path.basename(resolved),
      size,
      ...(mimeType ? { mimeType } : {}),
    });
    this.refreshPending();
  }

  pickJobToStop(): void {
    const stoppable = this.jobs.stoppable();
    if (stoppable.length === 0) {
      this.chat.note(dim('No jobs running.'));
      return;
    }
    this.showPicker(null, {
      title: 'Stop which job?',
      options: stoppable.map((job) => job.label),
      cancellable: true,
      onSelect: (index) => {
        this.closePicker();
        const job = stoppable[index];
        if (!job) return;
        this.core
          .stopJob(job.jobId, job.task)
          .then((outcome) => this.chat.note(dim(stopToast(outcome))))
          .catch((error: unknown) => this.chat.note(red(`❌ ${errorMessage(error)}`)));
      },
      onCancel: () => this.closePicker(),
    });
  }

  toggleExpanded(): void {
    const expanded = this.chat.toggleExpanded();
    this.chat.note(dim(expanded ? 'Showing full tool output and thinking.' : 'Folded again.'));
  }

  quit(): void {
    this.onQuit();
  }

  private connected(welcome: Welcome): void {
    const { snapshot } = welcome;
    this.chat.setSelf(welcome.ref);
    this.chat.load(snapshot.history);
    this.chat.note(
      dim(
        `${this.everConnected ? 'Reconnected' : 'Connected'} to the bot as ${welcome.ref.id}. /help lists the commands; Esc stops a reply.`,
      ),
    );
    this.everConnected = true;
    this.jobs.load(snapshot.jobs);
    this.footerState = {
      connection: { status: 'connected' },
      state: snapshot.state,
      channels: snapshot.channels,
      self: welcome.ref,
      jobs: this.jobs.size,
    };
    this.setState(snapshot.state);
    this.menus = [];
    this.closePicker();
    for (const choice of snapshot.choices) {
      if (choice.audience === 'all' || choice.audience.id === welcome.ref.id)
        this.queueMenu(choice);
    }
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        welcome.commands.map(({ name, description }) => ({ name, description })),
        this.cwd,
      ),
    );
    this.refreshPending();
    this.refreshFooter();
  }

  private disconnected(reason: string, retryInMs: number): void {
    if (this.footerState.connection.status === 'connected') {
      this.chat.note(yellow(`⚠ Lost the connection to the bot: ${reason}`));
    }
    this.footerState = { ...this.footerState, connection: { status: 'lost', retryInMs } };
    this.setBusy(false);
    // Whatever was open belongs to a connection that is gone; the next snapshot reopens it.
    this.menus = [];
    this.closePicker();
    this.refreshFooter();
  }

  private submitLine(text: string): void {
    const line = text.trim();
    if (!line && this.staged.length === 0) return;
    this.editor.addToHistory(text);
    const [first = ''] = line.split(/\s+/, 1);
    const own = TERMINAL_COMMANDS.find((command) => `/${command.name}` === first.toLowerCase());
    if (own) {
      own.run(this, line.slice(first.length));
      return;
    }
    // With a file attached, a line starting with a slash is its caption, as in Telegram.
    if (line.startsWith('/') && this.staged.length === 0) {
      this.runCommand(line)
        .then((handled) => {
          if (!handled) this.submitText(text);
        })
        .catch((error: unknown) => this.failed(text, error));
      return;
    }
    this.submitText(text);
  }

  private async runCommand(line: string): Promise<boolean> {
    this.commandsInFlight++;
    try {
      return await this.core.command(line, this.ref);
    } finally {
      this.commandsInFlight--;
    }
  }

  private submitText(text: string): void {
    const attachments = this.staged;
    this.staged = [];
    this.refreshPending();
    this.core
      .submit({ from: this.ref, text, attachments })
      .then((result) => this.showSubmitResult(result, text, attachments))
      .catch((error: unknown) => {
        this.staged = attachments;
        this.failed(text, error);
      });
  }

  /** A message that did not reach the bot goes back in the editor, so it is not lost. */
  private failed(text: string, error: unknown): void {
    this.chat.note(red(`❌ ${errorMessage(error)}`));
    if (!this.editor.getText().trim()) this.editor.setText(text);
    this.refreshPending();
  }

  private showSubmitResult(result: SubmitResult, text: string, attachments: Attachment[]): void {
    if (result.status === 'steered') {
      this.chat.note(dim('↪️ Steering the task under way.'));
      return;
    }
    if (result.status !== 'rejected') return;
    switch (result.reason) {
      case 'queue-full':
        this.chat.note(yellow(`⚠️ Queue full (${MAX_QUEUED_PROMPTS} pending). Wait, or /abort.`));
        break;
      case 'error':
        this.chat.note(red(`❌ ${result.error}`));
        break;
      case 'shutting-down':
        this.chat.note(yellow('The bot is shutting down; send it again once it is back.'));
        break;
      case 'stale':
        return;
    }
    this.staged = attachments;
    if (!this.editor.getText().trim()) this.editor.setText(text);
    this.refreshPending();
  }

  /** Ctrl+C clears the editor, or quits from an empty one; Esc stops a reply. */
  private handleKey(data: string): { consume: boolean } | undefined {
    if (matchesKey(data, 'ctrl+c')) {
      if (this.open) this.open.picker.handleInput('\x1b');
      else if (this.editor.getText()) this.editor.setText('');
      else this.quit();
      return { consume: true };
    }
    if (matchesKey(data, 'ctrl+d') && !this.open && !this.editor.getText()) {
      this.quit();
      return { consume: true };
    }
    if (
      matchesKey(data, 'escape') &&
      !this.open &&
      this.busy &&
      !this.editor.isShowingAutocomplete()
    ) {
      this.runCommand('/abort').catch((error: unknown) => {
        this.chat.note(red(`❌ ${errorMessage(error)}`));
      });
      return { consume: true };
    }
    return undefined;
  }

  private queueMenu(choice: ChoiceView): void {
    if (this.menus.some((menu) => menu.id === choice.id)) return;
    this.menus.push(choice);
    if (!this.open) this.openNextMenu();
  }

  private openNextMenu(): void {
    const choice = this.menus[0];
    if (!choice) return;
    this.showPicker(choice.id, {
      title: choice.text.text,
      options: choice.options,
      cancellable: choice.cancellable,
      onSelect: (index) => this.choose(choice, index),
      onCancel: () => {
        if (choice.cancellable) this.choose(choice, 'cancel');
        else this.dismissMenu(choice.id);
      },
    });
  }

  private choose(choice: ChoiceView, option: number | 'cancel'): void {
    this.closeMenu(choice.id);
    this.core
      .choose(choice.id, option, this.ref)
      .then((outcome) => {
        // A menu the core had forgotten closes nowhere else, so its text shows here.
        if (!outcome.closed) this.show(outcome.text, dim);
        if (outcome.submitted) this.showSubmitResult(outcome.submitted, '', []);
      })
      .catch((error: unknown) => this.chat.note(red(`❌ ${errorMessage(error)}`)));
  }

  /** Escape on a menu without Cancel: out of the way, until the bot shows it again. */
  private dismissMenu(id: string): void {
    this.closeMenu(id);
    this.chat.note(dim('Menu put away; it stays open for Telegram and other terminals.'));
  }

  private closeMenu(id: string): void {
    this.menus = this.menus.filter((menu) => menu.id !== id);
    if (this.open?.id === id) {
      this.closePicker();
      this.openNextMenu();
    }
  }

  private showPicker(id: string | null, options: ConstructorParameters<typeof Picker>[0]): void {
    this.closePicker();
    const picker = new Picker(options);
    this.open = { id, picker };
    this.inputArea.clear();
    this.inputArea.addChild(picker);
    this.tui.setFocus(picker);
    this.tui.requestRender();
  }

  private closePicker(): void {
    if (!this.open) return;
    this.open = null;
    this.inputArea.clear();
    this.inputArea.addChild(this.editor);
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  private show(text: RichText, color?: (text: string) => string): void {
    switch (text.format) {
      case 'plain':
        this.chat.markdown(escapeMarkdown(text.text), color);
        return;
      case 'markdown':
        this.chat.markdown(text.text, color);
        return;
      case 'telegram-html':
        this.chat.html(text.text);
        return;
    }
  }

  private setState(state: CoreState): void {
    this.footerState.state = state;
    this.setBusy(state.chat.busy);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.editor.setWorking(busy);
  }

  private refreshPending(): void {
    const lines = [
      ...this.chat.unseen.map(({ from, text }) =>
        dim(
          `⏳ ${from.id === this.ref.id ? '' : `${from.kind === 'telegram' ? '📱 ' : '🖥 '}`}${oneLine(text)}`,
        ),
      ),
      ...this.staged.map((attachment) => dim(`📎 ${attachment.filename ?? attachment.path}`)),
    ];
    this.pending.setText(lines.join('\n'));
    this.tui.requestRender();
  }

  private refreshFooter(): void {
    this.footerState.jobs = this.jobs.size;
    this.footer.setText(footerLine(this.footerState));
    this.tui.requestRender();
  }

  /** The bell, for what alerts this terminal; not for the answer to a command typed here. */
  private ringIfPinged(ping: ChannelRef[]): void {
    if (this.commandsInFlight > 0) return;
    if (ping.some((ref) => ref.id === this.core.ref?.id)) this.tui.terminal.write('\x07');
  }
}

function reportTitle(item: Extract<Deliverable, { kind: 'report' }>): string {
  const label = item.label ? ` · ${item.label}` : '';
  switch (item.origin.kind) {
    case 'cron':
      return `⏰ Scheduled report${label}`;
    case 'heartbeat':
      return `💓 Heartbeat${label}`;
    default:
      return `📬 Report${label}`;
  }
}

function stopToast(outcome: JobStopOutcome): string {
  switch (outcome) {
    case 'stopping':
      return 'Stopping…';
    case 'already-stopping':
      return 'Already stopping…';
    case 'not-running':
      return 'That job is no longer running.';
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}
