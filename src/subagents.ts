import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import tavilySearchExtension from '../extensions/tavily-web-search.ts';
import webFetchExtension from '../extensions/web-fetch/index.ts';
import {
  SUBAGENT_COMPLETED_TTL_MS,
  SUBAGENT_DEFAULT_MAX_RUNTIME_MS,
  SUBAGENT_DEFAULT_YIELD_MS,
  SUBAGENT_MAX_RESULT_CHARS,
  SUBAGENT_MAX_RUNNING,
  SUBAGENT_MAX_RUNTIME_CAP_MS,
  SUBAGENT_MAX_YIELD_MS,
  SUBAGENT_MODEL,
  SUBAGENT_SKILLS,
} from './config.ts';
import { protectedEnvToolAccessExtension } from './env-guard.ts';
import type { PiRuntime } from './pi-session.ts';
import { textResult } from './tool-result.ts';
import { errorMessage, formatModelRef, parseModelRef } from './util.ts';

/**
 * Sub-agents for the main Pi agent: spawn isolated in-memory Pi sessions to
 * offload self-contained tasks, then poll, list, or cancel them. A backgrounded
 * sub-agent reports its result back to the parent chat agent through an
 * internal subagent-report prompt when it finishes.
 *
 * Isolation rules (v1):
 * - Each sub-agent runs in SessionManager.inMemory(): no chat history, no
 *   long-term memory, no session persistence. The parent passes everything the
 *   sub-agent needs via task/context.
 * - Sub-agent sessions load only the protected-env guard plus web_search and
 *   web_fetch extensions, and only explicitly whitelisted skills, so they have
 *   no Telegram-facing tools and no subagent_* tools (no recursion).
 *
 * The registry lives at module level in src/ (imported once by Node), so it is
 * shared across all chats for the lifetime of the bot process. Sub-agents do
 * not survive bot restarts; main.ts cancels them all on shutdown.
 */

const CANCEL_WAIT_MS = 5_000;
const REPORT_TASK_PREVIEW_CHARS = 1_500;
const LIST_TASK_PREVIEW_CHARS = 120;

type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

interface Subagent {
  id: string;
  chatId: string;
  label: string;
  task: string;
  context: string | null;
  modelName: string;
  status: SubagentStatus;
  statusDetail: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Total streamed assistant characters, including trimmed ones. */
  outputChars: number;
  /** Bounded tail of the streamed assistant text. */
  outputTail: string;
  session: AgentSession | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  /** True once start returned a sub-agent ID; gates the completion report. */
  backgrounded: boolean;
  done: Promise<void>;
}

export interface SubagentReport {
  subagentId: string;
  chatId: string;
  label: string;
  task: string;
  outcome: string;
  result: string;
}

type SubagentReportHandler = (report: SubagentReport) => Promise<void>;

const subagents = new Map<string, Subagent>();
let reportHandler: SubagentReportHandler | null = null;

/** Wires completion reports into the bot's incoming-prompt pipeline. Called from main.ts. */
export function setSubagentReportHandler(handler: SubagentReportHandler): void {
  reportHandler = handler;
}

const SUBAGENT_SYSTEM_PROMPT = [
  'You are a background sub-agent of a Telegram assistant. You run non-interactively: no user is watching and nobody can answer questions.',
  'Complete the assigned task using your tools, then end with a final message that fully reports the outcome. That final message is the only thing returned to the parent agent.',
  'Work only from the task and context you were given; you have no access to the chat history, the Telegram user, or the assistant memory.',
  "Do not modify the bot's persistent state under files/ unless the task explicitly asks for it.",
  `Keep the final report focused and under ${SUBAGENT_MAX_RESULT_CHARS} characters.`,
].join('\n');

const StartParams = Type.Object({
  task: Type.String({
    description:
      'Self-contained task for the sub-agent. It starts with no chat history or memory, so include everything needed to complete the task.',
    minLength: 1,
  }),
  context: Type.Optional(
    Type.String({
      description:
        'Extra context the sub-agent needs: file paths, prior findings, constraints, expected output format.',
    }),
  ),
  label: Type.Optional(
    Type.String({ description: 'Short label shown in listings and the completion report.' }),
  ),
  yield_time_ms: Type.Optional(
    Type.Number({
      description: `How long to wait for the sub-agent before backgrounding it (default ${SUBAGENT_DEFAULT_YIELD_MS}ms, max ${SUBAGENT_MAX_YIELD_MS}ms).`,
    }),
  ),
  max_runtime_ms: Type.Optional(
    Type.Number({
      description: `Abort the sub-agent after this long (default ${SUBAGENT_DEFAULT_MAX_RUNTIME_MS}ms, max ${SUBAGENT_MAX_RUNTIME_CAP_MS}ms).`,
    }),
  ),
});

const ReadParams = Type.Object({
  subagent_id: Type.String({ description: 'Sub-agent ID returned by subagent_start.' }),
});

const CancelParams = Type.Object({
  subagent_id: Type.String({ description: 'Sub-agent ID returned by subagent_start.' }),
});

const ListParams = Type.Object({
  all_chats: Type.Optional(
    Type.Boolean({
      description: 'List sub-agents started from all Telegram chats, not just this one.',
    }),
  ),
});

export function subagentToolsExtension(
  chatId: string,
  runtime: PiRuntime,
): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'subagent_start',
      label: 'Start Sub-agent',
      description:
        'Spawn an isolated background sub-agent (a fresh in-memory Pi session) to work on a self-contained task. Waits briefly; if the sub-agent finishes in time its result is returned inline, otherwise it keeps running and a sub-agent ID is returned for polling with subagent_read. When a backgrounded sub-agent finishes you receive an internal [subagent-report] message with its result.',
      promptSnippet:
        'Offload long, self-contained research or coding tasks to background sub-agents with subagent_start.',
      promptGuidelines: [
        'Use subagent_start for long, self-contained tasks you can hand off (research, multi-file code work, big refactors); do quick work directly in your own turn.',
        'Sub-agents start with a clean session: no chat history and no memory. Put everything they need into task and context, including expected output format.',
        'Sub-agents cannot message the Telegram user, spawn further sub-agents, or ask questions; their final message is reported back to you.',
        'After backgrounding a sub-agent, keep its ID and poll with subagent_read if you need progress; a [subagent-report] message arrives automatically when it finishes.',
        'Cancel sub-agents that are no longer needed with subagent_cancel.',
      ],
      parameters: StartParams,

      async execute(_toolCallId, params: Static<typeof StartParams>) {
        pruneSubagents();

        const runningCount = [...subagents.values()].filter((s) => s.status === 'running').length;
        if (runningCount >= SUBAGENT_MAX_RUNNING) {
          return textResult(
            `Too many sub-agents running (${runningCount}/${SUBAGENT_MAX_RUNNING}). Wait for one to finish or cancel one with subagent_cancel first.`,
          );
        }

        const maxRuntimeMs = clamp(
          params.max_runtime_ms ?? SUBAGENT_DEFAULT_MAX_RUNTIME_MS,
          1_000,
          SUBAGENT_MAX_RUNTIME_CAP_MS,
        );
        const yieldTimeMs = clamp(
          params.yield_time_ms ?? SUBAGENT_DEFAULT_YIELD_MS,
          0,
          SUBAGENT_MAX_YIELD_MS,
        );

        const subagent = launchSubagent(chatId, runtime, params, maxRuntimeMs);
        await Promise.race([subagent.done, sleep(yieldTimeMs)]);

        if (subagent.status !== 'running') {
          return textResult(
            [
              `Sub-agent ${subagent.id} (${subagent.label}) ${describeOutcome(subagent)}.`,
              'Result:',
              formatResult(subagent),
            ].join('\n'),
          );
        }

        subagent.backgrounded = true;
        return textResult(
          [
            `Started sub-agent ${subagent.id} (${subagent.label})`,
            `Model: ${subagent.modelName}`,
            `Status: running (max runtime ${formatDuration(maxRuntimeMs)})`,
            `Poll with subagent_read using subagent_id "${subagent.id}". When it finishes, an internal [subagent-report] message with the result is delivered to this chat agent.`,
          ].join('\n'),
        );
      },
    });

    pi.registerTool({
      name: 'subagent_read',
      label: 'Read Sub-agent',
      description:
        'Read the status and streamed output of a sub-agent started with subagent_start.',
      parameters: ReadParams,

      async execute(_toolCallId, params: Static<typeof ReadParams>) {
        pruneSubagents();
        const subagent = subagents.get(params.subagent_id.trim());
        if (!subagent) return textResult(unknownSubagentMessage(params.subagent_id));

        return textResult(
          [
            `Sub-agent ${subagent.id} (${subagent.label})`,
            `Task: ${preview(subagent.task, LIST_TASK_PREVIEW_CHARS)}`,
            `Model: ${subagent.modelName}`,
            describeStatusLine(subagent),
            subagent.status === 'running' ? 'Output so far:' : 'Result:',
            formatResult(subagent),
          ].join('\n'),
        );
      },
    });

    pi.registerTool({
      name: 'subagent_cancel',
      label: 'Cancel Sub-agent',
      description:
        'Cancel a running sub-agent. Cancelled sub-agents do not send a completion report.',
      parameters: CancelParams,

      async execute(_toolCallId, params: Static<typeof CancelParams>) {
        pruneSubagents();
        const subagent = subagents.get(params.subagent_id.trim());
        if (!subagent) return textResult(unknownSubagentMessage(params.subagent_id));

        if (subagent.status !== 'running') {
          return textResult(
            `Sub-agent ${subagent.id} is not running (${describeStatus(subagent)}). Nothing to cancel.`,
          );
        }

        await cancelSubagents([subagent]);
        return textResult(
          subagent.status === 'running'
            ? `Sub-agent ${subagent.id} was signalled to cancel but has not stopped yet; check it again with subagent_read.`
            : `Cancelled sub-agent ${subagent.id}.`,
        );
      },
    });

    pi.registerTool({
      name: 'subagent_list',
      label: 'List Sub-agents',
      description:
        'List sub-agents for this chat (or all chats with all_chats=true), including status, runtime, and output size.',
      parameters: ListParams,

      async execute(_toolCallId, params: Static<typeof ListParams>) {
        pruneSubagents();
        const visible = [...subagents.values()].filter(
          (subagent) => params.all_chats || subagent.chatId === chatId,
        );
        if (visible.length === 0) {
          return textResult(
            params.all_chats
              ? 'No sub-agents.'
              : 'No sub-agents for this chat. Use all_chats=true to list every chat.',
          );
        }

        return textResult(visible.map((subagent) => formatListEntry(subagent)).join('\n\n'));
      },
    });
  };
}

/** Cancels this chat's running sub-agents. Used by /abort. */
export async function cancelChatSubagents(chatId: string): Promise<number> {
  return cancelSubagents(
    [...subagents.values()].filter((subagent) => subagent.chatId === chatId),
  );
}

/** Cancels every sub-agent regardless of chat. Called from main.ts on shutdown. */
export async function cancelAllSubagents(): Promise<void> {
  await cancelSubagents([...subagents.values()]);
}

/** Number of running sub-agents, optionally scoped to one chat. Used by /status. */
export function runningSubagentCount(chatId?: string): number {
  return [...subagents.values()].filter(
    (subagent) => subagent.status === 'running' && (!chatId || subagent.chatId === chatId),
  ).length;
}

export function formatSubagentReportPrompt(report: SubagentReport): string {
  return [
    `[subagent-report] Sub-agent ${report.subagentId} (${report.label}) ${report.outcome}.`,
    '',
    'Task:',
    preview(report.task, REPORT_TASK_PREVIEW_CHARS),
    '',
    'Result:',
    report.result || '(no output)',
    '',
    'This is an internal report from a background sub-agent you started earlier, not a message from the user.',
    'Review the result and send the user a concise update with the outcome. Handle any follow-up work yourself.',
  ].join('\n');
}

function launchSubagent(
  chatId: string,
  runtime: PiRuntime,
  params: Static<typeof StartParams>,
  maxRuntimeMs: number,
): Subagent {
  const { model, modelName } = resolveSubagentModel(runtime);
  const subagent: Subagent = {
    id: allocateSubagentId(),
    chatId,
    label: params.label?.trim() || preview(params.task, 40),
    task: params.task,
    context: params.context?.trim() || null,
    modelName,
    status: 'running',
    statusDetail: null,
    startedAt: Date.now(),
    endedAt: null,
    outputChars: 0,
    outputTail: '',
    session: null,
    timeoutTimer: null,
    backgrounded: false,
    done: Promise.resolve(),
  };

  subagents.set(subagent.id, subagent);
  subagent.done = runSubagent(subagent, runtime, model, maxRuntimeMs);
  return subagent;
}

async function runSubagent(
  subagent: Subagent,
  runtime: PiRuntime,
  model: Model<Api>,
  maxRuntimeMs: number,
): Promise<void> {
  let streamError = '';
  try {
    const session = await createSubagentSession(runtime, model);
    if (subagent.status !== 'running') {
      session.dispose();
      return;
    }
    subagent.session = session;

    subagent.timeoutTimer = setTimeout(() => {
      if (subagent.status !== 'running') return;
      subagent.status = 'timed_out';
      subagent.statusDetail = `aborted after exceeding the ${formatDuration(maxRuntimeMs)} max runtime`;
      void session.abort();
    }, maxRuntimeMs);

    const unsubscribe = session.subscribe((event) => {
      collectSubagentEvent(subagent, event, (message) => {
        streamError = message;
      });
    });
    try {
      await session.prompt(buildSubagentPrompt(subagent));
    } finally {
      unsubscribe();
    }

    if (subagent.status === 'running') {
      if (streamError) {
        subagent.status = 'failed';
        subagent.statusDetail = streamError;
      } else {
        subagent.status = 'completed';
      }
    }
  } catch (error) {
    if (subagent.status === 'running') {
      subagent.status = 'failed';
      subagent.statusDetail = errorMessage(error);
    }
  } finally {
    if (subagent.timeoutTimer) {
      clearTimeout(subagent.timeoutTimer);
      subagent.timeoutTimer = null;
    }
    subagent.endedAt = Date.now();
    subagent.session?.dispose();
    subagent.session = null;
    void reportSubagentEnd(subagent);
  }
}

async function createSubagentSession(
  runtime: PiRuntime,
  model: Model<Api>,
): Promise<AgentSession> {
  // Only explicitly approved extensions and skills are loaded. Sub-agents get
  // coding, web research, and whitelisted skill guidance, but cannot reach
  // Telegram, bot lifecycle tools, or subagent_* (no recursion), and cannot
  // inspect protected .env files.
  const resourceLoader = new DefaultResourceLoader({
    cwd: runtime.cwd,
    agentDir: getAgentDir(),
    settingsManager: runtime.settingsManager,
    noExtensions: true,
    noSkills: true,
    additionalSkillPaths: filterSubagentSkillPaths(runtime.getSkillPaths()),
    extensionFactories: [protectedEnvToolAccessExtension, tavilySearchExtension, webFetchExtension],
    systemPromptOverride: () => SUBAGENT_SYSTEM_PROMPT,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: runtime.cwd,
    model,
    authStorage: runtime.authStorage,
    modelRegistry: runtime.modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(runtime.cwd),
    settingsManager: runtime.settingsManager,
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
  });
  return session;
}

function filterSubagentSkillPaths(skillPaths: string[]): string[] {
  const allowed = new Set(SUBAGENT_SKILLS);
  if (allowed.size === 0) return [];

  return skillPaths.filter((skillPath) => {
    const basename = path.basename(skillPath);
    if (allowed.has(basename)) return true;

    const nameWithoutExt = basename.replace(/\.[^.]+$/, '');
    if (allowed.has(nameWithoutExt)) return true;

    return allowed.has(path.basename(path.dirname(skillPath)));
  });
}

function resolveSubagentModel(runtime: PiRuntime): { model: Model<Api>; modelName: string } {
  try {
    const ref = parseModelRef(SUBAGENT_MODEL);
    const model = runtime.modelRegistry.find(ref.provider, ref.model);
    if (model && runtime.modelRegistry.hasConfiguredAuth(model)) {
      return { model, modelName: formatModelRef(ref) };
    }
  } catch {
    // Fall back to the parent runtime's model below.
  }
  return { model: runtime.model, modelName: runtime.modelName };
}

function buildSubagentPrompt(subagent: Subagent): string {
  return [
    ...(subagent.context
      ? ['Context from the parent agent:', '<context>', subagent.context, '</context>', '']
      : []),
    'Task:',
    subagent.task,
  ].join('\n');
}

function collectSubagentEvent(
  subagent: Subagent,
  event: AgentSessionEvent,
  setError: (message: string) => void,
): void {
  if (event.type === 'message_update') {
    const delta = event.assistantMessageEvent;
    if (delta.type === 'text_delta') {
      appendOutput(subagent, delta.delta);
    }
    if (delta.type === 'error') {
      setError(delta.error.errorMessage || 'Sub-agent failed while generating a response');
    }
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

function appendOutput(subagent: Subagent, text: string): void {
  subagent.outputChars += text.length;
  subagent.outputTail += text;
  if (subagent.outputTail.length > SUBAGENT_MAX_RESULT_CHARS * 2) {
    subagent.outputTail = subagent.outputTail.slice(-SUBAGENT_MAX_RESULT_CHARS);
  }
}

async function cancelSubagents(targets: Subagent[]): Promise<number> {
  const running = targets.filter((subagent) => subagent.status === 'running');
  for (const subagent of running) {
    subagent.status = 'cancelled';
    void subagent.session?.abort();
  }
  if (running.length > 0) {
    await Promise.race([
      Promise.allSettled(running.map((subagent) => subagent.done)),
      sleep(CANCEL_WAIT_MS),
    ]);
  }
  return running.length;
}

async function reportSubagentEnd(subagent: Subagent): Promise<void> {
  if (!subagent.backgrounded || subagent.status === 'cancelled') return;

  if (!reportHandler) {
    console.error(`[${subagent.chatId}] no sub-agent report handler set; dropping report`);
    return;
  }

  try {
    await reportHandler({
      subagentId: subagent.id,
      chatId: subagent.chatId,
      label: subagent.label,
      task: subagent.task,
      outcome: describeOutcome(subagent),
      result: formatResult(subagent),
    });
  } catch (error) {
    console.error(
      `[${subagent.chatId}] failed to deliver sub-agent report:`,
      errorMessage(error),
    );
  }
}

function pruneSubagents(): void {
  const now = Date.now();
  for (const subagent of subagents.values()) {
    if (
      subagent.status !== 'running' &&
      subagent.endedAt !== null &&
      now - subagent.endedAt > SUBAGENT_COMPLETED_TTL_MS
    ) {
      subagents.delete(subagent.id);
    }
  }
}

function allocateSubagentId(): string {
  for (;;) {
    const id = `sub_${randomBytes(3).toString('hex')}`;
    if (!subagents.has(id)) return id;
  }
}

function unknownSubagentMessage(subagentId: string): string {
  return `Unknown sub-agent "${subagentId}". It may have been pruned (finished sub-agents are kept for ${formatDuration(SUBAGENT_COMPLETED_TTL_MS)}) or the bot may have restarted. Use subagent_list to see current sub-agents.`;
}

function describeOutcome(subagent: Subagent): string {
  const runtime = formatDuration(runtimeMs(subagent));
  switch (subagent.status) {
    case 'running':
      return `is still running after ${runtime}`;
    case 'completed':
      return `completed in ${runtime}`;
    case 'failed':
      return `failed after ${runtime} (${subagent.statusDetail ?? 'unknown error'})`;
    case 'cancelled':
      return `was cancelled after ${runtime}`;
    case 'timed_out':
      return `timed out (${subagent.statusDetail ?? `after ${runtime}`})`;
  }
}

function describeStatusLine(subagent: Subagent): string {
  return `Status: ${describeStatus(subagent)}, ${subagent.status === 'running' ? 'running for' : 'ran for'} ${formatDuration(runtimeMs(subagent))}`;
}

function describeStatus(subagent: Subagent): string {
  switch (subagent.status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return `failed (${subagent.statusDetail ?? 'unknown error'})`;
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return `timed out (${subagent.statusDetail ?? 'max runtime exceeded'})`;
  }
}

function formatListEntry(subagent: Subagent): string {
  return [
    `${subagent.id} — ${describeStatus(subagent)}`,
    `  Label: ${subagent.label}`,
    `  Task: ${preview(subagent.task, LIST_TASK_PREVIEW_CHARS)}`,
    `  Chat: ${subagent.chatId}`,
    `  Model: ${subagent.modelName}`,
    `  Runtime: ${formatDuration(runtimeMs(subagent))}`,
    `  Output: ${subagent.outputChars} chars`,
  ].join('\n');
}

function formatResult(subagent: Subagent): string {
  const full = subagent.outputTail.trim() || '(no output)';
  if (full.length <= SUBAGENT_MAX_RESULT_CHARS && subagent.outputChars <= subagent.outputTail.length) {
    return full;
  }

  const text = full.slice(-SUBAGENT_MAX_RESULT_CHARS);
  return `${text}\n\n[Truncated: showing the last ${text.length} of ${subagent.outputChars} streamed characters]`;
}

function preview(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

function runtimeMs(subagent: Subagent): number {
  return (subagent.endedAt ?? Date.now()) - subagent.startedAt;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
