import type { IncomingPrompt } from "./types.ts";

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isBackgroundSource(
	source: IncomingPrompt["source"],
): boolean {
	return source === "heartbeat" || source === "cron";
}
