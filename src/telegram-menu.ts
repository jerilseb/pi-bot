import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { heldDeliveryNote } from './background-outbox.ts';
import type { ChoiceSpec } from './choices.ts';
import type { ChannelRef } from './contract.ts';
import { describeReceipts, type ToolHost, toolHost } from './tool-host.ts';
import { textResult } from './tool-result.ts';
import type { SessionKind } from './types.ts';

/**
 * send_telegram_menu: a menu the agent sends every connected interface. The
 * first answer, from any of them, closes every copy and comes back into the
 * chat as the user's own message from that interface, so it can steer a turn
 * under way. A menu is single-use and expires.
 */

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
  text: string;
  options: TelegramMenuOption[];
  allowCancel: boolean;
}

/** send_telegram_menu for one of the bot's sessions; the background session's sends are held. */
export function telegramMenuExtension(session: SessionKind): (pi: ExtensionAPI) => void {
  return (pi) => registerSendMenu(pi, session);
}

function registerSendMenu(pi: ExtensionAPI, session: SessionKind): void {
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
      // Built now so invalid options still fail the call; the menu opens, and
      // its expiry clock starts, when it is actually sent.
      const prepared = prepareTelegramMenu(params);
      const host = toolHost();
      const result = await host.deliver(
        session,
        'menu',
        () => ({ kind: 'choice', choice: host.openChoice(menuChoice(prepared, host)) }),
        (receipts, item) => {
          if (item.kind === 'choice' && !receipts.some((receipt) => receipt.ok)) {
            host.closeChoice(item.choice.id);
          }
        },
      );
      if (result.outcome === 'held') {
        return textResult(
          [
            heldDeliveryNote('Menu'),
            'The user selection will arrive as a follow-up prompt in the chat, not in this run.',
          ].join('\n'),
        );
      }
      return textResult(
        [
          `Sent the menu.${describeReceipts('menus', result.receipts)}`,
          'The user selection will arrive as a follow-up prompt when they tap a button.',
        ].join('\n'),
      );
    },
  });
}

/** The menu as the core keeps it. An answer is submitted as the user's message. */
function menuChoice(prepared: PreparedMenu, host: ToolHost): ChoiceSpec {
  const { menu, columns, expiresMinutes } = prepared;
  const answer = (by: ChannelRef, text: string) => host.submit({ from: by, text, attachments: [] });
  return {
    text: menu.text,
    options: menu.options.map(({ label }) => ({ label })),
    columns,
    cancellable: menu.allowCancel,
    unknownOptionText: '❌ That menu option is no longer available. Ask me to send the menu again.',
    failureToast: 'Menu selection failed.',
    expiredText: '⏱ This menu has expired. Ask me to send it again.',
    expiresAt: Date.now() + expiresMinutes * 60_000,
    audience: 'all',
    async select(index, by) {
      const option = menu.options[index];
      if (!option) return null;
      const submitted = await answer(by, buildMenuSelectionPrompt(menu, option));
      return {
        toast: `Selected: ${option.label}`,
        text: `${menu.text}\n\nSelected: ${option.label}`,
        submitted,
      };
    },
    async cancel(by) {
      const submitted = await answer(by, buildMenuCancelledPrompt(menu));
      return { toast: 'Cancelled', text: `${menu.text}\n\nCancelled.`, submitted };
    },
  };
}

interface PreparedMenu {
  menu: TelegramMenu;
  columns: number;
  expiresMinutes: number;
}

function prepareTelegramMenu(params: SendTelegramMenuParamsType): PreparedMenu {
  const expiresMinutes = normalizeExpiryMinutes(params.expires_minutes);
  return {
    menu: {
      text: params.text.trim(),
      options: normalizeMenuOptions(params.options),
      allowCancel: params.allow_cancel ?? false,
    },
    columns: normalizeColumns(params.columns),
    expiresMinutes,
  };
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
