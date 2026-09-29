import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  type Component,
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
  Text,
} from '@earendil-works/pi-tui';
import { dim, gray, italic, red } from './style.ts';

/**
 * The model's reply: its text as Markdown, drawn by Pi's renderer, and a line
 * of red when it stopped short. Thinking stays out of the way: /expand shows
 * it, and otherwise only the thinking under way shows, as one dim line that
 * goes once the model moves on. Its tool calls are rows of their own.
 */
export class AssistantReply implements Component {
  private readonly markdownTheme: MarkdownTheme;
  private readonly body = new Container();
  private message: AssistantMessage | null = null;
  private streaming = false;
  private showThinking: boolean;

  constructor(markdownTheme: MarkdownTheme, showThinking: boolean) {
    this.markdownTheme = markdownTheme;
    this.showThinking = showThinking;
  }

  update(message: AssistantMessage, streaming: boolean): void {
    this.message = message;
    this.streaming = streaming;
    this.rebuild();
  }

  setShowThinking(show: boolean): void {
    this.showThinking = show;
    this.rebuild();
  }

  invalidate(): void {
    this.body.invalidate();
  }

  render(width: number): string[] {
    return this.body.render(width);
  }

  private rebuild(): void {
    this.body.clear();
    const message = this.message;
    if (!message) return;
    const blocks: Component[] = [];
    message.content.forEach((part, index) => {
      if (part.type === 'text' && part.text.trim()) {
        blocks.push(new Markdown(part.text.trim(), 1, 0, this.markdownTheme));
      } else if (part.type === 'thinking') {
        if (this.showThinking && part.thinking.trim()) {
          blocks.push(
            new Markdown(part.thinking.trim(), 1, 0, this.markdownTheme, {
              color: gray,
              italic: true,
            }),
          );
        } else if (!this.showThinking && this.streaming && index === message.content.length - 1) {
          blocks.push(new Text(dim(italic('Thinking… (/expand)')), 1, 0));
        }
      }
    });
    const stopped = stopLine(message);
    if (stopped) blocks.push(new Text(red(stopped), 1, 0));
    blocks.forEach((block, index) => {
      if (index > 0) this.body.addChild(new Spacer(1));
      this.body.addChild(block);
    });
  }
}

/**
 * Why the reply stopped short, as Pi says it. A reply that called tools says
 * nothing: its failed calls show the error.
 */
function stopLine(message: AssistantMessage): string | null {
  if (message.stopReason === 'length') return 'Response was truncated before completion.';
  if (message.content.some((part) => part.type === 'toolCall')) return null;
  if (message.stopReason === 'aborted') {
    return message.errorMessage && message.errorMessage !== 'Request was aborted'
      ? message.errorMessage
      : 'Operation aborted';
  }
  if (message.stopReason === 'error') return `Error: ${message.errorMessage || 'Unknown error'}`;
  return null;
}
