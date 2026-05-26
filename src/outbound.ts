import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DOCUMENT_PATH_REGEX,
	DOCUMENT_UPLOAD_EXTS,
	HEARTBEAT_NOOP,
	LOCAL_DOCUMENT_UPLOAD_DIRS,
	LOCAL_IMAGE_UPLOAD_DIRS,
	MAX_DOCUMENT_UPLOADS,
	MAX_IMAGE_UPLOADS,
	SEND_LOCAL_DOCUMENTS,
	SEND_LOCAL_IMAGES,
	TELEGRAM_DOCUMENT_UPLOAD_LIMIT,
	TELEGRAM_PHOTO_UPLOAD_LIMIT,
} from "./config.ts";
import { sanitizeError, sendTelegramMessage, telegram } from "./telegram.ts";
import type { PiPromptResult } from "./types.ts";

export async function sendPiResponse(
	chatId: string,
	response: PiPromptResult,
	options: { suppressNoop?: boolean } = {},
): Promise<void> {
	if (options.suppressNoop && isHeartbeatNoop(response.text)) {
		console.log(`[${chatId}] heartbeat completed with no user-visible update`);
		return;
	}

	await sendTelegramMessage(chatId, response.text);

	const combinedText = `${response.text}\n${response.toolOutput}`;

	if (SEND_LOCAL_IMAGES) {
		const imagePaths = extractUploadableImagePaths(combinedText).slice(
			0,
			Math.max(0, MAX_IMAGE_UPLOADS),
		);

		for (const imagePath of imagePaths) {
			try {
				await sendTelegramLocalImage(chatId, imagePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[${chatId}] image upload error:`, message);
				await sendTelegramMessage(
					chatId,
					`⚠️ Generated image was saved at ${imagePath}, but I could not upload it: ${sanitizeError(message)}`,
				);
			}
		}
	}

	if (SEND_LOCAL_DOCUMENTS) {
		const documentPaths = extractUploadableDocumentPaths(combinedText).slice(
			0,
			Math.max(0, MAX_DOCUMENT_UPLOADS),
		);

		for (const docPath of documentPaths) {
			try {
				await sendTelegramDocument(chatId, docPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[${chatId}] document upload error:`, message);
				await sendTelegramMessage(
					chatId,
					`⚠️ Generated document was saved at ${docPath}, but I could not upload it: ${sanitizeError(message)}`,
				);
			}
		}
	}
}

function isHeartbeatNoop(text: string): boolean {
	const normalized = text
		.trim()
		.replace(/^```(?:text)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	return normalized === HEARTBEAT_NOOP;
}

function extractUploadableImagePaths(text: string): string[] {
	const matches = text.matchAll(
		/(?:file:\/\/)?(?:~|\/)[^\s"'`<>{}\[\]|]+?\.(?:png|jpe?g|webp|gif)(?=[\s"'`<>{}\[\]|),.;:!?]|$)/gi,
	);
	const paths: string[] = [];
	const seen = new Set<string>();

	for (const match of matches) {
		const normalized = normalizeLocalPath(match[0]);
		if (!normalized || seen.has(normalized)) continue;
		if (!isUploadableImagePath(normalized)) continue;
		seen.add(normalized);
		paths.push(normalized);
	}

	return paths;
}

function extractUploadableDocumentPaths(text: string): string[] {
	if (DOCUMENT_UPLOAD_EXTS.length === 0) return [];
	const matches = text.matchAll(DOCUMENT_PATH_REGEX);
	const paths: string[] = [];
	const seen = new Set<string>();

	for (const match of matches) {
		const normalized = normalizeLocalPath(match[0]);
		if (!normalized || seen.has(normalized)) continue;
		if (!isUploadableDocumentPath(normalized)) continue;
		seen.add(normalized);
		paths.push(normalized);
	}

	return paths;
}

function normalizeLocalPath(candidate: string): string | null {
	let filePath = candidate
		.trim()
		.replace(/^file:\/\//, "")
		.replace(/^[('"`<\[]+/, "")
		.replace(/[)'"`>\],.;:!?]+$/, "");

	if (filePath.startsWith("~/")) {
		filePath = path.join(os.homedir(), filePath.slice(2));
	}

	if (!path.isAbsolute(filePath)) return null;
	return path.resolve(filePath);
}

function isUploadableImagePath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
		return false;
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return false;
	}

	if (!stat.isFile() || stat.size <= 0) return false;
	if (stat.size > TELEGRAM_DOCUMENT_UPLOAD_LIMIT) return false;
	return isUnderAllowedDir(filePath, LOCAL_IMAGE_UPLOAD_DIRS);
}

function isUploadableDocumentPath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
	if (!DOCUMENT_UPLOAD_EXTS.includes(ext)) return false;

	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return false;
	}

	if (!stat.isFile() || stat.size <= 0) return false;
	if (stat.size > TELEGRAM_DOCUMENT_UPLOAD_LIMIT) return false;
	return isUnderAllowedDir(filePath, LOCAL_DOCUMENT_UPLOAD_DIRS);
}

function isUnderAllowedDir(filePath: string, allowedDirs: string[]): boolean {
	let realFile: string;
	try {
		realFile = fs.realpathSync(filePath);
	} catch {
		return false;
	}

	for (const configuredDir of allowedDirs) {
		const expandedDir = configuredDir.startsWith("~/")
			? path.join(os.homedir(), configuredDir.slice(2))
			: configuredDir;
		let allowedDir = path.resolve(expandedDir);
		try {
			allowedDir = fs.realpathSync(allowedDir);
		} catch {
			// The directory may not exist until the first generation.
		}

		if (
			realFile === allowedDir ||
			realFile.startsWith(`${allowedDir}${path.sep}`)
		) {
			return true;
		}
	}

	return false;
}

async function sendTelegramLocalImage(
	chatId: string,
	filePath: string,
): Promise<void> {
	const stat = fs.statSync(filePath);
	const asPhoto = stat.size <= TELEGRAM_PHOTO_UPLOAD_LIMIT;
	const method = asPhoto ? "sendPhoto" : "sendDocument";
	const fieldName = asPhoto ? "photo" : "document";
	const fileBuffer = fs.readFileSync(filePath);
	const form = new FormData();
	form.append("chat_id", chatId);
	form.append(
		fieldName,
		new Blob([fileBuffer], { type: imageMimeType(filePath) }),
		path.basename(filePath),
	);
	form.append("caption", `Generated image: ${path.basename(filePath)}`);

	await telegram(method, { method: "POST", body: form });
}

function imageMimeType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		default:
			return "image/png";
	}
}

async function sendTelegramDocument(
	chatId: string,
	filePath: string,
): Promise<void> {
	const fileBuffer = fs.readFileSync(filePath);
	const form = new FormData();
	form.append("chat_id", chatId);
	form.append(
		"document",
		new Blob([fileBuffer], { type: documentMimeType(filePath) }),
		path.basename(filePath),
	);
	form.append("caption", path.basename(filePath));
	await telegram("sendDocument", { method: "POST", body: form });
}

function documentMimeType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".pdf":
			return "application/pdf";
		case ".doc":
			return "application/msword";
		case ".docx":
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		case ".xls":
			return "application/vnd.ms-excel";
		case ".xlsx":
			return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		case ".ppt":
			return "application/vnd.ms-powerpoint";
		case ".pptx":
			return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
		case ".csv":
			return "text/csv";
		case ".json":
			return "application/json";
		case ".md":
			return "text/markdown";
		case ".txt":
			return "text/plain";
		default:
			return "application/octet-stream";
	}
}
