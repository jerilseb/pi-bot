import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ALLOWED_ENV_FILE = ".env.example";

/**
 * Blocks read/bash tool calls that would touch any `.env` file other than the
 * checked-in `.env.example`, keeping secrets out of the agent's reach.
 */
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
