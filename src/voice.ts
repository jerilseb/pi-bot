import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ELEVENLABS_API_KEY,
	ELEVENLABS_TTS_MODEL,
	ELEVENLABS_TTS_OUTPUT_FORMAT,
	ELEVENLABS_TTS_VOICE_ID,
	MAX_TTS_CHARS,
	TELEGRAM_VOICE_UPLOAD_LIMIT,
} from "./config.ts";

const MODEL_CHAR_LIMITS: Record<string, number> = {
	eleven_v3: 2500,
};
const EFFECTIVE_TTS_CHAR_LIMIT = Math.min(
	MAX_TTS_CHARS,
	MODEL_CHAR_LIMITS[ELEVENLABS_TTS_MODEL] ?? Number.POSITIVE_INFINITY,
);
import { telegram } from "./telegram.ts";

const SendVoiceNoteParams = Type.Object({
	text: Type.String({
		description:
			"Text to synthesize and send as a Telegram voice note. Keep it concise and conversational.",
	}),
});

export function voiceNotesConfigured(): boolean {
	return Boolean(ELEVENLABS_API_KEY && ELEVENLABS_TTS_VOICE_ID);
}

export function telegramVoiceNoteExtension(
	chatId: string,
): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "send_voice_note",
			label: "Send Voice Note",
			description:
				"Send the Telegram user a voice note using ElevenLabs text-to-speech. Use when the user asks for a voice/audio reply, or when a brief spoken response is clearly more appropriate than text. Avoid using for long code, long lists, or dense technical details unless explicitly requested.",
			promptSnippet:
				"Send a Telegram voice note to the user using ElevenLabs TTS",
			promptGuidelines: [
				"Use send_voice_note when the user asks for a voice note, audio reply, spoken summary, or says to reply by voice.",
				"You may use it proactively for short personal or time-sensitive messages where voice is clearly helpful.",
				"Keep voice-note text concise and natural. Do not read long code blocks or large tables aloud unless the user explicitly asks.",
				"After sending a voice note, keep the final text response brief, e.g. 'Sent a voice note.'",
			],
			parameters: SendVoiceNoteParams,

			async execute(_toolCallId, params) {
				await sendTelegramVoiceNote(chatId, params.text);
				return {
					content: [
						{
							type: "text",
							text: `Voice note sent (${prepareTtsText(params.text).length} characters).`,
						},
					],
					details: {
						model: ELEVENLABS_TTS_MODEL,
						outputFormat: ELEVENLABS_TTS_OUTPUT_FORMAT,
					},
				};
			},
		});
	};
}

export async function sendTelegramVoiceNote(
	chatId: string,
	text: string,
): Promise<void> {
	const apiKey = ELEVENLABS_API_KEY;
	const voiceId = ELEVENLABS_TTS_VOICE_ID;
	if (!apiKey) {
		throw new Error("Set ELEVENLABS_API_KEY to enable ElevenLabs voice notes.");
	}
	if (!voiceId) {
		throw new Error(
			"Set ELEVENLABS_TTS_VOICE_ID to enable ElevenLabs voice notes.",
		);
	}

	const speechText = prepareTtsText(text);
	if (!speechText) return;

	const audio = await synthesizeWithElevenLabs(speechText, apiKey, voiceId);
	if (audio.byteLength > TELEGRAM_VOICE_UPLOAD_LIMIT) {
		throw new Error(
			`Generated voice note is too large: ${(audio.byteLength / 1024 / 1024).toFixed(1)}MB`,
		);
	}

	const form = new FormData();
	form.append("chat_id", chatId);
	form.append(
		"voice",
		new Blob([audio], { type: "audio/ogg" }),
		"pi-reply.ogg",
	);
	await telegram("sendVoice", { method: "POST", body: form });
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

async function synthesizeWithElevenLabs(
	text: string,
	apiKey: string,
	voiceId: string,
): Promise<ArrayBuffer> {
	const query = new URLSearchParams({
		output_format: ELEVENLABS_TTS_OUTPUT_FORMAT,
	});
	const response = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?${query}`,
		{
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"Content-Type": "application/json",
				Accept: "audio/ogg",
			},
			body: JSON.stringify({
				text,
				model_id: ELEVENLABS_TTS_MODEL,
			}),
		},
	);

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`ElevenLabs TTS API error (${response.status}): ${body.slice(0, 300) || response.statusText}`,
		);
	}

	return response.arrayBuffer();
}
