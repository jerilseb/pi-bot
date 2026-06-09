import { getPrimaryTelegramChatId, isAllowedTelegramChat } from './config.ts';
import { escapeTelegramHtml, sendTelegramMessage } from './telegram.ts';
import type { TelegramMessage } from './types.ts';

const REQUEST_ACCESS_COMMAND = '/request_access';
const GROUP_CHAT_TYPES = new Set(['group', 'supergroup']);

export async function handleGroupAccessRequest(message: TelegramMessage): Promise<boolean> {
  const text = message.text?.trim();
  if (!text) return false;

  const [commandRaw] = text.split(/\s+/, 1);
  const command = commandRaw.toLowerCase().replace(/@.+$/, '');
  if (command !== REQUEST_ACCESS_COMMAND) return false;

  const chatId = String(message.chat.id);
  if (isAllowedTelegramChat(chatId)) {
    await sendTelegramMessage(chatId, '✅ This chat is already allowed.');
    return true;
  }

  if (!GROUP_CHAT_TYPES.has(message.chat.type)) return false;

  await notifyGroup(chatId);
  await notifyOwner(message, chatId);
  return true;
}

async function notifyGroup(chatId: string): Promise<void> {
  await sendTelegramMessage(
    chatId,
    [
      '📨 Access request sent to the bot owner.',
      `Group ID: <code>${escapeTelegramHtml(chatId)}</code>`,
    ].join('\n'),
  );
}

async function notifyOwner(message: TelegramMessage, chatId: string): Promise<void> {
  const ownerChatId = getPrimaryTelegramChatId();
  if (!ownerChatId || ownerChatId === chatId) return;

  const groupName = message.chat.title?.trim() || '(untitled group)';
  const requester = formatRequester(message.from);
  const entry = {
    name: groupName,
    id: chatId,
    type: message.chat.type,
    enabled: true,
  };

  await sendTelegramMessage(
    ownerChatId,
    [
      '<b>New Telegram group access request</b>',
      `Name: ${escapeTelegramHtml(groupName)}`,
      `ID: <code>${escapeTelegramHtml(chatId)}</code>`,
      `Type: ${escapeTelegramHtml(message.chat.type)}`,
      `Requested by: ${escapeTelegramHtml(requester)}`,
      '',
      `To approve, add this entry to <code>files/allowed-chats.json</code>:`,
      `<pre>${escapeTelegramHtml(JSON.stringify(entry, null, 2))}</pre>`,
    ].join('\n'),
  );
}

function formatRequester(user: TelegramMessage['from']): string {
  if (!user) return 'unknown';

  const parts = [user.first_name?.trim(), user.username ? `@${user.username}` : undefined].filter(
    Boolean,
  );
  return parts.length ? `${parts.join(' ')} (${user.id})` : String(user.id);
}
