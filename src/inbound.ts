import * as fs from "node:fs";
import * as path from "node:path";
import {
	ALLOWED_CHAT_ID,
	TELEGRAM_DOWNLOAD_LIMIT,
	TELEGRAM_FILE_API,
	TMP_DIR,
} from "./config.ts";
import { transcribeAudio } from "./speech.ts";
import { sendChatAction, telegram } from "./telegram.ts";
import type { IncomingPrompt, TelegramMessage } from "./types.ts";

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
			const transcription = await transcribeAudio(
				downloaded.localPath,
				mimeType,
				filename,
			);
			if (transcription.ok && transcription.text) {
				deleteLocalFile(downloaded.localPath);
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

function deleteLocalFile(filePath: string): void {
	try {
		fs.unlinkSync(filePath);
	} catch {
		// Best-effort cleanup.
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
