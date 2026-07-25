import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { isAllowedTelegramChat } from './config.ts';
import {
  answerTelegramCallbackQuery,
  editTelegramMessageText,
  sendTelegramInlineKeyboard,
  type InlineKeyboardButton,
} from './telegram.ts';
import { textResult } from './tool-result.ts';
import type { IncomingPrompt, TelegramCallbackQuery } from './types.ts';
import { errorMessage } from './util.ts';

const MENU_CALLBACK_PREFIX = 'menu:';
const MENU_CALLBACK_CANCEL = 'cancel';
const DEFAULT_MENU_EXPIRY_MINUTES = 60;
const MAX_MENU_EXPIRY_MINUTES = 24 * 60;
const MAX_MENU_OPTIONS = 12;

const TelegramMenuOptionParams = Type.Object({
  label: Type.String({
    description: 'Button text shown to the user.',
    minLength: 1,
    maxLength: 64,
  }),
  value: Type.Optional(
    Type.String({
      description: 'Optional machine-readable value. Defaults to the label.',
      maxLength: 200,
    }),
  ),
});

const SendTelegramMenuParams = Type.Object({
  text: Type.String({
    description: 'Question or prompt to show above the inline keyboard.',
    minLength: 1,
  }),
  options: Type.Array(TelegramMenuOptionParams, {
    description: 'Selectable options. Use two options like Yes/No for confirmations.',
    minItems: 1,
    maxItems: MAX_MENU_OPTIONS,
  }),
  columns: Type.Optional(
    Type.Integer({
      description: 'Number of button columns per row. Defaults to 2.',
      minimum: 1,
      maximum: 3,
    }),
  ),
  allow_cancel: Type.Optional(
    Type.Boolean({ description: 'Whether to add a Cancel button at the bottom.' }),
  ),
  expires_minutes: Type.Optional(
    Type.Integer({
      description: 'How long the menu remains valid. Defaults to 60 minutes.',
      minimum: 1,
      maximum: MAX_MENU_EXPIRY_MINUTES,
    }),
  ),
});

type SendTelegramMenuParamsType = Static<typeof SendTelegramMenuParams>;

interface TelegramMenuOption {
  label: string;
  value: string;
}

interface TelegramMenu {
  id: string;
  text: string;
  options: TelegramMenuOption[];
  allowCancel: boolean;
  expiresAt: number;
  createdAt: number;
}

const menus = new Map<string, TelegramMenu>();

export function telegramMenuExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'send_telegram_menu',
    label: 'Send Telegram Menu',
    description:
      'Send a Telegram inline button menu to the current chat. Use for yes/no confirmations or asking the user to select from multiple options. When the user taps a button, the selected option is sent back into the chat as a normal user prompt so you can continue from it.',
    promptSnippet: 'Send Telegram inline menus for confirmations and option selection.',
    promptGuidelines: [
      'Use send_telegram_menu when you need the user to choose one of several options before continuing.',
      'For yes/no confirmations, pass two options such as ✅ Yes and ❌ No.',
      'Keep button labels short and clear.',
      'After sending the menu, explain briefly that you are waiting for the user to tap an option.',
    ],
    parameters: SendTelegramMenuParams,
    async execute(_toolCallId, params: SendTelegramMenuParamsType) {
      const menu = await sendTelegramMenu(params);
      return textResult(
        [
          `Sent Telegram menu ${menu.id}.`,
          'The user selection will arrive as a follow-up prompt when they tap a button.',
        ].join('\n'),
      );
    },
  });
}

export async function handleTelegramMenuCallbackQuery(
  query: TelegramCallbackQuery,
  enqueuePrompt: (prompt: IncomingPrompt) => Promise<void>,
): Promise<boolean> {
  cleanupExpiredMenus();

  const data = query.data ?? '';
  if (!data.startsWith(MENU_CALLBACK_PREFIX)) return false;

  if (!query.message || !isAllowedTelegramChat(String(query.message.chat.id))) {
    await answerTelegramCallbackQuery(query.id, 'This menu is no longer valid.');
    return true;
  }

  const parsed = parseMenuCallbackData(data);
  if (!parsed) {
    await answerTelegramCallbackQuery(query.id, 'Unknown menu action.');
    return true;
  }

  const menu = menus.get(parsed.menuId);
  if (!menu || menu.expiresAt <= Date.now()) {
    menus.delete(parsed.menuId);
    await answerTelegramCallbackQuery(query.id, 'Menu expired.');
    await editMenuMessageBestEffort(
      query.message.message_id,
      '⏱ This menu has expired. Ask me to send it again.',
    );
    return true;
  }

  menus.delete(menu.id);

  if (parsed.action === MENU_CALLBACK_CANCEL) {
    await answerTelegramCallbackQuery(query.id, 'Cancelled');
    await editMenuMessageBestEffort(query.message.message_id, `${menu.text}\n\nCancelled.`);
    await enqueuePrompt({
      text: buildMenuCancelledPrompt(menu),
      attachments: [],
      source: 'telegram',
    });
    return true;
  }

  const option = menu.options[parsed.optionIndex];
  if (!option) {
    await answerTelegramCallbackQuery(query.id, 'Unknown option.');
    await editMenuMessageBestEffort(
      query.message.message_id,
      '❌ That menu option is no longer available. Ask me to send the menu again.',
    );
    return true;
  }

  await answerTelegramCallbackQuery(query.id, `Selected: ${option.label}`);
  await editMenuMessageBestEffort(
    query.message.message_id,
    `${menu.text}\n\nSelected: ${option.label}`,
  );
  await enqueuePrompt({
    text: buildMenuSelectionPrompt(menu, option),
    attachments: [],
    source: 'telegram',
  });
  return true;
}

async function sendTelegramMenu(params: SendTelegramMenuParamsType): Promise<TelegramMenu> {
  const options = normalizeMenuOptions(params.options);
  const columns = normalizeColumns(params.columns);
  const allowCancel = params.allow_cancel ?? false;
  const expiresMinutes = normalizeExpiryMinutes(params.expires_minutes);
  const menu: TelegramMenu = {
    id: createMenuId(),
    text: params.text.trim(),
    options,
    allowCancel,
    createdAt: Date.now(),
    expiresAt: Date.now() + expiresMinutes * 60_000,
  };

  menus.set(menu.id, menu);

  try {
    await sendTelegramInlineKeyboard(menu.text, buildMenuKeyboard(menu, columns));
  } catch (error) {
    menus.delete(menu.id);
    throw error;
  }

  return menu;
}

function normalizeMenuOptions(
  options: SendTelegramMenuParamsType['options'],
): TelegramMenuOption[] {
  if (options.length === 0) throw new Error('A menu needs at least one option.');
  if (options.length > MAX_MENU_OPTIONS) {
    throw new Error(`A menu can have at most ${MAX_MENU_OPTIONS} options.`);
  }

  return options.map((option, index) => {
    const label = option.label.trim();
    if (!label) throw new Error(`Menu option ${index + 1} needs a label.`);
    return {
      label,
      value: option.value?.trim() || label,
    };
  });
}

function normalizeColumns(columns: number | undefined): number {
  const value = columns ?? 2;
  return Math.min(3, Math.max(1, Math.floor(value)));
}

function normalizeExpiryMinutes(expiresMinutes: number | undefined): number {
  const value = expiresMinutes ?? DEFAULT_MENU_EXPIRY_MINUTES;
  return Math.min(MAX_MENU_EXPIRY_MINUTES, Math.max(1, Math.floor(value)));
}

function buildMenuKeyboard(menu: TelegramMenu, columns: number): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  for (let index = 0; index < menu.options.length; index += columns) {
    rows.push(
      menu.options.slice(index, index + columns).map((option, offset) => ({
        text: option.label,
        callback_data: `${MENU_CALLBACK_PREFIX}${menu.id}:${index + offset}`,
      })),
    );
  }

  if (menu.allowCancel) {
    rows.push([{ text: 'Cancel', callback_data: `${MENU_CALLBACK_PREFIX}${menu.id}:cancel` }]);
  }

  return rows;
}

function parseMenuCallbackData(
  data: string,
):
  | { menuId: string; action: typeof MENU_CALLBACK_CANCEL; optionIndex: never }
  | { menuId: string; action: 'select'; optionIndex: number }
  | null {
  const withoutPrefix = data.slice(MENU_CALLBACK_PREFIX.length);
  const [menuId, action] = withoutPrefix.split(':', 2);
  if (!menuId || !action) return null;

  if (action === MENU_CALLBACK_CANCEL) {
    return { menuId, action: MENU_CALLBACK_CANCEL, optionIndex: undefined as never };
  }

  const optionIndex = Number(action);
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return null;
  return { menuId, action: 'select', optionIndex };
}

function buildMenuSelectionPrompt(menu: TelegramMenu, option: TelegramMenuOption): string {
  return [
    'The user selected an option from a Telegram inline menu.',
    '',
    'Menu question:',
    menu.text,
    '',
    'Selected option:',
    option.label,
    '',
    'Selected value:',
    option.value,
    '',
    'Continue based on this selection.',
  ].join('\n');
}

function buildMenuCancelledPrompt(menu: TelegramMenu): string {
  return [
    'The user cancelled a Telegram inline menu.',
    '',
    'Menu question:',
    menu.text,
    '',
    'Acknowledge the cancellation briefly or ask how to proceed if needed.',
  ].join('\n');
}

function createMenuId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

function cleanupExpiredMenus(): void {
  const now = Date.now();
  for (const [id, menu] of menus.entries()) {
    if (menu.expiresAt <= now) menus.delete(id);
  }
}

async function editMenuMessageBestEffort(messageId: number, text: string): Promise<void> {
  try {
    await editTelegramMessageText(messageId, text);
  } catch (error) {
    console.error('failed to edit Telegram menu:', errorMessage(error));
  }
}
