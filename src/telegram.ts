import { TELEGRAM_API, TELEGRAM_MAX_MESSAGE } from "./config.ts";

export async function registerBotCommands(): Promise<void> {
	try {
		await telegram("setMyCommands", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				commands: [
					{ command: "start", description: "Say hi" },
					{ command: "help", description: "Show commands" },
					{ command: "status", description: "Show chat session status" },
					{ command: "abort", description: "Stop the current Pi response" },
					{ command: "new", description: "Reset this chat's Pi conversation" },
					{ command: "reload", description: "Re-scan extensions and skills" },
					{ command: "update", description: "Git pull and restart the app" },
					{ command: "restart", description: "Restart the bot process via PM2" },
				],
			}),
		});
	} catch (error) {
		console.error(
			"Failed to register bot commands:",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export function startTyping(chatId: string): { stop(): void } {
	void sendChatAction(chatId);
	const timer = setInterval(() => void sendChatAction(chatId), 4000);
	return { stop: () => clearInterval(timer) };
}

export async function sendTelegramMessage(
	chatId: string,
	text: string,
): Promise<void> {
	const chunks = splitTelegramMessage(text || "(empty)");
	for (const chunk of chunks) {
		await sendTelegramHtmlMessage(chatId, chunk);
	}
}

async function sendTelegramHtmlMessage(
	chatId: string,
	html: string,
): Promise<void> {
	try {
		await postTelegramHtmlMessage(chatId, html);
	} catch (error) {
		if (!isTelegramHtmlParseError(error)) throw error;
		await postTelegramHtmlMessage(chatId, escapeTelegramHtml(html));
	}
}

async function postTelegramHtmlMessage(
	chatId: string,
	text: string,
): Promise<void> {
	await telegram("sendMessage", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
	});
}

export async function sendChatAction(chatId: string): Promise<void> {
	try {
		await telegram("sendChatAction", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, action: "typing" }),
		});
	} catch {
		// Typing indicators are best-effort.
	}
}

export async function telegram<T = unknown>(
	methodAndQuery: string,
	init?: RequestInit,
): Promise<T> {
	const res = await fetch(`${TELEGRAM_API}/${methodAndQuery}`, init);
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(
			`Telegram ${methodAndQuery} failed (${res.status}): ${body}`,
		);
	}
	return (await res.json()) as T;
}

export function escapeTelegramHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function isTelegramHtmlParseError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.toLowerCase().includes("can't parse entities");
}

function splitTelegramMessage(text: string): string[] {
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > TELEGRAM_MAX_MESSAGE) {
		let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_MESSAGE);
		if (splitAt < TELEGRAM_MAX_MESSAGE / 2) splitAt = TELEGRAM_MAX_MESSAGE;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).replace(/^\n/, "");
	}
	chunks.push(remaining);
	return chunks;
}

export function sanitizeError(error: string): string {
	const firstUsefulLine = error
		.split("\n")
		.map((line) => line.trim())
		.find(
			(line) => line && !line.startsWith("at ") && !line.startsWith("node:"),
		);
	const message = firstUsefulLine || "Something went wrong.";
	return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
