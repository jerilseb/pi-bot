import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai';
import { type AgentSessionEvent, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { getCapabilities, Markdown, type RgbColor, Text, type TUI } from '@earendil-works/pi-tui';
import type { ChannelRef, PromptOrigin, SessionState } from '../contract.ts';
import { AssistantReply } from './assistant-reply.ts';
import { ChatLog } from './chat-log.ts';
import { CustomNote } from './custom-note.ts';
import { imageMarker, markedImages } from './pasted-images.ts';
import { dim, promptBand } from './style.ts';
import { ToolCall } from './tool-call.ts';
import type { ToolOutcome } from './tool-summary.ts';
import { UserPrompt } from './user-prompt.ts';

/**
 * The chat as the terminal shows it, kept short: a prompt beside a `❯` on a
 * band of background, each tool call one row saying what it came to, the
 * model's replies as Markdown, and the bot's notes as a line each. /expand
 * opens tool output, thinking and notes in full. It is drawn from the transcript on connect and from the chat
 * session's events as they stream, mapped the way Pi's interactive mode maps
 * them. Background runs are not shown here; what they send arrives as
 * deliveries.
 *
 * A message that someone typed in another channel is labelled with where it
 * came from, and a prompt the bot gave itself (a post-restart task, a job's
 * report) is one line saying what it was, not the envelope the agent read.
 */

export class ChatView {
  readonly container = new ChatLog();
  private readonly ui: TUI;
  private readonly markdownTheme = getMarkdownTheme();
  private streaming: AssistantReply | null = null;
  private readonly pendingTools = new Map<string, ToolCall>();
  /** Everything /expand opens and closes, besides the replies' thinking. */
  private readonly expandable: Array<{ setExpanded(expanded: boolean): void }> = [];
  private readonly replies: AssistantReply[] = [];
  private readonly prompts: UserPrompt[] = [];
  private band = promptBand(null, getCapabilities().trueColor);
  private expanded = false;
  /** Where the chat turn under way came from. */
  private turnOrigin: PromptOrigin | null = null;
  /** Input the core accepted that the transcript has yet to show, oldest first. */
  private readonly unseenInputs: Array<{ from: ChannelRef; text: string }> = [];
  private self: ChannelRef | null = null;

  constructor(ui: TUI) {
    this.ui = ui;
  }

  /** Input the chat has not shown yet: queued, or steering the turn under way. */
  get unseen(): ReadonlyArray<{ from: ChannelRef; text: string }> {
    return this.unseenInputs;
  }

  /** The channel this terminal is, so only others' messages are labelled. */
  setSelf(ref: ChannelRef): void {
    this.self = ref;
  }

  /** What the terminal said its background is, which the prompts' band is a shade of. */
  setTerminalBackground(background: RgbColor): void {
    this.band = promptBand(background, getCapabilities().trueColor);
    for (const prompt of this.prompts) prompt.setBand(this.band);
    this.ui.requestRender();
  }

  /** Draws the conversation afresh from a transcript. */
  load(history: AgentMessage[]): void {
    this.container.clear();
    this.expandable.length = 0;
    this.replies.length = 0;
    this.prompts.length = 0;
    this.pendingTools.clear();
    this.streaming = null;
    this.turnOrigin = null;
    this.unseenInputs.length = 0;
    const results = new Map<string, ToolCall>();
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

  /**
   * What the chat session is doing. Once nothing runs, waits or steers, input
   * the chat has not shown never will be: /abort dropped it, say.
   */
  state(state: SessionState): void {
    if (!state.busy && state.queued === 0 && state.steering === 0) this.unseenInputs.length = 0;
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
        tool.start();
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
    this.container.add('note', new Text(text, 1, 0));
    this.ui.requestRender();
  }

  /** Markdown the bot shows outside a turn: a command's answer, a background report. */
  markdown(text: string, color?: (text: string) => string): void {
    this.container.add(
      'note',
      new Markdown(text, 1, 0, this.markdownTheme, color ? { color } : undefined),
    );
    this.ui.requestRender();
  }

  /** Opens or closes every tool's full output, every note and every reply's thinking. */
  toggleExpanded(): boolean {
    this.expanded = !this.expanded;
    for (const component of this.expandable) component.setExpanded(this.expanded);
    for (const reply of this.replies) reply.setShowThinking(this.expanded);
    this.ui.requestRender();
    return this.expanded;
  }

  private addMessage(message: AgentMessage, origin: PromptOrigin | null): void {
    switch (message.role) {
      case 'user': {
        const text = userText(message.content);
        const internal = internalPromptSummary(text, origin);
        // Input a channel sent is the user's even in a turn the bot started
        // itself, as a message steered into a job's report is.
        const from = this.takeInput(text, internal !== null);
        if (internal && !from) {
          this.note(dim(`── ${internal} ──`));
          return;
        }
        const label = from && from.id !== this.self?.id ? channelName(from) : null;
        const prompt = new UserPrompt(text, label, this.band);
        this.prompts.push(prompt);
        this.container.add('prompt', prompt);
        return;
      }
      case 'custom': {
        if (!message.display) return;
        const note = new CustomNote(message);
        note.setExpanded(this.expanded);
        this.expandable.push(note);
        this.container.add('note', note);
        return;
      }
      case 'compactionSummary':
        this.note(dim('📦 Earlier conversation compacted into a summary.'));
        return;
      default:
        return;
    }
  }

  private addAssistant(message?: AssistantMessage): AssistantReply {
    const reply = new AssistantReply(this.markdownTheme, this.expanded);
    if (message) reply.update(message, false);
    this.replies.push(reply);
    this.container.add('reply', reply);
    return reply;
  }

  private addTool(name: string, id: string, args: unknown): ToolCall {
    const tool = new ToolCall(name, args);
    tool.setExpanded(this.expanded);
    this.expandable.push(tool);
    this.container.add('tool', tool);
    this.pendingTools.set(id, tool);
    return tool;
  }

  private startStreaming(message: AssistantMessage): void {
    this.streaming = this.addAssistant();
    this.streaming.update(message, true);
  }

  /** Also starts one: a terminal that connects mid-reply first hears it as an update. */
  private updateStreaming(message: AssistantMessage): void {
    if (!this.streaming) this.streaming = this.addAssistant();
    this.streaming.update(message, true);
    for (const content of message.content) {
      if (content.type !== 'toolCall') continue;
      const tool = this.pendingTools.get(content.id);
      if (tool) tool.updateArgs(content.arguments);
      else this.addTool(content.name, content.id, content.arguments);
    }
  }

  private endStreaming(message: AssistantMessage): void {
    const streaming = this.streaming ?? this.addAssistant();
    streaming.update(message, false);
    this.streaming = null;
    if (message.stopReason !== 'aborted' && message.stopReason !== 'error') return;
    for (const tool of this.pendingTools.values()) tool.updateResult(errorResult(message));
    this.pendingTools.clear();
  }

  /**
   * Where the message came from, if the core said: the first unseen input it
   * ends with. An input of files alone has no text, which every message ends
   * with, so it cannot claim one that reads as the bot's own prompt.
   */
  private takeInput(text: string, internal: boolean): ChannelRef | null {
    const index = this.unseenInputs.findIndex(
      (input) => (!internal || input.text !== '') && text.trimEnd().endsWith(input.text),
    );
    if (index === -1) return null;
    const [input] = this.unseenInputs.splice(0, index + 1).slice(-1);
    return input?.from ?? null;
  }
}

export function channelName(ref: ChannelRef): string {
  return ref.kind === 'telegram' ? 'Telegram' : `terminal ${ref.id.replace(/^tui:/, '#')}`;
}

/**
 * A user message's text, its images named `[Image N]` as the terminal pastes
 * them: by the markers the text already has, and in front of it for any it
 * does not, as a photo from Telegram, so the text still ends as it was sent.
 */
function userText(content: string | Array<TextContent | ImageContent>): string {
  if (typeof content === 'string') return content;
  const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  const images = content.filter((part) => part.type === 'image').length;
  const marked = markedImages(text);
  const unmarked = Array.from({ length: images }, (_, i) => i + 1)
    .filter((n) => !marked.has(n))
    .map(imageMarker);
  return [...unmarked, text].filter(Boolean).join(' ');
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

function errorResult(message: AssistantMessage): ToolOutcome {
  const text =
    message.stopReason === 'aborted' ? 'Operation aborted' : message.errorMessage || 'Error';
  return { content: [{ type: 'text', text }], isError: true };
}
