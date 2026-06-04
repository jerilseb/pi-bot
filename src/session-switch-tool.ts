import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const StartNewSessionParams = Type.Object({
	task: Type.Optional(
		Type.String({
			description:
				"Optional self-contained task to run automatically in the fresh session after the current response finishes. Include all context the new session needs, especially if the task is based on the current conversation.",
		}),
	),
});

export function telegramNewSessionToolExtension(
	requestNewSession: (task?: string) => Promise<string>,
): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "start_new_session",
			label: "Start New Session",
			description:
				"Start a fresh Pi conversation session for the Telegram assistant without requiring the user to send /new. Optionally provide a self-contained task to run automatically in the fresh session after the current response finishes.",
			promptSnippet:
				"Start a fresh Telegram assistant Pi session, optionally with an initial task for the new session.",
			promptGuidelines: [
				"Use start_new_session only when the user explicitly asks you to start a new session, reset your conversation, or clear the current Pi conversation.",
				"If the user asks to start a new session and do something, provide task with the exact work the fresh session should perform.",
				"The task must be self-contained. If it depends on the current conversation, summarize the relevant current-session context inside task so the fresh session can operate independently.",
				"Do not use this for ordinary topic changes, troubleshooting, model switches, reloads, or restarts unless the user explicitly asks for a fresh session.",
				"The new session is applied after the current response finishes. If task is provided, it will run automatically in the fresh session after that.",
			],
			parameters: StartNewSessionParams,

			async execute(_toolCallId, params) {
				const task = params.task?.trim() || undefined;
				const message = await requestNewSession(task);
				return {
					content: [{ type: "text", text: message }],
					details: { task: task ?? null },
				};
			},
		});
	};
}
