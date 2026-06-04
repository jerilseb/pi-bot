import * as fs from "node:fs";
import * as path from "node:path";
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
import {
	DAILY_MEMORY_DIR,
	MEMORY_PATH,
	OPENAI_CODEX_API_KEY,
	OPENROUTER_API_KEY,
	SEND_LOCAL_DOCUMENTS,
	SEND_LOCAL_IMAGES,
	SESSIONS_DIR,
} from "./config.ts";
import type { Attachment, PiPromptResult } from "./types.ts";
import {
	formatModelRef,
	parseModelRef,
	type ModelRef,
} from "./util.ts";
import {
	telegramDocumentExtension,
	telegramImageExtension,
} from "./uploads.ts";
import { telegramRestartToolExtension } from "./restart-tool.ts";
import { telegramVoiceNoteExtension } from "./voice.ts";

export interface PiRunPromptOptions {
	onToolCall?: (notification: string) => void;
}

export interface PiRuntime {
	modelName: string;
	model: Model<Api>;
	authStorage: ReturnType<typeof AuthStorage.create>;
	modelRegistry: ReturnType<typeof ModelRegistry.create>;
	settingsManager: ReturnType<typeof SettingsManager.create>;
	cwd: string;
	sessionDir: string;
	sessionPrefix: string;
	getExtensionPaths: () => string[];
	getSkillPaths: () => string[];
	systemPromptOverride: () => string;
	extensionFactories: Array<(pi: ExtensionAPI) => void>;
	requestRestart?: () => Promise<void>;
	writeModelState: (model: string) => void;
}

export function createPiRuntime(options: {
	cwd: string;
	model: string;
	sessionPrefix: string;
	getExtensionPaths: () => string[];
	getSkillPaths: () => string[];
	systemPromptOverride: () => string;
	extensionFactories?: Array<(pi: ExtensionAPI) => void>;
	requestRestart?: () => Promise<void>;
	writeModelState: (model: string) => void;
}): PiRuntime {
	const authStorage = AuthStorage.create();
	if (OPENROUTER_API_KEY) {
		authStorage.setRuntimeApiKey("openrouter", OPENROUTER_API_KEY);
	}
	if (OPENAI_CODEX_API_KEY) {
		authStorage.setRuntimeApiKey("openai-codex", OPENAI_CODEX_API_KEY);
	}

	const modelRegistry = ModelRegistry.create(authStorage);
	const selectedModelRef = parseModelRef(options.model);
	const model = resolveModel(modelRegistry, selectedModelRef);
	ensureConfiguredAuth(modelRegistry, model, selectedModelRef);
	const settingsManager = SettingsManager.create(options.cwd, getAgentDir());

	return {
		modelName: formatModelRef(selectedModelRef),
		model,
		authStorage,
		modelRegistry,
		settingsManager,
		cwd: options.cwd,
		sessionDir: SESSIONS_DIR,
		sessionPrefix: options.sessionPrefix,
		getExtensionPaths: options.getExtensionPaths,
		getSkillPaths: options.getSkillPaths,
		systemPromptOverride: options.systemPromptOverride,
		extensionFactories: options.extensionFactories ?? [],
		...(options.requestRestart ? { requestRestart: options.requestRestart } : {}),
		writeModelState: options.writeModelState,
	};
}

function resolveModel(
	modelRegistry: ReturnType<typeof ModelRegistry.create>,
	modelRef: ModelRef,
): Model<Api> {
	const model = modelRegistry.find(modelRef.provider, modelRef.model);
	if (!model) {
		throw new Error(`Unknown model: ${formatModelRef(modelRef)}`);
	}
	return model;
}

function ensureConfiguredAuth(
	modelRegistry: ReturnType<typeof ModelRegistry.create>,
	model: Model<Api>,
	modelRef: ModelRef,
): void {
	if (!modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`No auth configured for ${formatModelRef(modelRef)}`);
	}
}

export class SdkPiSession {
	private session: AgentSession | null = null;
	private starting: Promise<AgentSession> | null = null;
	private runtime: PiRuntime;
	private chatId: string;
	private selectedModelRef: ModelRef;
	private selectedModel: Model<Api>;
	private forceNewSessionOnNextStart = false;

	constructor(runtime: PiRuntime, chatId: string) {
		this.runtime = runtime;
		this.chatId = chatId;
		this.selectedModelRef = parseModelRef(runtime.modelName);
		this.selectedModel = resolveModel(runtime.modelRegistry, this.selectedModelRef);
	}

	get modelName(): string {
		return formatModelRef(this.selectedModelRef);
	}

	async setModel(modelName: string): Promise<void> {
		const modelRef = parseModelRef(modelName);
		this.runtime.modelRegistry.refresh();
		const model = resolveModel(this.runtime.modelRegistry, modelRef);
		ensureConfiguredAuth(this.runtime.modelRegistry, model, modelRef);

		if (this.session?.isStreaming) {
			throw new Error("Cannot switch models while Pi is responding");
		}

		if (this.session) {
			await this.session.setModel(model);
		}

		const formatted = formatModelRef(modelRef);
		this.runtime.writeModelState(formatted);
		this.runtime.modelName = formatted;
		this.runtime.model = model;
		this.selectedModelRef = modelRef;
		this.selectedModel = model;
	}

	async runPrompt(
		text: string,
		attachments: Attachment[],
		options: PiRunPromptOptions = {},
	): Promise<PiPromptResult> {
		const session = await this.start();
		if (session.isStreaming) {
			throw new Error("Pi SDK session is already processing a prompt");
		}

		const chunks: string[] = [];
		const toolOutputs: string[] = [];
		let errorMessage = "";
		const unsubscribe = session.subscribe((event) => {
			this.collectPromptEvent(
				event,
				session,
				chunks,
				toolOutputs,
				(message) => {
					errorMessage = message;
				},
				options.onToolCall,
			);
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

	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		return this.runtime.modelRegistry.getApiKeyForProvider(provider);
	}

	abort(): void {
		void this.session?.abort();
	}

	reset(): void {
		this.cleanup();
		this.forceNewSessionOnNextStart = true;
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
				...(this.runtime.requestRestart
					? [telegramRestartToolExtension(this.chatId, this.runtime.requestRestart)]
					: []),
				telegramVoiceNoteExtension(this.chatId),
				...(SEND_LOCAL_IMAGES ? [telegramImageExtension(this.chatId)] : []),
				...(SEND_LOCAL_DOCUMENTS
					? [telegramDocumentExtension(this.chatId)]
					: []),
			],
			systemPromptOverride: this.runtime.systemPromptOverride,
		});
		await resourceLoader.reload();

		const sessionManager = await this.createSessionManager();
		const { session } = await createAgentSession({
			cwd: this.runtime.cwd,
			model: this.selectedModel,
			authStorage: this.runtime.authStorage,
			modelRegistry: this.runtime.modelRegistry,
			resourceLoader,
			sessionManager,
			settingsManager: this.runtime.settingsManager,
		});

		this.forceNewSessionOnNextStart = false;
		return session;
	}

	private async createSessionManager(): Promise<SessionManager> {
		const sessionId = buildTelegramSessionId(
			this.runtime.sessionPrefix,
			this.chatId,
		);

		if (!this.forceNewSessionOnNextStart) {
			const existingSession = await findMostRecentSessionForId(
				this.runtime.cwd,
				this.runtime.sessionDir,
				sessionId,
			);
			if (existingSession) {
				return SessionManager.open(
					existingSession.path,
					this.runtime.sessionDir,
					this.runtime.cwd,
				);
			}
		}

		return SessionManager.create(this.runtime.cwd, this.runtime.sessionDir, {
			id: sessionId,
		});
	}

	private collectPromptEvent(
		event: AgentSessionEvent,
		session: AgentSession,
		chunks: string[],
		toolOutputs: string[],
		setError: (message: string) => void,
		onToolCall: ((notification: string) => void) | undefined,
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

		if (event.type === "tool_execution_start") {
			onToolCall?.(formatToolStartNotification(event, session, this.runtime.cwd));
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

function buildTelegramSessionId(prefix: string, chatId: string): string {
	const sanitized = `${prefix}-${chatId}`
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[^A-Za-z0-9]+/, "")
		.replace(/[^A-Za-z0-9]+$/, "");

	return sanitized || `${prefix}-unknown`;
}

async function findMostRecentSessionForId(
	cwd: string,
	sessionDir: string,
	sessionId: string,
): Promise<{ path: string } | null> {
	const sessions = await SessionManager.list(cwd, sessionDir);
	return (
		sessions
			.filter((session) => session.id === sessionId)
			.sort((a, b) => b.modified.getTime() - a.modified.getTime())[0] ?? null
	);
}

function formatToolStartNotification(
	event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
	session: AgentSession,
	cwd: string,
): string {
	const memoryUpdateKind = getMemoryUpdateKind(event, cwd);
	if (memoryUpdateKind === "long-term") return "🧠 memory updated";
	if (memoryUpdateKind === "daily") return "🧠 daily memory updated";

	const skillName = skillNameForReadTool(event, session, cwd);
	return skillName ? `📗 ${skillName}` : `🛠 ${event.toolName}`;
}

function getMemoryUpdateKind(
	event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
	cwd: string,
): "long-term" | "daily" | null {
	if (event.toolName !== "edit" && event.toolName !== "write") return null;

	const editPath = extractToolPath(event.args);
	if (!editPath) return null;

	const normalizedEditPath = normalizeFilePath(editPath, cwd);
	if (normalizedEditPath === normalizeFilePath(MEMORY_PATH, cwd)) {
		return "long-term";
	}
	if (isPathInside(normalizedEditPath, normalizeFilePath(DAILY_MEMORY_DIR, cwd))) {
		return "daily";
	}
	return null;
}

function skillNameForReadTool(
	event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
	session: AgentSession,
	cwd: string,
): string | null {
	if (event.toolName !== "read") return null;

	const readPath = extractToolPath(event.args);
	if (!readPath) return null;

	const normalizedReadPath = normalizeFilePath(readPath, cwd);
	const skill = session.resourceLoader
		.getSkills()
		.skills.find(
			(skill) => normalizeFilePath(skill.filePath, cwd) === normalizedReadPath,
		);

	return skill?.name ?? null;
}

function extractToolPath(args: unknown): string | null {
	if (!args || typeof args !== "object" || !("path" in args)) return null;
	return typeof args.path === "string" ? args.path : null;
}

function normalizeFilePath(filePath: string, cwd: string): string {
	const absolutePath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(cwd, filePath);
	try {
		return fs.realpathSync.native(absolutePath);
	} catch {
		return path.normalize(absolutePath);
	}
}

function isPathInside(filePath: string, directoryPath: string): boolean {
	const relativePath = path.relative(directoryPath, filePath);
	return Boolean(
		relativePath &&
			!relativePath.startsWith("..") &&
			!path.isAbsolute(relativePath),
	);
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
