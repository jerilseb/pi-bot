import { TELEGRAM_API, TELEGRAM_MAX_MESSAGE } from "./config.ts";
import { errorMessage } from "./util.ts";

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
					{ command: "models", description: "Switch chat model" },
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
			errorMessage(error),
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

export interface InlineKeyboardButton {
	text: string;
	callback_data: string;
}

export async function sendTelegramInlineKeyboard(
	chatId: string,
	text: string,
	keyboard: InlineKeyboardButton[][],
): Promise<void> {
	await postTelegramHtmlMessage(chatId, escapeTelegramHtml(text || "(empty)"), {
		inline_keyboard: keyboard,
	});
}

export async function answerTelegramCallbackQuery(
	callbackQueryId: string,
	text?: string,
): Promise<void> {
	await telegram("answerCallbackQuery", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			callback_query_id: callbackQueryId,
			...(text ? { text } : {}),
		}),
	});
}

export async function editTelegramMessageText(
	chatId: string,
	messageId: number,
	text: string,
): Promise<void> {
	await telegram("editMessageText", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			chat_id: chatId,
			message_id: messageId,
			text: escapeTelegramHtml(text || "(empty)"),
			parse_mode: "HTML",
		}),
	});
}

async function sendTelegramHtmlMessage(
	chatId: string,
	html: string,
): Promise<void> {
	try {
		await postTelegramHtmlMessage(chatId, html);
		return;
	} catch (error) {
		if (!isTelegramHtmlParseError(error)) throw error;
	}
	const sanitized = sanitizeTelegramHtml(html);
	try {
		await postTelegramHtmlMessage(chatId, sanitized);
		return;
	} catch (error) {
		if (!isTelegramHtmlParseError(error)) throw error;
	}
	await postTelegramHtmlMessage(chatId, escapeTelegramHtml(html));
}

async function postTelegramHtmlMessage(
	chatId: string,
	text: string,
	replyMarkup?: Record<string, unknown>,
): Promise<void> {
	await telegram("sendMessage", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: "HTML",
			...(replyMarkup ? { reply_markup: replyMarkup } : {}),
		}),
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

const TELEGRAM_HTML_TAGS = new Set([
	"b",
	"strong",
	"i",
	"em",
	"u",
	"ins",
	"s",
	"strike",
	"del",
	"a",
	"code",
	"pre",
	"blockquote",
	"tg-spoiler",
	"tg-emoji",
	"span",
]);

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const ENTITY_RE = /&(?!(?:amp|lt|gt|quot|#\d+|#x[\da-fA-F]+);)/g;

export function sanitizeTelegramHtml(html: string): string {
	const stack: string[] = [];
	const out: string[] = [];
	let cursor = 0;
	TAG_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TAG_RE.exec(html)) !== null) {
		const [full, slash, rawName, rawAttrs] = match;
		const start = match.index;
		if (start > cursor) {
			out.push(escapeTextSegment(html.slice(cursor, start)));
		}
		cursor = start + full.length;
		const name = rawName.toLowerCase();
		const isClose = slash === "/";

		if (!isClose && name === "br") {
			out.push("\n");
			continue;
		}
		if (!TELEGRAM_HTML_TAGS.has(name)) {
			continue;
		}
		if (isClose) {
			const idx = stack.lastIndexOf(name);
			if (idx === -1) continue;
			while (stack.length > idx) {
				out.push(`</${stack.pop()}>`);
			}
			continue;
		}
		const attrs = renderSanitizedAttrs(name, rawAttrs);
		if (attrs === null) continue;
		stack.push(name);
		out.push(`<${name}${attrs}>`);
	}
	if (cursor < html.length) {
		out.push(escapeTextSegment(html.slice(cursor)));
	}
	while (stack.length) {
		out.push(`</${stack.pop()}>`);
	}
	return out.join("");
}

function escapeTextSegment(text: string): string {
	return text
		.replace(ENTITY_RE, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeAttrValue(value: string): string {
	return value.replace(ENTITY_RE, "&amp;").replace(/"/g, "&quot;");
}

function matchQuotedAttr(raw: string, attr: string): string | null {
	const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
	const m = raw.match(re);
	if (!m) return null;
	return (m[2] ?? m[3] ?? "").trim();
}

function renderSanitizedAttrs(tag: string, raw: string): string | null {
	if (tag === "a") {
		const href = matchQuotedAttr(raw, "href");
		if (!href) return null;
		return ` href="${escapeAttrValue(href)}"`;
	}
	if (tag === "code") {
		const cls = matchQuotedAttr(raw, "class");
		if (cls) return ` class="${escapeAttrValue(cls)}"`;
		return "";
	}
	if (tag === "span") {
		const cls = matchQuotedAttr(raw, "class");
		if (cls !== "tg-spoiler") return null;
		return ' class="tg-spoiler"';
	}
	if (tag === "tg-emoji") {
		const id = matchQuotedAttr(raw, "emoji-id");
		if (!id) return null;
		return ` emoji-id="${escapeAttrValue(id)}"`;
	}
	if (tag === "blockquote") {
		if (/\bexpandable\b/i.test(raw)) return " expandable";
		return "";
	}
	return "";
}

function isTelegramHtmlParseError(error: unknown): boolean {
	return errorMessage(error).toLowerCase().includes("can't parse entities");
}

type SplitAtom =
	| { kind: "text"; text: string }
	| { kind: "open"; text: string; name: string }
	| { kind: "close"; text: string; name: string }
	| { kind: "void"; text: string };

const SPLIT_TOKEN_RE =
	/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|&(?:[a-zA-Z]+|#\d+|#x[\da-fA-F]+);/g;

function tokenizeForSplit(html: string): SplitAtom[] {
	const atoms: SplitAtom[] = [];
	let cursor = 0;
	SPLIT_TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = SPLIT_TOKEN_RE.exec(html)) !== null) {
		if (m.index > cursor) {
			atoms.push({ kind: "text", text: html.slice(cursor, m.index) });
		}
		const matched = m[0];
		if (matched.startsWith("<")) {
			const name = m[1].toLowerCase();
			const isClose = matched[1] === "/";
			if (isClose) atoms.push({ kind: "close", text: matched, name });
			else if (name === "br") atoms.push({ kind: "void", text: matched });
			else atoms.push({ kind: "open", text: matched, name });
		} else {
			atoms.push({ kind: "void", text: matched });
		}
		cursor = m.index + matched.length;
	}
	if (cursor < html.length) {
		atoms.push({ kind: "text", text: html.slice(cursor) });
	}
	return atoms;
}

interface SplitFrame {
	name: string;
	openText: string;
}

function splitTelegramMessage(text: string): string[] {
	if (text.length <= TELEGRAM_MAX_MESSAGE) return [text];

	const atoms = tokenizeForSplit(text);
	const chunks: string[] = [];
	let current = "";
	let stack: SplitFrame[] = [];

	const closesFor = (frames: SplitFrame[]) =>
		frames
			.slice()
			.reverse()
			.map((f) => `</${f.name}>`)
			.join("");
	const reopensFor = (frames: SplitFrame[]) =>
		frames.map((f) => f.openText).join("");

	const flush = () => {
		if (current.length === 0) return;
		chunks.push(current + closesFor(stack));
		current = reopensFor(stack);
	};

	const flushIfNeeded = (nextLength: number, nextStack: SplitFrame[]) => {
		const projected =
			current.length + nextLength + closesFor(nextStack).length;
		if (
			projected > TELEGRAM_MAX_MESSAGE &&
			current.length > reopensFor(stack).length
		) {
			flush();
		}
	};

	for (const atom of atoms) {
		if (atom.kind === "open") {
			const nextStack = [
				...stack,
				{ name: atom.name, openText: atom.text },
			];
			flushIfNeeded(atom.text.length, nextStack);
			current += atom.text;
			stack = nextStack;
		} else if (atom.kind === "close") {
			const idx = stack.map((f) => f.name).lastIndexOf(atom.name);
			if (idx === -1) continue;
			const closeStr = stack
				.slice(idx)
				.reverse()
				.map((f) => `</${f.name}>`)
				.join("");
			const nextStack = stack.slice(0, idx);
			flushIfNeeded(closeStr.length, nextStack);
			current += closeStr;
			stack = nextStack;
		} else if (atom.kind === "void") {
			flushIfNeeded(atom.text.length, stack);
			current += atom.text;
		} else {
			let remaining = atom.text;
			while (remaining.length > 0) {
				const room =
					TELEGRAM_MAX_MESSAGE -
					closesFor(stack).length -
					current.length;
				if (room <= 0) {
					flush();
					continue;
				}
				if (remaining.length <= room) {
					current += remaining;
					break;
				}
				let splitAt = remaining.lastIndexOf("\n", room);
				if (splitAt < 0 || splitAt < room / 2) splitAt = room;
				current += remaining.slice(0, splitAt);
				remaining = remaining.slice(splitAt).replace(/^\n/, "");
				flush();
			}
		}
	}

	if (current.length > 0) {
		chunks.push(current + closesFor(stack));
	}

	return chunks.filter((c) => c.length > 0);
}

export function sanitizeError(error: string): string {
	const firstUsefulLine = error
		.split("\n")
		.map((line) => line.trim())
		.find(
			(line) => line && !line.startsWith("at ") && !line.startsWith("node:"),
		);
	const message = firstUsefulLine || "Something went wrong.";
	const truncated = message.length > 500 ? `${message.slice(0, 500)}…` : message;
	return escapeTelegramHtml(truncated);
}
