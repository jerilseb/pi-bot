import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type AgentSessionEvent,
  type ContextUsage,
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
  SUBAGENTS_ENABLED,
  TRANSPORT_RECOVERY_DELAY_MS,
  TRANSPORT_RECOVERY_MAX_CONTINUATIONS,
} from './config.ts';
import { backgroundBashExtension } from './background-bash.ts';
import {
  appendSessionEvent,
  isConversationCleared,
  lastSessionEventKind,
  markConversationCleared,
  type SessionEventKind,
  sessionEventMessage,
} from './session-notes.ts';
import { formatToolStartNotification } from './tool-notifications.ts';
import type { Attachment, IncomingPrompt, PiPromptResult, SessionKind } from './types.ts';
import { PromptSteering, type SteeringDisposition } from './prompt-steering.ts';
import { notifySteeringMessage } from './steering-signal.ts';
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
import { subagentExtension, type WorkerRunRequest, type WorkerRunResult } from './subagent.ts';
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
  /**
   * Session-per-prompt runtimes only: the transcript to continue instead of
   * starting a fresh one, e.g. the run a job report belongs to.
   */
  resumeSessionFile?: string;
  /**
   * Session-per-prompt runtimes only: where a fresh transcript goes, the prefix
   * of its ID, and a name recorded on it. Defaults to the runtime's directory
   * and prefix.
   */
  transcript?: RunTranscript;
}

export interface RunTranscript {
  dir: string;
  prefix: string;
  name?: string;
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
   * True when every prompt runs in a transcript of its own (the background
   * session): nothing carries over from one run to the next, and the live
   * session is disposed when the prompt ends. False for the chat, which keeps
   * and resumes one conversation.
   */
  sessionPerPrompt: boolean;
  /**
   * Which of the bot's two sessions this runtime backs. Recorded on background
   * work started from it, so a completion report returns to the same session.
   */
  sessionKind: SessionKind;
  getExtensionPaths: () => string[];
  systemPromptOverride: () => string;
  extensionFactories: Array<(pi: ExtensionAPI) => void>;
  /**
   * Factories a sub-agent worker session gets instead of extensionFactories and
   * the Telegram tools: the guards that must hold for any agent this bot runs,
   * without the chat's memory blocks or user-facing tools.
   */
  workerExtensionFactories?: Array<(pi: ExtensionAPI) => void>;
  requestRestart?: () => Promise<void>;
}

export async function createPiRuntime(options: {
  cwd: string;
  /** Default model as provider/model, or null when every prompt names its own. */
  model: string | null;
  sessionPrefix: string;
  sessionKind: SessionKind;
  /** Where transcripts are written; defaults to SESSIONS_DIR. */
  sessionDir?: string;
  /** See PiRuntime.sessionPerPrompt; defaults to false. */
  sessionPerPrompt?: boolean;
  getExtensionPaths: () => string[];
  systemPromptOverride: () => string;
  extensionFactories?: Array<(pi: ExtensionAPI) => void>;
  workerExtensionFactories?: Array<(pi: ExtensionAPI) => void>;
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
    sessionDir: options.sessionDir ?? SESSIONS_DIR,
    sessionPrefix: options.sessionPrefix,
    sessionPerPrompt: options.sessionPerPrompt ?? false,
    sessionKind: options.sessionKind,
    getExtensionPaths: options.getExtensionPaths,
    systemPromptOverride: options.systemPromptOverride,
    extensionFactories: options.extensionFactories ?? [],
    workerExtensionFactories: options.workerExtensionFactories ?? [],
    ...(options.requestRestart ? { requestRestart: options.requestRestart } : {}),
  };
}

/**
 * Runs one sub-agent worker: a fresh AgentSession with its own transcript that
 * answers a single task and is disposed. Workers share the runtime's model
 * catalogue, settings, and extension paths, but get only the worker
 * extension factories and a caller-supplied system prompt — no Telegram tools,
 * no steering, no transport recovery.
 *
 * The transcript is persisted under request.sessionDir with the parent's file
 * in its header, and framed by two custom entries of request.customType: a
 * start entry carrying the caller's metadata, and an end entry with the outcome,
 * so a viewer can tell a finished worker from one the bot was stopped under.
 */
export async function runWorkerPrompt(
  runtime: PiRuntime,
  request: WorkerRunRequest,
): Promise<WorkerRunResult> {
  if (request.signal.aborted) throw new Error('aborted');
  const model = resolveUsableModel(runtime.modelRuntime, parseModelRef(request.model));

  const sessionManager = SessionManager.create(request.cwd, request.sessionDir, {
    id: request.sessionId,
    ...(request.parentSession ? { parentSession: request.parentSession } : {}),
  });
  return driveWorkerSession(request, sessionManager, async () => {
    const resourceLoader = await loadResources(runtime, {
      extensionFactories: runtime.workerExtensionFactories ?? [],
      systemPromptOverride: () => request.systemPrompt,
    });
    const { session } = await createAgentSession({
      cwd: request.cwd,
      model,
      modelRuntime: runtime.modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager: runtime.settingsManager,
    });
    return session;
  });
}

type WorkerOutcome = { status: 'succeeded' | 'failed' | 'aborted'; error?: string };

/**
 * The part of runWorkerPrompt once the worker's transcript exists: frames it,
 * creates the session, and sends the task. Exported so tests can drive it with
 * a fake session.
 *
 * The abort listener goes on before the session is created, and the signal is
 * checked again before the task is sent: a stop that lands while the session is
 * still loading must not let the worker run its whole task first.
 */
export async function driveWorkerSession(
  request: WorkerRunRequest,
  sessionManager: SessionManager,
  createSession: () => Promise<AgentSession>,
): Promise<WorkerRunResult> {
  const sessionFile = sessionManager.getSessionFile();
  sessionManager.appendCustomEntry(request.customType, { event: 'start', ...request.metadata });
  sessionManager.appendSessionInfo(request.sessionName);
  if (sessionFile) request.onSessionFile?.(sessionFile);

  let session: AgentSession | null = null;
  const onAbort = (): void => void session?.abort();
  request.signal.addEventListener('abort', onAbort, { once: true });
  let unsubscribe = (): void => {};
  let outcome: WorkerOutcome | null = null;
  try {
    const live = await createSession();
    session = live;
    const chunks: string[] = [];
    let promptError = '';
    unsubscribe = live.subscribe((event) => {
      abortOnRunStart(live, event, request.signal.aborted);
      if (event.type === 'auto_retry_start') {
        chunks.length = 0;
        promptError = '';
      }
      collectResponseEvent(event, chunks, (message) => {
        promptError = message;
      });
    });

    if (!request.signal.aborted) {
      try {
        await live.prompt(request.task);
      } catch (error) {
        promptError ||= getErrorMessage(error);
      }
    }
    if (request.signal.aborted) {
      outcome = { status: 'aborted' };
      throw new Error('aborted');
    }
    if (promptError) {
      outcome = { status: 'failed', error: promptError };
      throw new Error(promptError);
    }
    outcome = { status: 'succeeded' };
    return { text: chunks.join('').trim() || '(no response)', sessionFile };
  } catch (error) {
    outcome ??= request.signal.aborted
      ? { status: 'aborted' }
      : { status: 'failed', error: getErrorMessage(error) };
    throw error;
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    unsubscribe();
    try {
      sessionManager.appendCustomEntry(request.customType, {
        event: 'end',
        ...outcome,
        endedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Failed to close worker transcript:', getErrorMessage(error));
    }
    session?.dispose();
  }
}

/**
 * session.prompt() does async setup before the agent run exists (input hooks,
 * the auth check, compaction, before_agent_start), and session.abort() in that
 * window has no run to stop. Aborting again once the run starts closes the gap.
 */
function abortOnRunStart(session: AgentSession, event: AgentSessionEvent, aborted: boolean): void {
  if (event.type === 'agent_start' && aborted) void session.abort();
}

/** The SDK's wording for an aborted request, so a run stopped before its prompt reads the same. */
const PROMPT_ABORTED_MESSAGE = 'Request was aborted';

/**
 * The bot's resource loader: no skills and nothing from the user's Pi agent
 * directory, only the project extensions and the given factories. Shared by the
 * chat and background sessions and by sub-agent workers, which differ only in
 * which factories and system prompt they get.
 */
async function loadResources(
  runtime: PiRuntime,
  options: {
    extensionFactories: Array<(pi: ExtensionAPI) => void>;
    systemPromptOverride: () => string;
  },
): Promise<DefaultResourceLoader> {
  const resourceLoader = new DefaultResourceLoader({
    cwd: runtime.cwd,
    agentDir: getAgentDir(),
    settingsManager: runtime.settingsManager,
    noExtensions: true,
    noSkills: true,
    additionalExtensionPaths: runtime.getExtensionPaths(),
    extensionFactories: options.extensionFactories,
    systemPromptOverride: options.systemPromptOverride,
  });
  await resourceLoader.reload();
  return resourceLoader;
}

/**
 * Accumulates a response's text and records its error, for both the persistent
 * sessions and workers. agent_end is emitted for each low-level attempt: a
 * retrying failure is superseded, and a later successful attempt must clear its
 * stale error.
 */
function collectResponseEvent(
  event: AgentSessionEvent,
  chunks: string[],
  setError: (message: string) => void,
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

  if (event.type === 'agent_end') {
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

/** Throws unless the model exists in Pi's catalogue and its provider has auth. */
export function assertModelUsable(modelRuntime: ModelRuntime, modelName: string): void {
  resolveUsableModel(modelRuntime, parseModelRef(modelName));
}

/**
 * The one place a model ref becomes a Model: it must exist in the catalogue and
 * its provider must have auth, or nothing here may run on it. Every switch and
 * the lazy first resolution go through this, so they cannot disagree on what
 * "usable" means.
 */
function resolveUsableModel(modelRuntime: ModelRuntime, modelRef: ModelRef): Model<Api> {
  const model = modelRuntime.getModel(modelRef.provider, modelRef.model);
  if (!model) {
    throw new Error(`Unknown model: ${formatModelRef(modelRef)}`);
  }
  if (!modelRuntime.hasConfiguredAuth(modelRef.provider)) {
    throw new Error(`No auth configured for ${formatModelRef(modelRef)}`);
  }
  return model;
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
  /**
   * Bumped by every abort(). A run compares it with the value it began with, so
   * an abort that lands before there is anything to abort, while the session is
   * still starting, still stops the run.
   */
  private abortGeneration = 0;
  /** Session-per-prompt only: what the next start() opens or creates. */
  private nextRun: { resumeSessionFile?: string; transcript?: RunTranscript } = {};

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
    const model = await this.resolveFreshModel(modelRef);

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

    const model = await this.resolveFreshModel(modelRef);

    this.cleanup();
    this.selectedModelRef = modelRef;
    this.selectedModel = model;
  }

  async runPrompt(
    text: string,
    attachments: Attachment[],
    options: PiRunPromptOptions = {},
  ): Promise<PiPromptResult> {
    const generation = this.abortGeneration;
    const aborted = () => this.abortGeneration !== generation;
    // A /new that arrived after the previous run returned, while its reply was
    // still being delivered, was only queued; this message belongs to the new
    // conversation.
    this.applyPendingNewSession();
    if (this.runtime.sessionPerPrompt) {
      // Whatever a previous run left behind is not this run's conversation.
      this.cleanup();
      this.nextRun = {
        ...(options.resumeSessionFile ? { resumeSessionFile: options.resumeSessionFile } : {}),
        ...(options.transcript ? { transcript: options.transcript } : {}),
      };
    }
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
      abortOnRunStart(session, event, aborted());
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
        // Starting the session, or waiting to recover, may have outlasted an abort.
        if (aborted()) throw new Error(PROMPT_ABORTED_MESSAGE);
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
        // The run is over, and nothing resumes a session-per-prompt transcript
        // except through its file.
        if (this.runtime.sessionPerPrompt) this.cleanup();
      }
    }
  }

  get pendingSteeringCount(): number {
    return this.steering?.pendingCount ?? 0;
  }

  /**
   * False during startup, shutdown, or a pending reset: the caller queues instead.
   * An accepted message also ends any wait tool blocking this turn, so the
   * message is not held until the wait times out.
   */
  async trySteer(prompt: IncomingPrompt): Promise<boolean> {
    if (!this.steering || this.pendingNewSessionRequest) return false;
    const steered = await this.steering.trySteer(
      prompt,
      buildPiPrompt(prompt.text, prompt.attachments),
    );
    if (steered) notifySteeringMessage(this.runtime.sessionKind);
    return steered;
  }

  async requestNewSession(task?: string): Promise<string> {
    this.pendingNewSessionRequest = true;
    this.pendingNewSessionTask = task?.trim() || null;
    await this.markConversationCleared();
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

  /** How full the context window is, from the loaded transcript; undefined before it loads. */
  getContextUsage(): ContextUsage | undefined {
    return this.session?.getContextUsage();
  }

  /**
   * Stops the current run, including one whose session is still starting, which
   * then never sends its prompt. Returns true when a turn was under way: false
   * when idle, still starting, or delivering a reply that had already finished.
   */
  abort(): boolean {
    this.abortGeneration++;
    const turnUnderWay = this.steering !== null;
    this.transportRecoveryAbortController?.abort();
    this.steering?.cancel();
    this.session?.clearQueue();
    void this.session?.abort();
    return turnUnderWay;
  }

  /**
   * Tell Pi about something the bot did outside its turns.
   *
   * A live session takes the note through the SDK, which adds it to the running
   * agent's context as well as the file. Appending to the file alone would leave
   * the agent unaware of the note until the transcript is next loaded. During a
   * turn the SDK holds the note until the turn ends, so it cannot land between a
   * tool call and its result, which providers reject on replay.
   *
   * With no live session the file is all there is, so it is opened just long
   * enough to append. A chat that has never had a session, or whose last
   * conversation was cleared and whose next one has not started, has nothing to
   * annotate.
   */
  async noteEvent(kind: SessionEventKind, text: string): Promise<void> {
    try {
      const session = await this.liveSession();
      if (session) {
        await session.sendCustomMessage(sessionEventMessage(kind, text), { triggerTurn: false });
        return;
      }
      const manager = await this.openStoredSessionManager();
      if (manager) appendSessionEvent(manager, kind, text);
    } catch (error) {
      // A missing note must never take down the command that recorded it.
      console.error('Failed to write session note:', error);
    }
  }

  /**
   * Write a note for the next start, just before this session is disposed.
   *
   * Goes straight to the file: the live context is about to be discarded, and a
   * note the SDK was holding for the end of the turn would be discarded with it.
   * Appends through the live session's manager when there is one, since a second
   * SessionManager over the same file would carry its own leaf pointer and branch
   * the tree away from where the running agent is writing.
   */
  async noteEventBeforeExit(
    kind: SessionEventKind,
    text: string,
    sessionFile?: string,
  ): Promise<void> {
    try {
      const manager = sessionFile
        ? await this.openSessionFile(sessionFile)
        : ((await this.liveSession())?.sessionManager ?? (await this.openStoredSessionManager()));
      if (manager) appendSessionEvent(manager, kind, text);
    } catch (error) {
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

  /**
   * One specific transcript, through the live session's manager when that is
   * the one running — a second manager over the same file would branch the tree
   * away from where the agent is writing. Null when the file is not on disk.
   */
  private async openSessionFile(sessionFile: string): Promise<SessionManager | null> {
    const live = await this.liveSession();
    if (live?.sessionManager.getSessionFile() === sessionFile) return live.sessionManager;
    if (!fs.existsSync(sessionFile)) return null;
    return SessionManager.open(sessionFile, path.dirname(sessionFile), this.runtime.cwd);
  }

  /**
   * Opens the conversation this chat would resume, without starting an agent:
   * the most recent session file, unless /new or start_new_session marked it
   * cleared. Null when there is nothing to resume — always, for a
   * session-per-prompt runtime, which never resumes on its own.
   */
  private async openStoredSessionManager(): Promise<SessionManager | null> {
    if (this.runtime.sessionPerPrompt) return null;
    const existing = await findMostRecentSessionForId(
      this.runtime.cwd,
      this.runtime.sessionDir,
      buildTelegramSessionId(this.runtime.sessionPrefix),
    );
    if (!existing) return null;
    const manager = SessionManager.open(existing.path, this.runtime.sessionDir, this.runtime.cwd);
    return isConversationCleared(manager) ? null : manager;
  }

  /**
   * Marks the conversation being replaced, so a restart before its successor
   * reaches disk starts fresh instead of resuming it. Written when the swap is
   * requested, not when it is applied: until then the request is only in memory.
   */
  private async markConversationCleared(): Promise<void> {
    try {
      const manager = this.session?.sessionManager ?? (await this.openStoredSessionManager());
      if (manager) markConversationCleared(manager);
    } catch (error) {
      // /new must still work; only its survival across a restart is lost.
      console.error('Failed to mark conversation cleared:', error);
    }
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
      this.selectedModel = resolveUsableModel(this.runtime.modelRuntime, this.selectedModelRef);
    }
    return this.selectedModel;
  }

  /**
   * Resolves a ref for a switch. The catalogue is refreshed first so a login or
   * key added since startup is seen; startup validation and the lazy first
   * resolution skip that, since nothing can have changed yet.
   */
  private async resolveFreshModel(modelRef: ModelRef): Promise<Model<Api>> {
    await this.runtime.modelRuntime.refresh();
    return resolveUsableModel(this.runtime.modelRuntime, modelRef);
  }

  private applyPendingNewSession(): void {
    if (!this.pendingNewSessionRequest) return;

    this.pendingNewSessionRequest = false;
    this.cleanup();
    this.forceNewSessionOnNextStart = true;
  }

  /**
   * The session notes should go to, waiting out one that is still starting: the
   * file is opened on its own only when there is no session at all, or its
   * start failed. Never starts one.
   */
  private async liveSession(): Promise<AgentSession | null> {
    if (this.session) return this.session;
    return this.starting ? this.starting.catch(() => null) : null;
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
    const resourceLoader = await loadResources(this.runtime, {
      extensionFactories: [
        ...this.runtime.extensionFactories,
        ...(this.runtime.requestRestart
          ? [telegramRestartToolExtension(this.runtime.requestRestart)]
          : []),
        telegramNewSessionToolExtension((task) => this.requestNewSession(task)),
        // Withheld when cron is off, so the agent cannot create jobs that would
        // never fire.
        ...(CRON_JOBS_ENABLED ? [scheduledTasksExtension] : []),
        telegramMenuExtension(this.runtime.sessionKind),
        telegramVoiceNoteExtension(this.runtime.sessionKind),
        backgroundBashExtension(this.runtime.sessionKind),
        // Withheld when sub-agents are off, so the agent cannot claim to have
        // delegated work.
        ...(SUBAGENTS_ENABLED
          ? [
              subagentExtension({
                origin: this.runtime.sessionKind,
                runWorker: (request) => runWorkerPrompt(this.runtime, request),
              }),
            ]
          : []),
        ...(SEND_LOCAL_IMAGES ? [telegramImageExtension(this.runtime.sessionKind)] : []),
        ...(SEND_LOCAL_DOCUMENTS ? [telegramDocumentExtension(this.runtime.sessionKind)] : []),
      ],
      systemPromptOverride: this.runtime.systemPromptOverride,
    });

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
    if (this.runtime.sessionPerPrompt) return this.createRunSessionManager();
    if (!this.forceNewSessionOnNextStart) {
      const stored = await this.openStoredSessionManager();
      if (stored) return stored;
    }

    return SessionManager.create(this.runtime.cwd, this.runtime.sessionDir, {
      id: buildTelegramSessionId(this.runtime.sessionPrefix),
    });
  }

  /**
   * A session-per-prompt run's transcript: the one a job report names, when it
   * is still on disk, otherwise a fresh one with an ID of its own.
   */
  private createRunSessionManager(): SessionManager {
    const { resumeSessionFile, transcript } = this.nextRun;
    this.nextRun = {};
    if (resumeSessionFile) {
      if (fs.existsSync(resumeSessionFile)) {
        return SessionManager.open(
          resumeSessionFile,
          path.dirname(resumeSessionFile),
          this.runtime.cwd,
        );
      }
      console.error(`Transcript to resume is gone, starting fresh: ${resumeSessionFile}`);
    }
    const dir = transcript?.dir ?? this.runtime.sessionDir;
    const prefix = transcript?.prefix ?? this.runtime.sessionPrefix;
    const manager = SessionManager.create(this.runtime.cwd, dir, {
      id: `${buildTelegramSessionId(prefix)}-${randomBytes(4).toString('hex')}`,
    });
    if (transcript?.name) manager.appendSessionInfo(transcript.name);
    return manager;
  }

  private collectPromptEvent(
    event: AgentSessionEvent,
    session: AgentSession,
    chunks: string[],
    setError: (message: string) => void,
    onToolCall: ((notification: string) => void) | undefined,
  ): void {
    collectResponseEvent(event, chunks, setError);

    if (event.type === 'tool_execution_start') {
      onToolCall?.(formatToolStartNotification(event, this.runtime.cwd));
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
