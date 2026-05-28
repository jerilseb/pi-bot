import type { ChatRegistry } from "./chat-session.ts";
import { ALLOWED_CHAT_ID, ALLOWED_OPENROUTER_MODELS } from "./config.ts";
import {
	answerTelegramCallbackQuery,
	editTelegramMessageText,
	type InlineKeyboardButton,
	sanitizeError,
} from "./telegram.ts";
import type { TelegramCallbackQuery } from "./types.ts";
import { errorMessage } from "./util.ts";

const MODEL_CALLBACK_PREFIX = "model:";
const MODEL_CALLBACK_CANCEL = `${MODEL_CALLBACK_PREFIX}cancel`;

export function buildModelInlineKeyboard(): InlineKeyboardButton[][] {
	return [
		...ALLOWED_OPENROUTER_MODELS.map((model, index) => [
			{ text: model, callback_data: `${MODEL_CALLBACK_PREFIX}${index}` },
		]),
		[{ text: "Cancel", callback_data: MODEL_CALLBACK_CANCEL }],
	];
}

export async function handleModelCallbackQuery(
	query: TelegramCallbackQuery,
	registry: ChatRegistry,
): Promise<void> {
	const data = query.data ?? "";
	if (!data.startsWith(MODEL_CALLBACK_PREFIX)) return;

	const chatId = query.message ? String(query.message.chat.id) : "";
	if (chatId !== ALLOWED_CHAT_ID || !query.message) {
		await answerTelegramCallbackQuery(
			query.id,
			"This model menu is no longer valid.",
		);
		return;
	}

	if (data === MODEL_CALLBACK_CANCEL) {
		await answerTelegramCallbackQuery(query.id, "Cancelled");
		await editTelegramMessageText(
			chatId,
			query.message.message_id,
			"Cancelled model switch.",
		);
		return;
	}

	const modelIndex = Number(data.slice(MODEL_CALLBACK_PREFIX.length));
	const modelName = Number.isInteger(modelIndex)
		? ALLOWED_OPENROUTER_MODELS[modelIndex]
		: undefined;
	if (!modelName) {
		await answerTelegramCallbackQuery(query.id, "Unknown model.");
		await editTelegramMessageText(
			chatId,
			query.message.message_id,
			"❌ That model option is no longer available. Use /models again.",
		);
		return;
	}

	const chat = registry.get(chatId);
	if (registry.isBusy(chatId)) {
		await answerTelegramCallbackQuery(query.id, "Chat is busy.");
		await editTelegramMessageText(
			chatId,
			query.message.message_id,
			"⚠️ Model switch cancelled because the chat is busy. Try /models again when idle.",
		);
		return;
	}

	try {
		await chat.pi.setOpenRouterModel(modelName);
		await answerTelegramCallbackQuery(query.id, "Model switched.");
		await editTelegramMessageText(
			chatId,
			query.message.message_id,
			`✅ Switched to openrouter/${chat.pi.modelName}`,
		);
	} catch (error) {
		await answerTelegramCallbackQuery(query.id, "Model switch failed.");
		await editTelegramMessageText(
			chatId,
			query.message.message_id,
			`❌ ${sanitizeError(errorMessage(error))}`,
		);
	}
}
