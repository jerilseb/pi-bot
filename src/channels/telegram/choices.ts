import type { ChoiceView } from '../../contract.ts';
import type { InlineKeyboardButton } from './telegram.ts';

/**
 * A core menu as an inline keyboard. Callback data is `ch:<id>:<index|cancel>`,
 * well within Telegram's 64-byte limit for the IDs the core makes up.
 */

export const CHOICE_CALLBACK_PREFIX = 'ch:';
const CANCEL = 'cancel';

export function choiceKeyboard(choice: ChoiceView): InlineKeyboardButton[][] {
  const columns = Math.max(1, choice.columns);
  const rows: InlineKeyboardButton[][] = [];
  for (let index = 0; index < choice.options.length; index += columns) {
    rows.push(
      choice.options.slice(index, index + columns).map((label, offset) => ({
        text: label,
        callback_data: `${CHOICE_CALLBACK_PREFIX}${choice.id}:${index + offset}`,
      })),
    );
  }
  if (choice.cancellable) {
    rows.push([
      { text: 'Cancel', callback_data: `${CHOICE_CALLBACK_PREFIX}${choice.id}:${CANCEL}` },
    ]);
  }
  return rows;
}

/** The menu and option a tap names, from its callback data without the prefix. */
export function parseChoiceCallback(
  value: string,
): { choiceId: string; option: number | 'cancel' } | null {
  const colon = value.lastIndexOf(':');
  if (colon <= 0) return null;
  const choiceId = value.slice(0, colon);
  const action = value.slice(colon + 1);
  if (action === CANCEL) return { choiceId, option: CANCEL };
  const option = Number(action);
  return /^\d+$/.test(action) && Number.isSafeInteger(option) ? { choiceId, option } : null;
}
