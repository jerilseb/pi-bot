import {
  ALLOWED_CHAT_ID,
  REPLY_DRAFT_TIMEOUT_MS,
  TELEGRAM_API,
  TELEGRAM_API_TIMEOUT_MS,
} from '../../config.ts';
import { escapeTelegramHtml, sanitizeTelegramHtml, splitTelegramMessage } from './telegram-html.ts';
import { errorMessage, summarizeError } from '../../util.ts';

/**
 * Telegram Bot API transport for the single allowed chat: sending messages,
 * drafts of a reply being written, inline keyboards, typing actions, and the
 * command menu.
 *
 * Every send goes out in HTML parse mode. Telegram rejects the whole message on
 * malformed markup, so sendTelegramMessage walks a fallback ladder — raw, then
 * sanitized, then fully escaped — rather than dropping the message. The escaping
 * and splitting machinery itself lives in telegram-html.ts.
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

export interface SendMessageOptions {
  /** Deliver without a push notification sound. */
  silent?: boolean;
}

export interface SendHtmlMessageOptions extends SendMessageOptions {
  /** Buttons under the message. A message split into pieces carries them on the last one. */
  keyboard?: InlineKeyboardButton[][];
}

export async function sendTelegramMessage(
  text: string,
  options: SendMessageOptions = {},
): Promise<void> {
  const chunks = splitTelegramMessage(text || '(empty)');
  for (const chunk of chunks) {
    await sendTelegramHtmlMessage(chunk, options);
  }
}

export async function sendTelegramInlineKeyboard(
  text: string,
  keyboard: InlineKeyboardButton[][],
): Promise<void> {
  await postTelegramHtmlMessage(
    escapeTelegramHtml(text || '(empty)'),
    {},
    { inline_keyboard: keyboard },
  );
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
  await editTelegramMessageHtml(messageId, escapeTelegramHtml(text || '(empty)'));
}

/**
 * Replaces a sent message's HTML, degrading the markup on the same ladder as a
 * send. Editing to identical content is a Telegram error rather than a change,
 * so that one is treated as success.
 *
 * An edit without a keyboard drops the message's buttons, which is how a menu
 * clears itself. A message that keeps its buttons must pass them on every edit;
 * an empty keyboard removes them.
 */
export async function editTelegramMessageHtml(
  messageId: number,
  html: string,
  keyboard?: InlineKeyboardButton[][],
): Promise<void> {
  await withHtmlParseFallback(html, async (candidate) => {
    try {
      await telegram('editMessageText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ALLOWED_CHAT_ID,
          message_id: messageId,
          text: candidate,
          parse_mode: 'HTML',
          ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
        }),
      });
    } catch (error) {
      if (!isTelegramNotModifiedError(error)) throw error;
    }
  });
}

/**
 * Turns a placeholder message into its final content: the first piece in its
 * place, and any further pieces after it. When Telegram rejects the edit (the
 * placeholder was deleted, say), all of it is sent anew.
 */
export async function replaceTelegramMessage(
  messageId: number,
  html: string,
  options: SendMessageOptions = {},
): Promise<void> {
  const [first = '', ...rest] = splitTelegramMessage(html || '(empty)');
  try {
    await editTelegramMessageHtml(messageId, first);
  } catch (error) {
    console.error('failed to replace a message; sending it anew:', errorMessage(error));
    await sendTelegramMessage(html, options);
    return;
  }
  for (const piece of rest) await sendTelegramHtmlMessage(piece, options);
}

/**
 * Sends one chunk that fits in a single Telegram message and returns its ID, so
 * the caller can edit it later. A degraded fallback (sanitized or escaped) can
 * grow past the limit — escaping turns every `<` into four characters — so each
 * rung is re-split and the ID of the last piece is returned. That piece is the
 * one a caller edits, so it is the one that carries the keyboard.
 */
export async function sendTelegramHtmlMessage(
  html: string,
  options: SendHtmlMessageOptions = {},
): Promise<number> {
  const { keyboard, ...sendOptions } = options;
  return withHtmlParseFallback(html, async (candidate) => {
    const pieces = splitTelegramMessage(candidate);
    let messageId = 0;
    for (const [index, piece] of pieces.entries()) {
      const last = index === pieces.length - 1;
      messageId = await postTelegramHtmlMessage(
        piece,
        sendOptions,
        last && keyboard ? { inline_keyboard: keyboard } : undefined,
      );
    }
    return messageId;
  });
}

/**
 * Tries the HTML as written, then sanitized, then fully escaped. Only a Telegram
 * entity-parse error moves on to the next attempt; anything else propagates.
 * Escaped text has no entities to reject, so the last rung is final. Each step
 * down is logged with Telegram's reason, since the user sees degraded markup.
 */
async function withHtmlParseFallback<T>(
  html: string,
  post: (candidate: string) => Promise<T>,
): Promise<T> {
  try {
    return await post(html);
  } catch (error) {
    if (!isTelegramHtmlParseError(error)) throw error;
    console.warn('Telegram rejected the HTML; retrying sanitized:', errorMessage(error));
  }
  try {
    return await post(sanitizeTelegramHtml(html));
  } catch (error) {
    if (!isTelegramHtmlParseError(error)) throw error;
    console.warn('Telegram rejected the sanitized HTML; sending it escaped:', errorMessage(error));
  }
  return post(escapeTelegramHtml(html));
}

async function postTelegramHtmlMessage(
  text: string,
  options: SendMessageOptions = {},
  replyMarkup?: Record<string, unknown>,
): Promise<number> {
  const response = await telegram<{ result?: { message_id?: number } }>('sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: ALLOWED_CHAT_ID,
      text,
      parse_mode: 'HTML',
      ...(options.silent ? { disable_notification: true } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });

  const messageId = response.result?.message_id;
  if (typeof messageId !== 'number') throw new Error('Telegram sendMessage returned no message_id');
  return messageId;
}

/**
 * Shows a draft of a message still being written. Telegram animates each change
 * to the same `draftId`, and drops the draft when the next message arrives or
 * 30 seconds after its last update, so the finished text must still be sent.
 * A draft is one message, so a longer text shows its last piece, the one being
 * written: the piece the finished text will end with once it is split. Only
 * private chats take drafts.
 */
export async function sendTelegramDraft(draftId: number, html: string): Promise<void> {
  await withHtmlParseFallback(html, async (candidate) => {
    await telegram(
      'sendMessageDraft',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ALLOWED_CHAT_ID,
          draft_id: draftId,
          text: splitTelegramMessage(candidate).at(-1) ?? '',
          parse_mode: 'HTML',
        }),
      },
      REPLY_DRAFT_TIMEOUT_MS,
    );
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

/**
 * How long Telegram asked to wait before the next call, when it refused one for
 * going too fast (429); null for any other failure.
 */
export function telegramRetryAfterMs(error: unknown): number | null {
  const message = errorMessage(error);
  if (!message.includes(' failed (429)')) return null;
  const seconds = Number(/"retry_after":\s*(\d+)/.exec(message)?.[1]);
  // Telegram always says how long; a second, should it not.
  return seconds > 0 ? seconds * 1000 : 1000;
}

function isTelegramHtmlParseError(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes("can't parse entities");
}

function isTelegramNotModifiedError(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes('message is not modified');
}

/** summarizeError, escaped for an HTML send. */
export function sanitizeError(error: string): string {
  return escapeTelegramHtml(summarizeError(error));
}
