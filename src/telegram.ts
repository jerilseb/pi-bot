import { ALLOWED_CHAT_ID, TELEGRAM_API, TELEGRAM_API_TIMEOUT_MS } from './config.ts';
import { escapeTelegramHtml, sanitizeTelegramHtml, splitTelegramMessage } from './telegram-html.ts';
import { errorMessage } from './util.ts';

/**
 * Telegram Bot API transport for the single allowed chat: sending messages,
 * inline keyboards, typing actions, and the command menu.
 *
 * Every send goes out in HTML parse mode. Telegram rejects the whole message on
 * malformed markup, so sendTelegramMessage walks a fallback ladder — raw, then
 * sanitized, then fully escaped — rather than dropping the message. The escaping
 * and splitting machinery itself lives in src/telegram-html.ts.
 */

/** One entry of the Telegram command menu. Built from the table in src/commands.ts. */
export interface TelegramBotCommand {
  /** Command name without the leading slash. */
  command: string;
  description: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export async function registerBotCommands(commands: TelegramBotCommand[]): Promise<void> {
  try {
    await telegram('setMyCommands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
  } catch (error) {
    console.error('Failed to register bot commands:', errorMessage(error));
  }
}

export function startTyping(): { stop(): void } {
  void sendChatAction();
  const timer = setInterval(() => void sendChatAction(), 4000);
  return { stop: () => clearInterval(timer) };
}

export async function sendTelegramMessage(text: string): Promise<void> {
  const chunks = splitTelegramMessage(text || '(empty)');
  for (const chunk of chunks) {
    await sendTelegramHtmlMessage(chunk);
  }
}

export async function sendTelegramInlineKeyboard(
  text: string,
  keyboard: InlineKeyboardButton[][],
): Promise<void> {
  await postTelegramHtmlMessage(escapeTelegramHtml(text || '(empty)'), {
    inline_keyboard: keyboard,
  });
}

export async function answerTelegramCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await telegram('answerCallbackQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    }),
  });
}

export async function editTelegramMessageText(messageId: number, text: string): Promise<void> {
  await telegram('editMessageText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: ALLOWED_CHAT_ID,
      message_id: messageId,
      text: escapeTelegramHtml(text || '(empty)'),
      parse_mode: 'HTML',
    }),
  });
}

/** Sends one chunk, degrading the markup rather than failing: raw → sanitized → escaped. */
async function sendTelegramHtmlMessage(html: string): Promise<void> {
  try {
    await postTelegramHtmlMessage(html);
    return;
  } catch (error) {
    if (!isTelegramHtmlParseError(error)) throw error;
  }
  try {
    await postTelegramHtmlMessage(sanitizeTelegramHtml(html));
    return;
  } catch (error) {
    if (!isTelegramHtmlParseError(error)) throw error;
  }
  await postTelegramHtmlMessage(escapeTelegramHtml(html));
}

async function postTelegramHtmlMessage(
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<void> {
  await telegram('sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: ALLOWED_CHAT_ID,
      text,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
}

export async function sendChatAction(): Promise<void> {
  try {
    await telegram('sendChatAction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ALLOWED_CHAT_ID, action: 'typing' }),
    });
  } catch {
    // Typing indicators are best-effort.
  }
}

export async function telegram<T = unknown>(
  methodAndQuery: string,
  init?: RequestInit,
  timeoutMs: number = TELEGRAM_API_TIMEOUT_MS,
): Promise<T> {
  const res = await fetch(`${TELEGRAM_API}/${methodAndQuery}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram ${methodAndQuery} failed (${res.status}): ${body}`);
  }
  return (await res.json()) as T;
}

function isTelegramHtmlParseError(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes("can't parse entities");
}

/** Reduces a thrown error to one escaped, length-capped line fit for the chat. */
export function sanitizeError(error: string): string {
  const firstUsefulLine = error
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('at ') && !line.startsWith('node:'));
  const message = firstUsefulLine || 'Something went wrong.';
  const truncated = message.length > 500 ? `${message.slice(0, 500)}…` : message;
  return escapeTelegramHtml(truncated);
}
