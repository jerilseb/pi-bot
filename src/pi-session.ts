import * as fs from 'node:fs';
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type AgentSessionEvent,
  type SessionStats,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  OPENAI_CODEX_API_KEY,
  OPENROUTER_API_KEY,
  SEND_LOCAL_DOCUMENTS,
  SEND_LOCAL_IMAGES,
  SESSIONS_DIR,
  TOOL_DATA_CAP_BYTES,
  WEB_TOOL_UPDATE_THROTTLE_MS,
} from './config.ts';
import { backgroundBashExtension } from './background-bash.ts';
import { formatToolStartLabel } from './tool-notifications.ts';
import type { Attachment, PiPromptResult } from './types.ts';
import { formatModelRef, parseModelRef, type ModelRef } from './util.ts';
import { documentUploadExtension, imageUploadExtension } from './uploads.ts';
import { restartToolExtension } from './restart-tool.ts';
import { newSessionToolExtension } from './session-switch-tool.ts';
import { subagentToolsExtension } from './subagents.ts';
import { webMenuExtension } from './web/menu.ts';
import { webVoiceNoteExtension } from './voice.ts';
import type { PiStreamEvent } from './web/protocol.ts';

export interface PiRunPromptOptions {
  /** Streams normalized Pi events for live rendering. Each call carries no runId;
   * the caller tags events with the runId for this run. */
  onEvent?: (event: PiStreamEvent) => void;
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
    authStorage.setRuntimeApiKey('openrouter', OPENROUTER_API_KEY);
  }
  if (OPENAI_CODEX_API_KEY) {
    authStorage.setRuntimeApiKey('openai-codex', OPENAI_CODEX_API_KEY);
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
  private pendingNewSessionRequest = false;
  private pendingNewSessionTask: string | null = null;

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
      throw new Error('Cannot switch models while Pi is responding');
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
      throw new Error('Pi SDK session is already processing a prompt');
    }

    const chunks: string[] = [];
    const toolOutputs: string[] = [];
    let errorMessage = '';
    const toolUpdateLastSent = new Map<string, number>();
    const toolArgs = new Map<string, string>();
    const unsubscribe = session.subscribe((event) => {
      this.collectPromptEvent(
        event,
        session,
        chunks,
        toolOutputs,
        (message) => {
          errorMessage = message;
        },
        options.onEvent,
        toolUpdateLastSent,
        toolArgs,
      );
    });

    try {
      const prompt = buildPiPrompt(text, attachments);
      await session.prompt(prompt.message, {
        ...(prompt.images?.length ? { images: prompt.images } : {}),
      });

      if (errorMessage) throw new Error(errorMessage);

      return {
        text: chunks.join('').trim() || '(no response)',
        toolOutput: toolOutputs.join('\n'),
      };
    } finally {
      unsubscribe();
      this.applyPendingNewSession();
    }
  }

  async requestNewSession(task?: string): Promise<string> {
    this.pendingNewSessionRequest = true;
    this.pendingNewSessionTask = task?.trim() || null;
    return this.pendingNewSessionTask
      ? 'Fresh session queued. The provided task will run automatically in the new Pi conversation after the current response finishes.'
      : 'Fresh session queued. The next user message will start a new Pi conversation.';
  }

  consumePendingNewSessionTask(): string | null {
    const task = this.pendingNewSessionTask;
    this.pendingNewSessionTask = null;
    return task;
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    return this.runtime.modelRegistry.getApiKeyForProvider(provider);
  }

  getSessionStats(): SessionStats | null {
    return this.session?.getSessionStats() ?? null;
  }

  abort(): void {
    void this.session?.abort();
  }

  reset(): void {
    this.cleanup();
    this.pendingNewSessionRequest = false;
    this.pendingNewSessionTask = null;
    this.forceNewSessionOnNextStart = true;
  }

  cleanup(): void {
    this.session?.dispose();
    this.session = null;
    this.starting = null;
  }

  private applyPendingNewSession(): void {
    if (!this.pendingNewSessionRequest) return;

    this.pendingNewSessionRequest = false;
    this.cleanup();
    this.forceNewSessionOnNextStart = true;
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
          ? [restartToolExtension(this.chatId, this.runtime.requestRestart)]
          : []),
        newSessionToolExtension((task) => this.requestNewSession(task)),
        subagentToolsExtension(this.chatId, this.runtime),
        webMenuExtension(this.chatId),
        webVoiceNoteExtension(this.chatId),
        backgroundBashExtension(this.chatId),
        ...(SEND_LOCAL_IMAGES ? [imageUploadExtension(this.chatId)] : []),
        ...(SEND_LOCAL_DOCUMENTS ? [documentUploadExtension(this.chatId)] : []),
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
    const sessionId = buildSessionId(this.runtime.sessionPrefix, this.chatId);

    if (!this.forceNewSessionOnNextStart) {
      const existingSession = await findMostRecentSessionForId(
        this.runtime.cwd,
        this.runtime.sessionDir,
        sessionId,
      );
      if (existingSession) {
        return SessionManager.open(existingSession.path, this.runtime.sessionDir, this.runtime.cwd);
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
    onEvent: ((event: PiStreamEvent) => void) | undefined,
    toolUpdateLastSent: Map<string, number>,
    toolArgs: Map<string, string>,
  ): void {
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent;
      if (delta.type === 'text_delta') {
        chunks.push(delta.delta);
        onEvent?.({ kind: 'text_delta', text: delta.delta });
      }
      if (delta.type === 'thinking_delta') {
        onEvent?.({ kind: 'thinking_delta', text: delta.delta });
      }
      if (delta.type === 'error') {
        setError(delta.error.errorMessage || 'Pi agent failed while generating a response');
      }
    }

    if (event.type === 'tool_execution_start') {
      const args = redactArgs(event.args);
      toolArgs.set(event.toolCallId, args);
      onEvent?.({
        kind: 'tool_start',
        toolCallId: event.toolCallId,
        name: event.toolName,
        label: formatToolStartLabel(event, session, this.runtime.cwd),
        args,
      });
    }

    if (event.type === 'tool_execution_update') {
      const now = Date.now();
      const last = toolUpdateLastSent.get(event.toolCallId) ?? 0;
      if (now - last >= WEB_TOOL_UPDATE_THROTTLE_MS) {
        toolUpdateLastSent.set(event.toolCallId, now);
        onEvent?.({
          kind: 'tool_update',
          toolCallId: event.toolCallId,
          partial: redactAndCap(extractToolResultText(event.partialResult)),
        });
      }
    }

    if (event.type === 'tool_execution_end') {
      const output = extractToolResultText(event.result);
      if (output) toolOutputs.push(output);
      onEvent?.({
        kind: 'tool_end',
        toolCallId: event.toolCallId,
        name: event.toolName,
        label: formatToolEndLabel(event.toolName),
        args: toolArgs.get(event.toolCallId) ?? '',
        result: redactAndCap(output),
        isError: event.isError,
      });
    }

    if (event.type === 'agent_end') {
      const failed = event.messages.find(
        (message) => message.role === 'assistant' && message.errorMessage,
      );
      if (failed?.role === 'assistant' && failed.errorMessage) {
        setError(failed.errorMessage);
      }
    }
  }
}

/** Truncates to a byte cap and masks obvious secret patterns. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
  /\b[A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key)["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{6,}/gi,
];

export function redactAndCap(value: string, cap = TOOL_DATA_CAP_BYTES): string {
  let masked = value;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, '***redacted***');
  }
  const buffer = Buffer.from(masked, 'utf8');
  if (buffer.byteLength <= cap) return masked;
  return `${buffer.subarray(0, cap).toString('utf8')}…(truncated)`;
}

function redactArgs(args: unknown): string {
  let serialized: string;
  if (typeof args === 'string') serialized = args;
  else {
    try {
      serialized = JSON.stringify(args);
    } catch {
      serialized = String(args);
    }
  }
  return redactAndCap(serialized);
}

function formatToolEndLabel(toolName: string): string {
  return `🛠 ${toolName}`;
}

function buildSessionId(prefix: string, chatId: string): string {
  const sanitized = `${prefix}-${chatId}`
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '');

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
    if (attachment.type === 'image') {
      images.push({
        type: 'image',
        data: fs.readFileSync(attachment.path).toString('base64'),
        mimeType: attachment.mimeType || 'image/jpeg',
      });
    } else {
      files.push(
        attachment.filename ? `${attachment.filename}: ${attachment.path}` : attachment.path,
      );
    }
  }

  const filePrefix =
    files.length > 0
      ? `[Attached files saved locally]\n${files.map((f) => `- ${f}`).join('\n')}\n\n`
      : '';

  return {
    message: `${filePrefix}${text}`,
    ...(images.length > 0 ? { images } : {}),
  };
}

function extractToolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object' || !('content' in result)) return '';

  const content = result.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'text' in part) {
        return typeof part.text === 'string' ? part.text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
