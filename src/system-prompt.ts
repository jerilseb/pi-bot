import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ACTIVE_MODEL_PATH,
	FILES_DIR,
	MEMORY_PATH,
	SYSTEM_PROMPT_PATH,
} from "./config.ts";

export function readSystemPrompt(): string {
	return fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8").trim();
}

export function ensureMemoryFile(): void {
	fs.mkdirSync(FILES_DIR, { recursive: true });
	if (!fs.existsSync(MEMORY_PATH)) {
		fs.writeFileSync(MEMORY_PATH, "# Memory\n\n", "utf8");
	}
}

function readMemory(): string {
	ensureMemoryFile();
	const content = fs.readFileSync(MEMORY_PATH, "utf8").trim();
	const body = content.replace(/^# Memory\s*/i, "").trim();
	return body ? content : "";
}

function appendMemoryToSystemPrompt(systemPrompt: string): string {
	const memory = readMemory();
	return `${systemPrompt}\n\n## Long-term memory\nMemory file: ${MEMORY_PATH}\n\n${memory || "(No saved memories yet.)"}`;
}

export function memorySystemPromptExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: appendMemoryToSystemPrompt(event.systemPrompt),
	}));
}

function appendActiveModelToSystemPrompt(systemPrompt: string): string {
	return [
		systemPrompt,
		"",
		"## Active model state",
		`The bot stores the active chat model ref in ${ACTIVE_MODEL_PATH}.`,
		"The heartbeat/cron background model is configured only by the BACKGROUND_MODEL environment variable and cannot be changed from Telegram.",
		"Model refs use provider/model form, for example openrouter/openai/gpt-5.4-mini or openai-codex/gpt-5.5.",
		"Read the active chat model file if you need to know which chat model is currently active.",
		"When the Telegram user changes chat models with /models, the bot updates this file.",
	].join("\n");
}

export function activeModelSystemPromptExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: appendActiveModelToSystemPrompt(event.systemPrompt),
	}));
}
