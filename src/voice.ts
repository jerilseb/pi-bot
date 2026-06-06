import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_TTS_CHARS, TELEGRAM_VOICE_UPLOAD_LIMIT } from "./config.ts";
import {
	synthesizeTtsAudio,
	textToSpeechStatusText,
	type TtsAudioResult,
} from "./speech.ts";
import { telegram } from "./telegram.ts";

const EFFECTIVE_TTS_CHAR_LIMIT = MAX_TTS_CHARS;

const SendVoiceNoteParams = Type.Object({
	text: Type.String({
		description:
			"Text to synthesize and send as a Telegram voice note. Keep it concise and conversational.",
	}),
});

export function voiceStatusText(): string {
	return textToSpeechStatusText();
}

export function telegramVoiceNoteExtension(
	chatId: string,
): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "send_voice_note",
			label: "Send Voice Note",
			description:
				"Send the Telegram user a voice note using the configured text-to-speech provider. Use when the user asks for a voice/audio reply, or when a brief spoken response is clearly more appropriate than text. Avoid using for long code, long lists, or dense technical details unless explicitly requested.",
			promptSnippet:
				"Send a Telegram voice note to the user using the configured TTS provider",
			promptGuidelines: [
				"Use send_voice_note when the user asks for a voice note, audio reply, spoken summary, or says to reply by voice.",
				"You may use it proactively for short personal or time-sensitive messages where voice is clearly helpful.",
				"Keep voice-note text concise and natural. Do not read long code blocks or large tables aloud unless the user explicitly asks.",
				"After sending a voice note, keep the final text response brief, e.g. 'Sent a voice note.'",
			],
			parameters: SendVoiceNoteParams,

			async execute(_toolCallId, params) {
				const result = await sendTelegramVoiceNote(chatId, params.text);
				return {
					content: [
						{
							type: "text",
							text: `Voice note sent (${prepareTtsText(params.text).length} characters).`,
						},
					],
					details: result,
				};
			},
		});
	};
}

export async function sendTelegramVoiceNote(
	chatId: string,
	text: string,
): Promise<TtsAudioResult> {
	const speechText = prepareTtsText(text);
	if (!speechText) {
		throw new Error("Voice note text is empty after cleanup.");
	}

	const result = await synthesizeTtsAudio(speechText);
	if (result.audio.byteLength > TELEGRAM_VOICE_UPLOAD_LIMIT) {
		throw new Error(
			`Generated voice note is too large: ${(result.audio.byteLength / 1024 / 1024).toFixed(1)}MB`,
		);
	}

	const form = new FormData();
	form.append("chat_id", chatId);
	form.append(
		"voice",
		new Blob([result.audio], { type: "audio/ogg" }),
		"pi-reply.ogg",
	);
	await telegram("sendVoice", { method: "POST", body: form });
	return result;
}

function prepareTtsText(text: string): string {
	let cleaned = text
		.replace(/```[\s\S]*?```/g, "Code block omitted from voice note.")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^[-*+]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > EFFECTIVE_TTS_CHAR_LIMIT) {
		cleaned = `${cleaned.slice(0, EFFECTIVE_TTS_CHAR_LIMIT).trimEnd()}… This response was shortened for the voice note.`;
	}

	return cleaned;
}

