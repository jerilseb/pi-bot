export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

export interface TelegramMessage {
	message_id: number;
	from?: { id: number; username?: string; first_name?: string };
	chat: { id: number; type: string; title?: string };
	date: number;
	text?: string;
	caption?: string;
	photo?: Array<{
		file_id: string;
		width: number;
		height: number;
		file_size?: number;
	}>;
	document?: {
		file_id: string;
		file_name?: string;
		mime_type?: string;
		file_size?: number;
	};
	voice?: {
		file_id: string;
		duration: number;
		mime_type?: string;
		file_size?: number;
	};
	audio?: {
		file_id: string;
		file_name?: string;
		title?: string;
		mime_type?: string;
		file_size?: number;
	};
	video?: {
		file_id: string;
		file_name?: string;
		mime_type?: string;
		file_size?: number;
	};
}

export interface Attachment {
	type: "image" | "file";
	path: string;
	filename?: string;
	mimeType?: string;
	size?: number;
}

export interface IncomingPrompt {
	chatId: string;
	text: string;
	attachments: Attachment[];
	source?: "telegram" | "heartbeat" | "cron";
	suppressNoop?: boolean;
}

export interface PiPromptResult {
	text: string;
	toolOutput: string;
}

export interface TranscriptionResult {
	ok: boolean;
	text?: string;
	error?: string;
}
