import { isAllowedTelegramChat } from './config.ts';
import {
  answerTelegramCallbackQuery,
  editTelegramMessageText,
} from './channels/telegram/telegram.ts';
import type { TelegramCallbackQuery } from './channels/telegram/types.ts';
import { errorMessage, summarizeError } from './util.ts';

/**
 * The lifecycle every inline-keyboard menu shares, defined once.
 *
 * A tap arrives as a callback query whose data is `<prefix><value>`. Whatever
 * the menu, the same things have to happen in the same order: ignore taps from
 * any chat but the allowed one, honour the Cancel button, refuse while the bot
 * is in a state that cannot take the change (a busy chat, for the model and
 * reasoning menus), apply the value, and replace the menu message so the
 * keyboard cannot be tapped twice. A menu supplies only the parts that differ.
 *
 * Replies are best-effort: once the value has been applied, a failed toast or
 * edit is logged, never reported as a failed switch.
 *
 * A CallbackAction is the other kind of button: one on a message the bot keeps
 * editing itself, such as a Stop button on a live job message. It answers the
 * tap and leaves the message alone.
 */

/** The `<prefix>cancel` value every menu with a Cancel button uses. */
export const CALLBACK_CANCEL = 'cancel';

export interface CallbackMenuReply {
  /** Short toast Telegram shows on the tap. */
  toast: string;
  /** Text the menu message is replaced with. Plain text; it is escaped on send. */
  text: string;
}

export interface CallbackMenu {
  /** Callback-data prefix, including its trailing colon, e.g. `model:`. */
  prefix: string;
  /**
   * Text the menu is replaced with when its Cancel button is tapped. Omit when
   * the menu has no shared Cancel button and handles cancellation in select.
   */
  cancelText?: string;
  /** Replaces the menu when select returns null: the button is stale or unknown. */
  unknownOptionText: string;
  /** Toast shown when select throws; the message gets the error itself. */
  failureToast: string;
  /** Checked before select. A reply refuses the tap with it. */
  refuse?(): CallbackMenuReply | null;
  /** Applies the tapped value. Null means the value is stale or unknown. */
  select(value: string): Promise<CallbackMenuReply | null>;
}

/**
 * A button that acts without replacing its message. The polling loop waits for
 * every tap, so answer must return at once, leaving slow work detached; its
 * return value is the toast.
 */
export interface CallbackAction {
  /** Callback-data prefix, including its trailing colon, e.g. `stop:`. */
  prefix: string;
  answer(value: string): string;
}

/**
 * Routes a callback query to the action or menu owning its prefix. Unknown taps
 * are still answered.
 */
export async function dispatchCallbackQuery(
  query: TelegramCallbackQuery,
  menus: readonly CallbackMenu[],
  actions: readonly CallbackAction[] = [],
): Promise<void> {
  const data = query.data ?? '';
  const action = actions.find((candidate) => data.startsWith(candidate.prefix));
  if (action) {
    await handleCallbackAction(action, query, data.slice(action.prefix.length));
    return;
  }
  const menu = menus.find((candidate) => data.startsWith(candidate.prefix));
  if (!menu) {
    await answerBestEffort(query.id, 'Unknown action.');
    return;
  }
  await handleCallbackMenu(menu, query, data.slice(menu.prefix.length));
}

async function handleCallbackMenu(
  menu: CallbackMenu,
  query: TelegramCallbackQuery,
  value: string,
): Promise<void> {
  const message = query.message;
  if (!message || !isAllowedTelegramChat(String(message.chat.id))) {
    await answerBestEffort(query.id, 'This menu is no longer valid.');
    return;
  }

  const reply = async ({ toast, text }: CallbackMenuReply): Promise<void> => {
    await answerBestEffort(query.id, toast);
    try {
      await editTelegramMessageText(message.message_id, text);
    } catch (error) {
      console.error(`failed to replace the ${menu.prefix} menu:`, errorMessage(error));
    }
  };

  if (menu.cancelText !== undefined && value === CALLBACK_CANCEL) {
    await reply({ toast: 'Cancelled', text: menu.cancelText });
    return;
  }

  const refused = menu.refuse?.();
  if (refused) {
    await reply(refused);
    return;
  }

  let outcome: CallbackMenuReply | null;
  try {
    outcome = await menu.select(value);
  } catch (error) {
    await reply({ toast: menu.failureToast, text: `❌ ${summarizeError(errorMessage(error))}` });
    return;
  }
  await reply(outcome ?? { toast: 'Unknown option.', text: menu.unknownOptionText });
}

async function handleCallbackAction(
  action: CallbackAction,
  query: TelegramCallbackQuery,
  value: string,
): Promise<void> {
  const message = query.message;
  if (!message || !isAllowedTelegramChat(String(message.chat.id))) {
    await answerBestEffort(query.id, 'This button is no longer valid.');
    return;
  }
  let toast: string;
  try {
    toast = action.answer(value);
  } catch (error) {
    // Toasts are capped at 200 characters, so the error itself goes to the log.
    console.error(`failed to handle the ${action.prefix} button:`, errorMessage(error));
    toast = 'Something went wrong; see the bot log.';
  }
  await answerBestEffort(query.id, toast);
}

async function answerBestEffort(callbackQueryId: string, toast: string): Promise<void> {
  try {
    await answerTelegramCallbackQuery(callbackQueryId, toast);
  } catch (error) {
    console.error('failed to answer callback query:', errorMessage(error));
  }
}
