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
import { buildAgentEnvelope } from './agent-envelope.ts';
import {
  SUBAGENT_CANCEL_WAIT_MS,
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
import { type Job, JobRegistry } from './job-registry.ts';
import type { PiRuntime } from './pi-session.ts';
import { textResult } from './tool-result.ts';
import {
  clamp,
  errorMessage,
  formatDuration,
  formatModelRef,
  parseModelRef,
  sleep,
} from './util.ts';

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
 * Lifecycle bookkeeping (IDs, pruning, cancellation, report delivery) lives in
 * src/job-registry.ts, shared with background bash sessions. Tuning knobs live
 * in src/config.ts under "Background work", next to the background-bash
 * equivalents; only the display widths below are local.
 */

const REPORT_TASK_PREVIEW_CHARS = 1_500;
const LIST_TASK_PREVIEW_CHARS = 120;

type SubagentTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out';

interface Subagent extends Job<SubagentTerminalStatus> {
  label: string;
  task: string;
  context: string | null;
  modelName: string;
  /** Total streamed assistant characters, including trimmed ones. */
  outputChars: number;
  /** Bounded tail of the streamed assistant text. */
  outputTail: string;
  session: AgentSession | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

export interface SubagentReport {
  subagentId: string;
  label: string;
  task: string;
  outcome: string;
  result: string;
}

const registry = new JobRegistry<SubagentTerminalStatus, Subagent, SubagentReport>({
  idPrefix: 'sub',
  jobNoun: 'sub-agent',
  jobNounPlural: 'sub-agents',
  listToolName: 'subagent_list',
  completedTtlMs: SUBAGENT_COMPLETED_TTL_MS,
  cancelWaitMs: SUBAGENT_CANCEL_WAIT_MS,
  cancelledStatus: 'cancelled',
  signalCancel: (subagent) => void subagent.session?.abort(),
  describeStatus,
  buildReport: (subagent) => ({
    subagentId: subagent.id,
    label: subagent.label,
    task: subagent.task,
    outcome: describeOutcome(subagent),
    result: formatResult(subagent),
  }),
});

/** Wires completion reports into the bot's incoming-prompt pipeline. Called from main.ts. */
export function setSubagentReportHandler(handler: (report: SubagentReport) => Promise<void>): void {
  registry.setReportHandler(handler);
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

const ListParams = Type.Object({});

export function subagentToolsExtension(runtime: PiRuntime): (pi: ExtensionAPI) => void {
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
        const runningCount = registry.runningCount();
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

        const subagent = launchSubagent(runtime, params, maxRuntimeMs);
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
            `Poll with subagent_read using subagent_id "${subagent.id}". When it finishes, an internal [subagent-report] message with the result is delivered to the chat agent.`,
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
        const subagent = registry.get(params.subagent_id);
        if (!subagent) return textResult(registry.unknownJobMessage(params.subagent_id));

        return textResult(
          [
            `Sub-agent ${subagent.id} (${subagent.label})`,
            `Task: ${preview(subagent.task, LIST_TASK_PREVIEW_CHARS)}`,
            `Model: ${subagent.modelName}`,
            registry.statusLine(subagent),
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
        const subagent = registry.get(params.subagent_id);
        if (!subagent) return textResult(registry.unknownJobMessage(params.subagent_id));

        if (subagent.status !== 'running') {
          return textResult(
            `Sub-agent ${subagent.id} is not running (${describeStatus(subagent)}). Nothing to cancel.`,
          );
        }

        await registry.cancel([subagent]);
        return textResult(`Cancelled sub-agent ${subagent.id}.`);
      },
    });

    pi.registerTool({
      name: 'subagent_list',
      label: 'List Sub-agents',
      description:
        'List sub-agents started in this bot process, including status, runtime, and output size.',
      parameters: ListParams,

      async execute() {
        const all = registry.all();
        if (all.length === 0) return textResult('No sub-agents.');

        return textResult(all.map((subagent) => formatListEntry(subagent)).join('\n\n'));
      },
    });
  };
}

/** Cancels every running sub-agent. Used by /abort and on shutdown. */
export function cancelAllSubagents(): Promise<number> {
  return registry.cancelAll();
}

/** Number of running sub-agents. Used by /status. */
export function runningSubagentCount(): number {
  return registry.runningCount();
}

export function formatSubagentReportPrompt(report: SubagentReport): string {
  return buildAgentEnvelope({
    preamble: `[subagent-report] Sub-agent ${report.subagentId} (${report.label}) ${report.outcome}.`,
    sections: [
      { intro: 'Task:', body: preview(report.task, REPORT_TASK_PREVIEW_CHARS) },
      { intro: 'Result:', body: report.result, fallback: '(no output)' },
    ],
    guidance: [
      'This is an internal report from a background sub-agent you started earlier, not a message from the user.',
      'Review the result and send the user a concise update with the outcome. Handle any follow-up work yourself.',
    ],
  });
}

function launchSubagent(
  runtime: PiRuntime,
  params: Static<typeof StartParams>,
  maxRuntimeMs: number,
): Subagent {
  const { model, modelName } = resolveSubagentModel(runtime);
  const subagent: Subagent = {
    id: registry.allocateId(),
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

  registry.register(subagent);
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
    void registry.reportEnd(subagent);
  }
}

async function createSubagentSession(runtime: PiRuntime, model: Model<Api>): Promise<AgentSession> {
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

function describeOutcome(subagent: Subagent): string {
  const runtime = formatDuration(registry.runtimeMs(subagent));
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
    `  Model: ${subagent.modelName}`,
    `  Runtime: ${formatDuration(registry.runtimeMs(subagent))}`,
    `  Output: ${subagent.outputChars} chars`,
  ].join('\n');
}

function formatResult(subagent: Subagent): string {
  const full = subagent.outputTail.trim() || '(no output)';
  if (
    full.length <= SUBAGENT_MAX_RESULT_CHARS &&
    subagent.outputChars <= subagent.outputTail.length
  ) {
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
