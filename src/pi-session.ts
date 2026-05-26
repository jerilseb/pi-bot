import * as fs from "node:fs";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SEND_LOCAL_DOCUMENTS, SEND_LOCAL_IMAGES } from "./config.ts";
import type { Attachment, PiPromptResult } from "./types.ts";
import {
	telegramDocumentExtension,
	telegramImageExtension,
} from "./uploads.ts";
import { telegramVoiceNoteExtension } from "./voice.ts";

export interface PiRuntime {
	modelName: string;
	model: Model<Api>;
	authStorage: ReturnType<typeof AuthStorage.create>;
	modelRegistry: ReturnType<typeof ModelRegistry.create>;
	settingsManager: ReturnType<typeof SettingsManager.create>;
	cwd: string;
	getExtensionPaths: () => string[];
	getSkillPaths: () => string[];
	systemPromptOverride: () => string;
	extensionFactories: Array<(pi: ExtensionAPI) => void>;
}

export function createPiRuntime(options: {
	cwd: string;
	openRouterApiKey: string;
	openRouterModel: string;
	getExtensionPaths: () => string[];
	getSkillPaths: () => string[];
	systemPromptOverride: () => string;
	extensionFactories?: Array<(pi: ExtensionAPI) => void>;
}): PiRuntime {
	const authStorage = AuthStorage.create();
	authStorage.setRuntimeApiKey("openrouter", options.openRouterApiKey);

	const modelRegistry = ModelRegistry.create(authStorage);
	const model = resolveOpenRouterModel(modelRegistry, options.openRouterModel);
	const settingsManager = SettingsManager.create(options.cwd, getAgentDir());

	return {
		modelName: options.openRouterModel,
		model,
		authStorage,
		modelRegistry,
		settingsManager,
		cwd: options.cwd,
		getExtensionPaths: options.getExtensionPaths,
		getSkillPaths: options.getSkillPaths,
		systemPromptOverride: options.systemPromptOverride,
		extensionFactories: options.extensionFactories ?? [],
	};
}

function resolveOpenRouterModel(
	modelRegistry: ReturnType<typeof ModelRegistry.create>,
	modelName: string,
): Model<Api> {
	const model = modelRegistry.find("openrouter", modelName);
	if (!model) {
		throw new Error(`Unknown OpenRouter model: ${modelName}`);
	}
	return model;
}

export class SdkPiSession {
	private session: AgentSession | null = null;
	private starting: Promise<AgentSession> | null = null;
	private runtime: PiRuntime;
	private chatId: string;

	constructor(runtime: PiRuntime, chatId: string) {
		this.runtime = runtime;
		this.chatId = chatId;
	}

	async runPrompt(
		text: string,
		attachments: Attachment[],
	): Promise<PiPromptResult> {
		const session = await this.start();
		if (session.isStreaming) {
			throw new Error("Pi SDK session is already processing a prompt");
		}

		const chunks: string[] = [];
		const toolOutputs: string[] = [];
		let errorMessage = "";
		const unsubscribe = session.subscribe((event) => {
			this.collectPromptEvent(event, chunks, toolOutputs, (message) => {
				errorMessage = message;
			});
		});

		try {
			const prompt = buildPiPrompt(text, attachments);
			await session.prompt(prompt.message, {
				...(prompt.images?.length ? { images: prompt.images } : {}),
			});

			if (errorMessage) throw new Error(errorMessage);

			return {
				text: chunks.join("").trim() || "(no response)",
				toolOutput: toolOutputs.join("\n"),
			};
		} finally {
			unsubscribe();
		}
	}

	abort(): void {
		void this.session?.abort();
	}

	reset(): void {
		this.cleanup();
	}

	cleanup(): void {
		this.session?.dispose();
		this.session = null;
		this.starting = null;
	}

	private async start(): Promise<AgentSession> {
		if (this.session) return this.session;
		if (this.starting) return this.starting;

		this.starting = this.createSession();
		try {
			this.session = await this.starting;
			return this.session;
		} finally {
			this.starting = null;
		}
	}

	private async createSession(): Promise<AgentSession> {
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.runtime.cwd,
			agentDir: getAgentDir(),
			settingsManager: this.runtime.settingsManager,
			noExtensions: true,
			noSkills: true,
			additionalExtensionPaths: this.runtime.getExtensionPaths(),
			additionalSkillPaths: this.runtime.getSkillPaths(),
			extensionFactories: [
				...this.runtime.extensionFactories,
				telegramVoiceNoteExtension(this.chatId),
				...(SEND_LOCAL_IMAGES ? [telegramImageExtension(this.chatId)] : []),
				...(SEND_LOCAL_DOCUMENTS
					? [telegramDocumentExtension(this.chatId)]
					: []),
			],
			systemPromptOverride: this.runtime.systemPromptOverride,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: this.runtime.cwd,
			model: this.runtime.model,
			authStorage: this.runtime.authStorage,
			modelRegistry: this.runtime.modelRegistry,
			resourceLoader,
			sessionManager: SessionManager.inMemory(this.runtime.cwd),
			settingsManager: this.runtime.settingsManager,
		});

		return session;
	}

	private collectPromptEvent(
		event: AgentSessionEvent,
		chunks: string[],
		toolOutputs: string[],
		setError: (message: string) => void,
	): void {
		if (event.type === "message_update") {
			const delta = event.assistantMessageEvent;
			if (delta.type === "text_delta") {
				chunks.push(delta.delta);
			}
			if (delta.type === "error") {
				setError(
					delta.error.errorMessage ||
						"Pi agent failed while generating a response",
				);
			}
		}

		if (event.type === "tool_execution_end") {
			const output = extractToolResultText(event.result);
			if (output) toolOutputs.push(output);
		}

		if (event.type === "agent_end") {
			const failed = event.messages.find(
				(message) => message.role === "assistant" && message.errorMessage,
			);
			if (failed?.role === "assistant" && failed.errorMessage) {
				setError(failed.errorMessage);
			}
		}
	}
}

function buildPiPrompt(
	text: string,
	attachments: Attachment[],
): {
	message: string;
	images?: ImageContent[];
} {
	const images: ImageContent[] = [];
	const files: string[] = [];

	for (const attachment of attachments) {
		if (attachment.type === "image") {
			images.push({
				type: "image",
				data: fs.readFileSync(attachment.path).toString("base64"),
				mimeType: attachment.mimeType || "image/jpeg",
			});
		} else {
			files.push(
				attachment.filename
					? `${attachment.filename}: ${attachment.path}`
					: attachment.path,
			);
		}
	}

	const filePrefix =
		files.length > 0
			? `[Attached files saved locally]\n${files.map((f) => `- ${f}`).join("\n")}\n\n`
			: "";

	return {
		message: `${filePrefix}${text}`,
		...(images.length > 0 ? { images } : {}),
	};
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object" || !("content" in result))
		return "";

	const content = result.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && "text" in part) {
				return typeof part.text === "string" ? part.text : "";
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}
