import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	EXTENSION_ENTRYPOINT_EXTS,
	FILES_DIR,
	HEARTBEAT_FILE_PATH,
	HEARTBEAT_NOOP,
	HEARTBEAT_STATE_PATH,
	MEMORY_PATH,
	SYSTEM_PROMPT_PATH,
} from "./config.ts";

export function discoverExtensionPaths(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];

	return fs
		.readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			if (entry.name.startsWith(".") || entry.name === "node_modules")
				return [];

			const entryPath = path.join(directory, entry.name);
			if (entry.isFile()) {
				return EXTENSION_ENTRYPOINT_EXTS.has(
					path.extname(entry.name).toLowerCase(),
				)
					? [entryPath]
					: [];
			}

			if (entry.isDirectory() && isExtensionDirectory(entryPath)) {
				return [entryPath];
			}

			return [];
		})
		.sort((a, b) => a.localeCompare(b));
}

function isExtensionDirectory(directory: string): boolean {
	return [
		"index.ts",
		"index.js",
		"index.mjs",
		"index.cjs",
		"package.json",
	].some((entrypoint) => fs.existsSync(path.join(directory, entrypoint)));
}

export function discoverSkillPaths(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];

	const paths: string[] = [];
	const seen = new Set<string>();

	const add = (skillPath: string) => {
		const normalized = path.resolve(skillPath);
		if (seen.has(normalized)) return;
		seen.add(normalized);
		paths.push(normalized);
	};

	const walk = (current: string) => {
		if (fs.existsSync(path.join(current, "SKILL.md"))) {
			add(current);
			return;
		}

		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				walk(entryPath);
				continue;
			}

			if (
				current === directory &&
				entry.isFile() &&
				path.extname(entry.name).toLowerCase() === ".md" &&
				entry.name.toLowerCase() !== "readme.md"
			) {
				add(entryPath);
			}
		}
	};

	walk(directory);
	return paths.sort((a, b) => a.localeCompare(b));
}

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

const ALLOWED_ENV_FILE = ".env.example";

export function protectedEnvToolAccessExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (event.toolName === "read") {
			const readPath = extractStringProperty(event.input, "path");
			if (readPath && isProtectedEnvPath(readPath)) {
				return {
					block: true,
					reason: `The read tool may access ${ALLOWED_ENV_FILE} only; other .env files are protected.`,
				};
			}
		}

		if (event.toolName === "bash") {
			const command = extractStringProperty(event.input, "command");
			if (command && bashCommandMentionsProtectedEnv(command)) {
				return {
					block: true,
					reason: `The bash tool may access ${ALLOWED_ENV_FILE} only; other .env files are protected.`,
				};
			}
		}

		return undefined;
	});
}

function extractStringProperty(value: unknown, key: string): string | null {
	if (!value || typeof value !== "object" || !(key in value)) return null;

	const property = (value as Record<string, unknown>)[key];
	return typeof property === "string" ? property : null;
}

function isProtectedEnvPath(filePath: string): boolean {
	return filePath
		.replace(/\\/g, "/")
		.split("/")
		.some((segment) => isProtectedEnvFileName(segment));
}

function bashCommandMentionsProtectedEnv(command: string): boolean {
	let index = command.indexOf(".env");
	while (index !== -1) {
		if (isShellPathBoundary(command[index - 1])) {
			const fileName = extractEnvFileNameAt(command, index);
			if (isProtectedEnvFileName(fileName)) return true;
		}
		index = command.indexOf(".env", index + 4);
	}

	return false;
}

function extractEnvFileNameAt(text: string, index: number): string {
	let end = index + ".env".length;
	while (end < text.length && /[A-Za-z0-9_.-]/.test(text[end])) {
		end++;
	}
	return text.slice(index, end);
}

function isShellPathBoundary(char: string | undefined): boolean {
	return !char || /[\s"'`=:/\\({[;|&<>]/.test(char);
}

function isProtectedEnvFileName(fileName: string): boolean {
	return (
		fileName === ".env" ||
		(fileName.startsWith(".env.") && fileName !== ALLOWED_ENV_FILE)
	);
}

function extractHeartbeatInstructions(content: string): string {
	const trimmed = content.trim();
	const body = trimmed.replace(/^#\s*(?:Heartbeat|Heatbeat)\s*/i, "").trim();
	return body ? trimmed : "";
}

export function readHeartbeatInstructions(): {
	filePath: string;
	instructions: string;
} {
	if (!fs.existsSync(HEARTBEAT_FILE_PATH)) {
		return { filePath: HEARTBEAT_FILE_PATH, instructions: "" };
	}

	const instructions = extractHeartbeatInstructions(
		fs.readFileSync(HEARTBEAT_FILE_PATH, "utf8"),
	);
	return { filePath: HEARTBEAT_FILE_PATH, instructions };
}

export function buildHeartbeatPrompt(
	instructions: string,
	filePath: string,
): string {
	return [
		"This is a scheduled heartbeat run for the Telegram assistant.",
		`Heartbeat file: ${filePath}`,
		"",
		"Read and follow these heartbeat instructions:",
		"<heartbeat_instructions>",
		instructions,
		"</heartbeat_instructions>",
		"",
		`If you need durable heartbeat state, create or update ${HEARTBEAT_STATE_PATH}.`,
		"Only notify the Telegram user when there is something important, actionable, or explicitly requested by the heartbeat instructions.",
		`If there is nothing user-visible to report, respond exactly: ${HEARTBEAT_NOOP}`,
	].join("\n");
}
