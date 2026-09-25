import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai';
import {
  type AgentSessionEvent,
  AssistantMessageComponent,
  CustomMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  type MarkdownTransformer,
  type Theme,
  ToolExecutionComponent,
  UserMessageComponent,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Container,
  Markdown,
  Spacer,
  Text,
  type TUI,
} from '@earendil-works/pi-tui';
import type { ChannelRef, PromptOrigin } from '../contract.ts';
import { formatFirstToolArgument } from '../tool-call-description.ts';
import { dim, italic } from './style.ts';
import { telegramHtmlToMarkdown } from './telegram-html.ts';

/**
 * The chat as the terminal shows it: the conversation drawn with Pi's own
 * components, the way Pi's interactive mode draws a session, from the
 * transcript on connect and from the chat session's events as they stream.
 * Background runs are not shown here; what they send arrives as deliveries.
 *
 * A message that someone typed in another channel is labelled with where it
 * came from, and a prompt the bot gave itself (a post-restart task, a job's
 * report) is one line saying what it was, not the envelope the agent read.
 */

type ToolRenderers = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;

const BUILT_IN_TOOLS: Record<string, (cwd: string) => ToolRenderers> = {
  bash: createBashToolDefinition,
  read: createReadToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

/** Model replies are Telegram HTML until they switch to Markdown. */
const replyTransformer: MarkdownTransformer = (text, context) =>
  context.messageType === 'assistant'
    ? telegramHtmlToMarkdown(text, { streaming: context.isStreaming })
    : text;

const TOOL_ARGUMENT_WIDTH = 100;

export class ChatView {
  readonly container = new Container();
  private readonly ui: TUI;
  private readonly cwd: string;
  private readonly markdownTheme = getMarkdownTheme();
  private readonly toolRenderers = new Map<string, ToolRenderers>();
  private streaming: AssistantMessageComponent | null = null;
  private readonly pendingTools = new Map<string, ToolExecutionComponent>();
  /** Everything /expand opens and closes. */
  private readonly expandable: Array<{ setExpanded(expanded: boolean): void }> = [];
  private readonly assistants: AssistantMessageComponent[] = [];
  private expanded = false;
  /** Where the chat turn under way came from. */
  private turnOrigin: PromptOrigin | null = null;
  /** Input the core accepted that the transcript has yet to show, oldest first. */
  private readonly unseenInputs: Array<{ from: ChannelRef; text: string }> = [];
  private self: ChannelRef | null = null;

  constructor(ui: TUI, cwd: string) {
    this.ui = ui;
    this.cwd = cwd;
  }

  /** Input the chat has not shown yet: queued, or steering the turn under way. */
  get unseen(): ReadonlyArray<{ from: ChannelRef; text: string }> {
    return this.unseenInputs;
  }

  /** The channel this terminal is, so only others' messages are labelled. */
  setSelf(ref: ChannelRef): void {
    this.self = ref;
  }

  /** Draws the conversation afresh from a transcript. */
  load(history: AgentMessage[]): void {
    this.container.clear();
    this.expandable.length = 0;
    this.assistants.length = 0;
    this.pendingTools.clear();
    this.streaming = null;
    this.turnOrigin = null;
    this.unseenInputs.length = 0;
    const results = new Map<string, ToolExecutionComponent>();
    for (const message of history) {
      if (message.role === 'assistant') {
        this.addAssistant(message);
        for (const content of message.content) {
          if (content.type !== 'toolCall') continue;
          const tool = this.addTool(content.name, content.id, content.arguments);
          if (message.stopReason === 'aborted' || message.stopReason === 'error') {
            tool.updateResult(errorResult(message));
          } else {
            results.set(content.id, tool);
          }
        }
      } else if (message.role === 'toolResult') {
        results.get(message.toolCallId)?.updateResult(message);
        results.delete(message.toolCallId);
      } else {
        this.addMessage(message, null);
      }
    }
    this.ui.requestRender();
  }

  /** /new started a fresh conversation. */
  reset(): void {
    this.unseenInputs.length = 0;
    this.note(dim('── New conversation ──'));
  }

  input(from: ChannelRef, text: string): void {
    this.unseenInputs.push({ from, text: text.trim() });
  }

  turnStart(origin: PromptOrigin): void {
    this.turnOrigin = origin;
  }

  turnEnd(): void {
    this.turnOrigin = null;
    this.streaming = null;
    this.pendingTools.clear();
  }

  /** One event of the chat session, drawn the way Pi's interactive mode draws it. */
  agentEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') this.startStreaming(event.message);
        else this.addMessage(event.message, this.turnOrigin);
        break;
      case 'message_update':
        if (event.message.role === 'assistant') this.updateStreaming(event.message);
        break;
      case 'message_end':
        if (event.message.role === 'assistant') this.endStreaming(event.message);
        break;
      case 'tool_execution_start': {
        const tool =
          this.pendingTools.get(event.toolCallId) ??
          this.addTool(event.toolName, event.toolCallId, event.args);
        tool.markExecutionStarted();
        break;
      }
      case 'tool_execution_update':
        this.pendingTools
          .get(event.toolCallId)
          ?.updateResult({ ...event.partialResult, isError: false }, true);
        break;
      case 'tool_execution_end':
        this.pendingTools
          .get(event.toolCallId)
          ?.updateResult({ ...event.result, isError: event.isError });
        this.pendingTools.delete(event.toolCallId);
        break;
      case 'agent_end':
        this.streaming = null;
        this.pendingTools.clear();
        break;
      case 'compaction_start':
        this.note(dim('📦 Compacting the conversation…'));
        break;
      case 'compaction_end':
        if (event.errorMessage) this.note(dim(`📦 Compaction failed: ${event.errorMessage}`));
        break;
      case 'auto_retry_start':
        this.note(
          dim(`🔄 Retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`),
        );
        break;
      default:
        return;
    }
    this.ui.requestRender();
  }

  /** A line of the bot's own, such as a notice or what a menu now reads. */
  note(text: string): void {
    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(text, 1, 0));
    this.ui.requestRender();
  }

  /** The bot's own Markdown: a command's answer, a background report. */
  markdown(text: string, color?: (text: string) => string): void {
    this.container.addChild(new Spacer(1));
    this.container.addChild(
      new Markdown(text, 1, 0, this.markdownTheme, color ? { color } : undefined),
    );
    this.ui.requestRender();
  }

  /** A report's text, which is Telegram HTML like a reply. */
  html(text: string): void {
    this.markdown(telegramHtmlToMarkdown(text));
  }

  /** Opens or closes every tool's full output and every hidden thinking block. */
  toggleExpanded(): boolean {
    this.expanded = !this.expanded;
    for (const component of this.expandable) component.setExpanded(this.expanded);
    for (const assistant of this.assistants) assistant.setHideThinkingBlock(!this.expanded);
    this.ui.requestRender();
    return this.expanded;
  }

  private addMessage(message: AgentMessage, origin: PromptOrigin | null): void {
    switch (message.role) {
      case 'user': {
        const text = userText(message.content);
        const internal = internalPromptSummary(text, origin);
        if (internal) {
          this.note(dim(`⚙ ${internal}`));
          return;
        }
        const from = this.takeInput(text);
        this.container.addChild(new Spacer(1));
        if (from && from.id !== this.self?.id) {
          this.container.addChild(new Text(dim(italic(`From ${channelName(from)}:`)), 1, 0));
        }
        this.container.addChild(new UserMessageComponent(text, this.markdownTheme));
        return;
      }
      case 'custom': {
        if (!message.display) return;
        const component = new CustomMessageComponent(message, undefined, this.markdownTheme);
        component.setExpanded(this.expanded);
        this.expandable.push(component);
        this.container.addChild(component);
        return;
      }
      case 'compactionSummary':
        this.note(dim('📦 Earlier conversation compacted into a summary.'));
        return;
      default:
        return;
    }
  }

  private addAssistant(message?: AssistantMessage): AssistantMessageComponent {
    const component = new AssistantMessageComponent(
      message,
      !this.expanded,
      this.markdownTheme,
      'Thinking… (/expand)',
      undefined,
      [replyTransformer],
    );
    this.assistants.push(component);
    this.container.addChild(component);
    return component;
  }

  private addTool(name: string, id: string, args: unknown): ToolExecutionComponent {
    const tool = new ToolExecutionComponent(
      name,
      id,
      args,
      { showImages: false },
      this.renderersFor(name),
      this.ui,
      this.cwd,
    );
    tool.setExpanded(this.expanded);
    this.expandable.push(tool);
    this.container.addChild(tool);
    this.pendingTools.set(id, tool);
    return tool;
  }

  private startStreaming(message: AssistantMessage): void {
    this.streaming = this.addAssistant();
    this.streaming.updateContent(message, true);
  }

  /** Also starts one: a terminal that connects mid-reply first hears it as an update. */
  private updateStreaming(message: AssistantMessage): void {
    if (!this.streaming) this.streaming = this.addAssistant();
    this.streaming.updateContent(message, true);
    for (const content of message.content) {
      if (content.type !== 'toolCall') continue;
      const tool = this.pendingTools.get(content.id);
      if (tool) tool.updateArgs(content.arguments);
      else this.addTool(content.name, content.id, content.arguments);
    }
  }

  private endStreaming(message: AssistantMessage): void {
    const streaming = this.streaming ?? this.addAssistant();
    streaming.updateContent(message, false);
    this.streaming = null;
    const failed = message.stopReason === 'aborted' || message.stopReason === 'error';
    for (const tool of this.pendingTools.values()) {
      if (failed) tool.updateResult(errorResult(message));
      else tool.setArgsComplete();
    }
    if (failed) this.pendingTools.clear();
  }

  /** Where the message came from, if the core said: the first unseen input it ends with. */
  private takeInput(text: string): ChannelRef | null {
    const index = this.unseenInputs.findIndex((input) => text.trimEnd().endsWith(input.text));
    if (index === -1) return null;
    const [input] = this.unseenInputs.splice(0, index + 1).slice(-1);
    return input?.from ?? null;
  }

  /** Pi's renderers for its own tools; the tool and its first argument for the rest. */
  private renderersFor(name: string): ToolRenderers {
    let renderers = this.toolRenderers.get(name);
    if (!renderers) {
      renderers = BUILT_IN_TOOLS[name]?.(this.cwd) ?? {
        renderCall: (args: unknown, theme: Theme): Component => {
          const argument = formatFirstToolArgument(args);
          const shown =
            argument && argument.length > TOOL_ARGUMENT_WIDTH
              ? `${argument.slice(0, TOOL_ARGUMENT_WIDTH - 1)}…`
              : argument;
          return new Text(
            `${theme.fg('toolTitle', theme.bold(name))}${shown ? ` ${theme.fg('muted', shown)}` : ''}`,
            0,
            0,
          );
        },
      };
      this.toolRenderers.set(name, renderers);
    }
    return renderers;
  }
}

export function channelName(ref: ChannelRef): string {
  return ref.kind === 'telegram' ? 'Telegram' : `terminal ${ref.id.replace(/^tui:/, '#')}`;
}

function userText(content: string | Array<TextContent | ImageContent>): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : `🖼 image (${part.mimeType})`))
    .join('\n');
}

/**
 * What a prompt the bot gave itself was, in one line: known from the turn's
 * origin as it happens, and from the envelope's opening line in a transcript.
 */
export function internalPromptSummary(text: string, origin: PromptOrigin | null): string | null {
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  const report = /^\[(?:background-bash-report|subagent-report)\] (.+)$/.exec(first);
  if (report?.[1]) return report[1];
  if (origin?.kind === 'post-restart' || /^This is a post-restart task\b/.test(first)) {
    return 'Post-restart task';
  }
  if (/^This is a scheduled (?:heartbeat|task) run\b/.test(first)) return 'Scheduled run';
  if (origin && origin.kind !== 'user') return first || origin.kind;
  return null;
}

function errorResult(message: AssistantMessage): {
  content: Array<{ type: string; text: string }>;
  isError: true;
} {
  const text =
    message.stopReason === 'aborted' ? 'Operation aborted' : message.errorMessage || 'Error';
  return { content: [{ type: 'text', text }], isError: true };
}
