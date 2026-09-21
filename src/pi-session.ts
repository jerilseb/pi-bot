import * as fs from 'node:fs';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type AgentSessionEvent,
  type SessionStats,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  ALLOWED_CHAT_ID,
  CRON_JOBS_ENABLED,
  FILES_DIR,
  OPENAI_CODEX_API_KEY,
  OPENROUTER_API_KEY,
  SEND_LOCAL_DOCUMENTS,
  SEND_LOCAL_IMAGES,
  SESSIONS_DIR,
  TRANSPORT_RECOVERY_DELAY_MS,
  TRANSPORT_RECOVERY_MAX_CONTINUATIONS,
} from './config.ts';
import { backgroundBashExtension } from './background-bash.ts';
import {
  appendSessionEvent,
  lastSessionEventKind,
  type SessionEventKind,
} from './session-notes.ts';
import { formatToolStartNotification } from './tool-notifications.ts';
import type { Attachment, IncomingPrompt, PiPromptResult, SessionKind } from './types.ts';
import { PromptSteering, type SteeringDisposition } from './prompt-steering.ts';
import {
  isTransientTransportError,
  TRANSPORT_RECOVERY_PROMPT,
  waitForTransportRecovery,
} from './transport-recovery.ts';
import {
  errorMessage as getErrorMessage,
  formatModelRef,
  parseModelRef,
  type ModelRef,
} from './util.ts';
import { telegramDocumentExtension, telegramImageExtension } from './uploads.ts';
import { telegramRestartToolExtension } from './restart-tool.ts';
import { scheduledTasksExtension } from './scheduled-tasks.ts';
import { telegramNewSessionToolExtension } from './session-switch-tool.ts';
import { telegramMenuExtension } from './telegram-menu.ts';
import { telegramVoiceNoteExtension } from './voice.ts';

/** Stands in for the model name on a session whose prompts each carry their own. */
export const NO_MODEL_NAME = 'per-prompt';

export interface PiRunPromptOptions {
  onToolCall?: (notification: string) => void;
  onSteeringSettled?: (prompt: IncomingPrompt, disposition: SteeringDisposition) => void;
  /** Enables one fresh continuation after the SDK exhausts its transient retries. */
  recoverTransportErrors?: boolean;
  /** Called once when either SDK retry or fallback continuation begins. */
  onAutoRecovery?: (error: string) => void | Promise<void>;
}

export interface PiRuntime {
  /**
   * The session's default model, as provider/model, or null when every prompt
   * must name its own. SdkPiSession resolves it against the catalogue on first
   * use rather than here, so a runtime can exist before a model is chosen — the
   * background runtime has no default, since heartbeat and cron each carry one.
   *
   * setModel writes back here so any replacement SdkPiSession uses the selected
   * chat model; useModel deliberately does not change the runtime default.
   */
  modelName: string | null;
  modelRuntime: ModelRuntime;
  settingsManager: ReturnType<typeof SettingsManager.create>;
  cwd: string;
  sessionDir: string;
  sessionPrefix: string;
  /**
   * Which of the bot's two sessions this runtime backs. Recorded on background
   * work started from it, so a completion report returns to the same session.
   */
  sessionKind: SessionKind;
  getExtensionPaths: () => string[];
  getSkillPaths: () => string[];
  systemPromptOverride: () => string;
  extensionFactories: Array<(pi: ExtensionAPI) => void>;
  requestRestart?: () => Promise<void>;
}

export async function createPiRuntime(options: {
  cwd: string;
  /** Default model as provider/model, or null when every prompt names its own. */
  model: string | null;
  sessionPrefix: string;
  sessionKind: SessionKind;
  getExtensionPaths: () => string[];
  getSkillPaths: () => string[];
  systemPromptOverride: () => string;
  extensionFactories?: Array<(pi: ExtensionAPI) => void>;
  requestRestart?: () => Promise<void>;
}): Promise<PiRuntime> {
  const modelRuntime = await ModelRuntime.create();
  if (OPENROUTER_API_KEY) {
    await modelRuntime.setRuntimeApiKey('openrouter', OPENROUTER_API_KEY);
  }
  if (OPENAI_CODEX_API_KEY) {
    await modelRuntime.setRuntimeApiKey('openai-codex', OPENAI_CODEX_API_KEY);
  }

  // Normalised, not resolved: whether the model exists and has auth is asserted
  // separately at startup (assertModelUsable), so that check stays explicit
  // rather than being a side effect of constructing a runtime.
  const defaultModelName = options.model ? formatModelRef(parseModelRef(options.model)) : null;
  // Keep Telegram model/reasoning preferences isolated from ~/.pi/agent/settings.json.
  // ModelRuntime still uses Pi's normal agent directory, so provider logins remain shared.
  const settingsManager = SettingsManager.create(options.cwd, FILES_DIR);

  return {
    modelName: defaultModelName,
    modelRuntime,
    settingsManager,
    cwd: options.cwd,
    sessionDir: SESSIONS_DIR,
    sessionPrefix: options.sessionPrefix,
    sessionKind: options.sessionKind,
    getExtensionPaths: options.getExtensionPaths,
    getSkillPaths: options.getSkillPaths,
    systemPromptOverride: options.systemPromptOverride,
    extensionFactories: options.extensionFactories ?? [],
    ...(options.requestRestart ? { requestRestart: options.requestRestart } : {}),
  };
}

/** Throws unless the model exists in Pi's catalogue and its provider has auth. */
export function assertModelUsable(modelRuntime: ModelRuntime, modelName: string): void {
  const modelRef = parseModelRef(modelName);
  resolveModel(modelRuntime, modelRef);
  ensureConfiguredAuth(modelRuntime, modelRef);
}

function resolveModel(modelRuntime: ModelRuntime, modelRef: ModelRef): Model<Api> {
  const model = modelRuntime.getModel(modelRef.provider, modelRef.model);
  if (!model) {
    throw new Error(`Unknown model: ${formatModelRef(modelRef)}`);
  }
  return model;
}

function ensureConfiguredAuth(modelRuntime: ModelRuntime, modelRef: ModelRef): void {
  if (!modelRuntime.hasConfiguredAuth(modelRef.provider)) {
    throw new Error(`No auth configured for ${formatModelRef(modelRef)}`);
  }
}

export class SdkPiSession {
  private session: AgentSession | null = null;
  private starting: Promise<AgentSession> | null = null;
  private runtime: PiRuntime;
  private selectedModelRef: ModelRef | null;
  private selectedModel: Model<Api> | null = null;
  private forceNewSessionOnNextStart = false;
  private pendingNewSessionRequest = false;
  private pendingNewSessionTask: string | null = null;
  private steering: PromptSteering | null = null;
  private transportRecoveryAbortController: AbortController | null = null;

  constructor(runtime: PiRuntime) {
    this.runtime = runtime;
    this.selectedModelRef = runtime.modelName ? parseModelRef(runtime.modelName) : null;
  }

  /** The selected model, or NO_MODEL_NAME until a prompt names one. */
  get modelName(): string {
    return this.selectedModelRef ? formatModelRef(this.selectedModelRef) : NO_MODEL_NAME;
  }

  async getThinkingState(): Promise<{
    level: ThinkingLevel;
    availableLevels: ThinkingLevel[];
  }> {
    const session = await this.start();
    return {
      level: session.thinkingLevel,
      availableLevels: session.getAvailableThinkingLevels(),
    };
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    const session = await this.start();
    if (session.isStreaming) {
      throw new Error('Cannot switch reasoning level while Pi is responding');
    }
    session.setThinkingLevel(level, { persist: true });
    await this.runtime.settingsManager.flush();
    return session.thinkingLevel;
  }

  async setModel(modelName: string): Promise<void> {
    const modelRef = parseModelRef(modelName);
    await this.runtime.modelRuntime.refresh();
    const model = resolveModel(this.runtime.modelRuntime, modelRef);
    ensureConfiguredAuth(this.runtime.modelRuntime, modelRef);

    const session = await this.start();
    if (session.isStreaming) {
      throw new Error('Cannot switch models while Pi is responding');
    }

    const previous = this.modelName;
    await session.setModel(model, { persist: true });
    await this.runtime.settingsManager.flush();

    const next = formatModelRef(modelRef);
    if (previous !== next) {
      // The SDK records a model_change entry, but that only sets the session's
      // model — it never reaches the context, so Pi would carry on unaware that
      // it is a different model than it was a turn ago.
      await this.noteEvent('model', `The chat model was changed from ${previous} to ${next}.`);
    }

    // Keep the runtime default in sync for any replacement SdkPiSession.
    this.runtime.modelName = next;
    this.selectedModelRef = modelRef;
    this.selectedModel = model;
  }

  /**
   * Switches the model for the prompts that follow without recording it as the
   * bot's default. Our setModel explicitly opts into SDK persistence to
   * files/settings.json — right for /models on the chat session, wrong for a
   * background run that borrows a model for one task. So this disposes the
   * live AgentSession and lets the next start() reopen the same transcript with
   * the new model. A no-op when the model is already active.
   */
  async useModel(modelName: string): Promise<void> {
    const modelRef = parseModelRef(modelName);
    if (formatModelRef(modelRef) === this.modelName) return;
    if (this.session?.isStreaming) {
      throw new Error('Cannot switch models while Pi is responding');
    }

    await this.runtime.modelRuntime.refresh();
    const model = resolveModel(this.runtime.modelRuntime, modelRef);
    ensureConfiguredAuth(this.runtime.modelRuntime, modelRef);

    this.cleanup();
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

    const steering = new PromptSteering(session, (prompt, disposition) => {
      options.onSteeringSettled?.(prompt, disposition);
    });
    this.steering = steering;
    let chunks: string[] = [];
    let promptError = '';
    let recoveryNotified = false;
    let recoveryAttempts = 0;
    let recoveryNotification = Promise.resolve();
    const notifyRecovery = (message: string): void => {
      if (recoveryNotified) return;
      recoveryNotified = true;
      try {
        recoveryNotification = Promise.resolve(options.onAutoRecovery?.(message)).catch((error) => {
          console.error('Automatic recovery callback failed:', getErrorMessage(error));
        });
      } catch (error) {
        console.error('Automatic recovery callback failed:', getErrorMessage(error));
      }
    };
    const unsubscribe = session.subscribe((event) => {
      steering.observe(event);
      if (event.type === 'auto_retry_start') {
        // Discard partial text and the superseded error before the SDK retries.
        chunks = [];
        promptError = '';
        notifyRecovery(event.errorMessage);
      }
      this.collectPromptEvent(
        event,
        session,
        chunks,
        (message) => {
          promptError = message;
        },
        options.onToolCall,
      );
    });

    try {
      let nextText = text;
      let nextAttachments = attachments;
      while (true) {
        promptError = '';
        const prompt = buildPiPrompt(nextText, nextAttachments);
        try {
          await session.prompt(prompt.message, {
            ...(prompt.images?.length ? { images: prompt.images } : {}),
          });
        } catch (error) {
          promptError ||= getErrorMessage(error);
        }

        if (!promptError) {
          await recoveryNotification;
          return { text: chunks.join('').trim() || '(no response)' };
        }

        const canRecover =
          options.recoverTransportErrors === true &&
          recoveryAttempts < TRANSPORT_RECOVERY_MAX_CONTINUATIONS &&
          isTransientTransportError(promptError) &&
          !this.pendingNewSessionRequest &&
          !steering.isCancelled &&
          steering.pendingCount === 0;
        if (!canRecover) {
          await recoveryNotification;
          throw new Error(promptError);
        }

        recoveryAttempts++;
        notifyRecovery(promptError);
        chunks = [];
        const recoveryController = new AbortController();
        this.transportRecoveryAbortController = recoveryController;
        try {
          await waitForTransportRecovery(TRANSPORT_RECOVERY_DELAY_MS, recoveryController.signal);
        } catch {
          throw new Error(promptError);
        } finally {
          if (this.transportRecoveryAbortController === recoveryController) {
            this.transportRecoveryAbortController = null;
          }
        }
        if (this.pendingNewSessionRequest || steering.isCancelled) throw new Error(promptError);

        steering.resume();
        nextText = TRANSPORT_RECOVERY_PROMPT;
        nextAttachments = [];
      }
    } finally {
      unsubscribe();
      try {
        await steering.finish();
      } finally {
        this.steering = null;
        this.transportRecoveryAbortController = null;
        this.applyPendingNewSession();
      }
    }
  }

  get pendingSteeringCount(): number {
    return this.steering?.pendingCount ?? 0;
  }

  /** False during startup, shutdown, or a pending reset: the caller queues instead. */
  async trySteer(prompt: IncomingPrompt): Promise<boolean> {
    if (!this.steering || this.pendingNewSessionRequest) return false;
    return this.steering.trySteer(prompt, buildPiPrompt(prompt.text, prompt.attachments));
  }

  async requestNewSession(task?: string): Promise<string> {
    this.pendingNewSessionRequest = true;
    this.pendingNewSessionTask = task?.trim() || null;
    return this.pendingNewSessionTask
      ? `Fresh session queued using ${this.modelName}. The provided task will run automatically in the new Pi conversation after the current response finishes.`
      : `Fresh session queued using ${this.modelName}. The next user message will start a new Pi conversation.`;
  }

  consumePendingNewSessionTask(): string | null {
    const task = this.pendingNewSessionTask;
    this.pendingNewSessionTask = null;
    return task;
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    try {
      return (await this.runtime.modelRuntime.getAuth(provider))?.auth.apiKey;
    } catch {
      return undefined;
    }
  }

  getSessionStats(): SessionStats | null {
    return this.session?.getSessionStats() ?? null;
  }

  abort(): void {
    this.transportRecoveryAbortController?.abort();
    this.steering?.cancel();
    this.session?.clearQueue();
    void this.session?.abort();
  }

  /**
   * Write a note about the bot into this chat's session file.
   *
   * Prefers the live session: a second SessionManager over the same file would
   * carry its own leaf pointer, and appending through it would branch the tree
   * away from where the running agent is writing. With no live session there is
   * nothing to desynchronise, so the file is opened just long enough to append.
   * A chat that has never had a session has nothing to annotate.
   */
  async noteEvent(kind: SessionEventKind, text: string): Promise<void> {
    try {
      const manager = this.session?.sessionManager ?? (await this.openStoredSessionManager());
      if (!manager) return;
      appendSessionEvent(manager, kind, text);
    } catch (error) {
      // A missing note must never take down the command that recorded it.
      console.error('Failed to write session note:', error);
    }
  }

  /** The kind of the last note in the stored session, for unclean-exit detection. */
  async lastNoteKind(): Promise<SessionEventKind | null> {
    try {
      const manager = this.session?.sessionManager ?? (await this.openStoredSessionManager());
      return manager ? lastSessionEventKind(manager) : null;
    } catch (error) {
      console.error('Failed to read session notes:', error);
      return null;
    }
  }

  /** Opens this chat's most recent session file without starting an agent. */
  private async openStoredSessionManager(): Promise<SessionManager | null> {
    const existing = await findMostRecentSessionForId(
      this.runtime.cwd,
      this.runtime.sessionDir,
      buildTelegramSessionId(this.runtime.sessionPrefix),
    );
    if (!existing) return null;
    return SessionManager.open(existing.path, this.runtime.sessionDir, this.runtime.cwd);
  }

  reset(): void {
    this.cleanup();
    this.pendingNewSessionRequest = false;
    this.pendingNewSessionTask = null;
    this.forceNewSessionOnNextStart = true;
  }

  cleanup(): void {
    this.transportRecoveryAbortController?.abort();
    this.transportRecoveryAbortController = null;
    this.session?.dispose();
    this.session = null;
    this.starting = null;
  }

  /**
   * Resolves the selected ref against the catalogue, lazily, so a runtime with no
   * default model is legal right up until something tries to run on it without
   * naming one.
   */
  private resolveSelectedModel(): Model<Api> {
    if (!this.selectedModelRef) {
      throw new Error(
        'No model is configured for this Pi session; the prompt must name one. ' +
          'Check HEARTBEAT_MODEL in .env, or the chat model for scheduled tasks.',
      );
    }
    if (!this.selectedModel) {
      this.selectedModel = resolveModel(this.runtime.modelRuntime, this.selectedModelRef);
      ensureConfiguredAuth(this.runtime.modelRuntime, this.selectedModelRef);
    }
    return this.selectedModel;
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
          ? [telegramRestartToolExtension(this.runtime.requestRestart)]
          : []),
        telegramNewSessionToolExtension((task) => this.requestNewSession(task)),
        // Withheld when cron is off, so the agent cannot create jobs that would
        // never fire.
        ...(CRON_JOBS_ENABLED ? [scheduledTasksExtension] : []),
        telegramMenuExtension,
        telegramVoiceNoteExtension,
        backgroundBashExtension(this.runtime.sessionKind),
        ...(SEND_LOCAL_IMAGES ? [telegramImageExtension] : []),
        ...(SEND_LOCAL_DOCUMENTS ? [telegramDocumentExtension] : []),
      ],
      systemPromptOverride: this.runtime.systemPromptOverride,
    });
    await resourceLoader.reload();

    const sessionManager = await this.createSessionManager();
    const { session } = await createAgentSession({
      cwd: this.runtime.cwd,
      model: this.resolveSelectedModel(),
      modelRuntime: this.runtime.modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager: this.runtime.settingsManager,
    });

    this.forceNewSessionOnNextStart = false;
    return session;
  }

  private async createSessionManager(): Promise<SessionManager> {
    const sessionId = buildTelegramSessionId(this.runtime.sessionPrefix);

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
    setError: (message: string) => void,
    onToolCall: ((notification: string) => void) | undefined,
  ): void {
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent;
      if (delta.type === 'text_delta') {
        chunks.push(delta.delta);
      }
      if (delta.type === 'error') {
        setError(delta.error.errorMessage || 'Pi agent failed while generating a response');
      }
    }

    if (event.type === 'tool_execution_start') {
      onToolCall?.(formatToolStartNotification(event, session, this.runtime.cwd));
    }

    if (event.type === 'agent_end') {
      // agent_end is emitted for each low-level attempt. A retrying failure is
      // superseded, and a later successful attempt must clear its stale error.
      let lastAssistantError = '';
      for (let index = event.messages.length - 1; index >= 0; index--) {
        const message = event.messages[index];
        if (message.role !== 'assistant') continue;
        lastAssistantError = message.errorMessage ?? '';
        break;
      }
      setError(event.willRetry ? '' : lastAssistantError);
    }
  }
}

/** Keeps the historical `<prefix>-<chatId>` shape so existing sessions/ files still resume. */
function buildTelegramSessionId(prefix: string): string {
  const sanitized = `${prefix}-${ALLOWED_CHAT_ID}`
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
