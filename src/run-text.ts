import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { PiPromptResult } from './types.ts';

/**
 * The text of a run's assistant messages, kept per message: narration before a
 * tool call and the answer after it are separate paragraphs rather than one run
 * of text, and the last message can be checked on its own for a sentinel.
 *
 * The sessions build their reply with it, and Telegram its draft of the reply
 * being written, so the draft grows into the message that replaces it.
 */
export class RunText {
  private messages: string[] = [];

  observe(event: AgentSessionEvent): void {
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      this.messages.push('');
    } else if (
      event.type === 'message_update' &&
      event.assistantMessageEvent.type === 'text_delta'
    ) {
      if (this.messages.length === 0) this.messages.push('');
      this.messages[this.messages.length - 1] += event.assistantMessageEvent.delta;
    } else if (event.type === 'auto_retry_start') {
      // The failed attempt's partial text goes before the SDK retries it. Every
      // assistant message, a failed one included, starts with message_start, so
      // the failed one is always the last; what came before it stands.
      this.messages.pop();
    }
  }

  /** Raw, with no placeholder: a blank reply is for the caller to judge. */
  result(): PiPromptResult {
    const texts = this.messages.map((message) => message.trim()).filter(Boolean);
    return { text: texts.join('\n\n'), finalText: texts.at(-1) ?? '' };
  }
}
