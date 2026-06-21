import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type Static, Type } from 'typebox';
import { textResult } from '../tool-result.ts';
import type { MenuOptionRef } from './protocol.ts';
import * as gateway from './gateway.ts';

const DEFAULT_MENU_EXPIRY_MINUTES = 60;
const MAX_MENU_EXPIRY_MINUTES = 24 * 60;
const MAX_MENU_OPTIONS = 12;

const MenuOptionParams = Type.Object({
  label: Type.String({ description: 'Button text shown to the user.', minLength: 1, maxLength: 64 }),
  value: Type.Optional(
    Type.String({
      description: 'Optional machine-readable value. Defaults to the label.',
      maxLength: 200,
    }),
  ),
});

const SendMenuParams = Type.Object({
  text: Type.String({
    description: 'Question or prompt to show above the buttons.',
    minLength: 1,
  }),
  options: Type.Array(MenuOptionParams, {
    description: 'Selectable options. Use two options like Yes/No for confirmations.',
    minItems: 1,
    maxItems: MAX_MENU_OPTIONS,
  }),
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

type SendMenuParamsType = Static<typeof SendMenuParams>;

interface Menu {
  id: string;
  chatId: string;
  text: string;
  options: MenuOptionRef[];
  allowCancel: boolean;
  expiresAt: number;
}

const menus = new Map<string, Menu>();

export function webMenuExtension(chatId: string): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: 'send_menu',
      label: 'Send Menu',
      description:
        'Show the user a button menu in the web UI. Use for yes/no confirmations or asking the user to select from multiple options. When the user clicks a button, the selected option is sent back as a normal prompt so you can continue from it.',
      promptSnippet: 'Send button menus for confirmations and option selection.',
      promptGuidelines: [
        'Use send_menu when you need the user to choose one of several options before continuing.',
        'For yes/no confirmations, pass two options such as ✅ Yes and ❌ No.',
        'Keep button labels short and clear.',
        'After sending the menu, explain briefly that you are waiting for the user to choose an option.',
      ],
      parameters: SendMenuParams,
      async execute(_toolCallId, params: SendMenuParamsType) {
        const menu = createMenu(chatId, params);
        return textResult(
          [
            `Sent menu ${menu.id}.`,
            'The user selection will arrive as a follow-up prompt when they click a button.',
          ].join('\n'),
        );
      },
    });
  };
}

function createMenu(chatId: string, params: SendMenuParamsType): Menu {
  cleanupExpiredMenus();
  const options = normalizeMenuOptions(params.options);
  const allowCancel = params.allow_cancel ?? false;
  const expiresMinutes = normalizeExpiryMinutes(params.expires_minutes);
  const menu: Menu = {
    id: randomUUID().replace(/-/g, '').slice(0, 12),
    chatId,
    text: params.text.trim(),
    options,
    allowCancel,
    expiresAt: Date.now() + expiresMinutes * 60_000,
  };

  menus.set(menu.id, menu);
  gateway.emit(chatId, {
    type: 'menu',
    payload: { menuId: menu.id, text: menu.text, options: menu.options, allowCancel },
  });
  return menu;
}

export interface MenuSelection {
  cancel?: boolean;
  optionIndex?: number;
}

/** Resolves a menu_select into a follow-up prompt, or returns an error string. */
export function resolveMenuSelection(
  chatId: string,
  menuId: string,
  selection: MenuSelection,
): { promptText: string } | { error: string } {
  cleanupExpiredMenus();
  const menu = menus.get(menuId);
  if (!menu || menu.chatId !== chatId || menu.expiresAt <= Date.now()) {
    menus.delete(menuId);
    return { error: 'This menu is no longer valid.' };
  }

  menus.delete(menu.id);

  if (selection.cancel) {
    return { promptText: buildMenuCancelledPrompt(menu) };
  }

  const option = selection.optionIndex !== undefined ? menu.options[selection.optionIndex] : undefined;
  if (!option) {
    return { error: 'That menu option is no longer available.' };
  }

  return { promptText: buildMenuSelectionPrompt(menu, option) };
}

function normalizeMenuOptions(options: SendMenuParamsType['options']): MenuOptionRef[] {
  if (options.length === 0) throw new Error('A menu needs at least one option.');
  if (options.length > MAX_MENU_OPTIONS) {
    throw new Error(`A menu can have at most ${MAX_MENU_OPTIONS} options.`);
  }
  return options.map((option, index) => {
    const label = option.label.trim();
    if (!label) throw new Error(`Menu option ${index + 1} needs a label.`);
    return { label, value: option.value?.trim() || label };
  });
}

function normalizeExpiryMinutes(expiresMinutes: number | undefined): number {
  const value = expiresMinutes ?? DEFAULT_MENU_EXPIRY_MINUTES;
  return Math.min(MAX_MENU_EXPIRY_MINUTES, Math.max(1, Math.floor(value)));
}

function buildMenuSelectionPrompt(menu: Menu, option: MenuOptionRef): string {
  return [
    'The user selected an option from a menu.',
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

function buildMenuCancelledPrompt(menu: Menu): string {
  return [
    'The user cancelled a menu.',
    '',
    'Menu question:',
    menu.text,
    '',
    'Acknowledge the cancellation briefly or ask how to proceed if needed.',
  ].join('\n');
}

function cleanupExpiredMenus(): void {
  const now = Date.now();
  for (const [id, menu] of menus.entries()) {
    if (menu.expiresAt <= now) menus.delete(id);
  }
}
