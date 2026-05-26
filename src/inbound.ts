import * as fs from "node:fs";
import * as path from "node:path";
import {
	ALLOWED_CHAT_ID,
	ELEVENLABS_API_KEY,
	ELEVENLABS_LANGUAGE,
	ELEVENLABS_MODEL,
	TELEGRAM_DOWNLOAD_LIMIT,
	TELEGRAM_FILE_API,
	TMP_DIR,
	TRANSCRIPTION_MAX_FILE_SIZE,
} from "./config.ts";
import { sendChatAction, telegram } from "./telegram.ts";
import type {
	IncomingPrompt,
	TelegramMessage,
	TranscriptionResult,
} from "./types.ts";

export async function toIncomingPrompt(
	message: TelegramMessage,
): Promise<IncomingPrompt | null> {
	const chatId = String(message.chat.id);
	if (chatId !== ALLOWED_CHAT_ID) return null;

	const caption = message.caption?.trim() ?? "";

	if (message.text) {
		return { chatId, text: message.text, attachments: [] };
	}

	if (message.photo?.length) {
		const largest = message.photo[message.photo.length - 1];
		const downloaded = await downloadTelegramFile(
			largest.file_id,
			"photo.jpg",
			largest.file_size,
		);
		if (!downloaded) {
			return {
				chatId,
				text: "⚠️ I could not download that photo.",
				attachments: [],
			};
		}
		return {
			chatId,
			text: caption || "Describe this image.",
			attachments: [
				{
					type: "image",
					path: downloaded.localPath,
					filename: "photo.jpg",
					mimeType: "image/jpeg",
					size: downloaded.size,
				},
			],
		};
	}

	const file =
		message.document ?? message.voice ?? message.audio ?? message.video;
	if (file) {
		const filename = getTelegramFilename(message, file);
		const mimeType = "mime_type" in file ? file.mime_type : undefined;
		const downloaded = await downloadTelegramFile(
			file.file_id,
			filename,
			file.file_size,
		);
		if (!downloaded) {
			return {
				chatId,
				text: `⚠️ I could not download ${filename}.`,
				attachments: [],
			};
		}

		if (isTranscribableAudio(message, mimeType, filename)) {
			void sendChatAction(chatId);
			const transcription = await transcribeWithElevenLabs(
				downloaded.localPath,
			);
			if (transcription.ok && transcription.text) {
				const label = message.voice
					? "🎤 Voice message"
					: `🎵 Audio: ${filename}`;
				const prefix = caption ? `${caption}\n\n` : "";
				return {
					chatId,
					text: `${prefix}${label}: ${transcription.text}`,
					attachments: [],
				};
			}

			const reason = transcription.error
				? ` Transcription failed: ${transcription.error}`
				: " Transcription is not configured.";
			return {
				chatId,
				text: `${caption || `Audio file uploaded: ${filename}.`}${reason}\nLocal file path: ${downloaded.localPath}`,
				attachments: [
					{
						type: "file",
						path: downloaded.localPath,
						filename,
						mimeType,
						size: downloaded.size,
					},
				],
			};
		}

		return {
			chatId,
			text:
				caption ||
				`A file was uploaded: ${filename}. Use the attached local path if you need to inspect it.`,
			attachments: [
				{
					type: "file",
					path: downloaded.localPath,
					filename,
					mimeType,
					size: downloaded.size,
				},
			],
		};
	}

	return null;
}

function getTelegramFilename(
	message: TelegramMessage,
	file: NonNullable<
		| TelegramMessage["document"]
		| TelegramMessage["voice"]
		| TelegramMessage["audio"]
		| TelegramMessage["video"]
	>,
): string {
	if ("file_name" in file && file.file_name) return file.file_name;
	if ("title" in file && file.title) return `${file.title}.mp3`;
	if (message.voice) return "voice.ogg";
	if (message.video) return "video.mp4";
	return "file";
}

function isTranscribableAudio(
	message: TelegramMessage,
	mimeType: string | undefined,
	filename: string,
): boolean {
	if (message.voice || message.audio) return true;
	if (mimeType?.startsWith("audio/")) return true;
	const ext = path.extname(filename).toLowerCase();
	return [
		".mp3",
		".m4a",
		".ogg",
		".oga",
		".wav",
		".webm",
		".flac",
		".aac",
	].includes(ext);
}

async function transcribeWithElevenLabs(
	filePath: string,
): Promise<TranscriptionResult> {
	if (!ELEVENLABS_API_KEY) {
		return {
			ok: false,
			error: "Set ELEVENLABS_API_KEY to enable ElevenLabs transcription.",
		};
	}

	if (!fs.existsSync(filePath))
		return { ok: false, error: `File not found: ${filePath}` };
	const stat = fs.statSync(filePath);
	if (stat.size === 0) return { ok: false, error: "File is empty" };
	if (stat.size > TRANSCRIPTION_MAX_FILE_SIZE) {
		return {
			ok: false,
			error: `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 25MB)`,
		};
	}

	try {
		const form = new FormData();
		const fileBuffer = fs.readFileSync(filePath);
		form.append("file", new Blob([fileBuffer]), path.basename(filePath));
		form.append("model_id", ELEVENLABS_MODEL);
		if (ELEVENLABS_LANGUAGE) form.append("language_code", ELEVENLABS_LANGUAGE);

		const response = await fetch(
			"https://api.elevenlabs.io/v1/speech-to-text",
			{
				method: "POST",
				headers: { "xi-api-key": ELEVENLABS_API_KEY },
				body: form,
			},
		);

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			return {
				ok: false,
				error: `ElevenLabs API error (${response.status}): ${body.slice(0, 200)}`,
			};
		}

		const data = (await response.json()) as { text?: string };
		if (!data.text)
			return { ok: false, error: "ElevenLabs returned empty transcription" };
		return { ok: true, text: data.text };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function downloadTelegramFile(
	fileId: string,
	suggestedName: string,
	knownSize = 0,
): Promise<{ localPath: string; size: number } | null> {
	if (knownSize > TELEGRAM_DOWNLOAD_LIMIT) return null;

	const info = await telegram<{
		ok: boolean;
		result?: { file_path?: string; file_size?: number };
	}>(`getFile?file_id=${encodeURIComponent(fileId)}`);
	if (!info.ok || !info.result?.file_path) return null;
	if ((info.result.file_size ?? 0) > TELEGRAM_DOWNLOAD_LIMIT) return null;

	const res = await fetch(`${TELEGRAM_FILE_API}/${info.result.file_path}`);
	if (!res.ok) return null;

	const buffer = Buffer.from(await res.arrayBuffer());
	if (buffer.length > TELEGRAM_DOWNLOAD_LIMIT) return null;

	const ext =
		path.extname(info.result.file_path) || path.extname(suggestedName) || "";
	const safeBase =
		path
			.basename(suggestedName, path.extname(suggestedName))
			.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
	const localPath = path.join(TMP_DIR, `${Date.now()}-${safeBase}${ext}`);
	fs.writeFileSync(localPath, buffer);
	return { localPath, size: buffer.length };
}
