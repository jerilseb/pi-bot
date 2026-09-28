import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  HEARTBEAT_MODEL,
  HEARTBEAT_SESSIONS_DIR,
  MODEL,
  PROJECT_ROOT,
  SCHEDULED_TASKS_SESSIONS_DIR,
  SUBAGENT_SESSIONS_DIR,
} from '../src/config.ts';
import { collectConfigProblems } from '../src/config-validation.ts';
import { contextGistSystemPromptExtension } from '../src/context-gist.ts';
import { protectedEnvToolAccessExtension } from '../src/env-guard.ts';
import {
  assertModelUsable,
  createPiRuntime,
  loadResources,
  type PiRuntime,
} from '../src/pi-session.ts';
import { scheduledTasksExtension } from '../src/scheduled-tasks.ts';
import { subagentExtension } from '../src/subagent.ts';
import { isRecord } from '../src/util.ts';
import {
  activeModelSystemPromptExtension,
  ensureMemoryFile,
  memorySystemPromptExtension,
  readSubagentSystemPrompt,
  readSystemPrompt,
} from '../src/system-prompt.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validateConfiguration(): void {
  const problems = collectConfigProblems();
  assert(
    problems.length === 0,
    `Invalid configuration:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
  );
}

/**
 * Imports every module under src/, subdirectories included, so import-time
 * crashes are caught before a restart. The entry points (main.ts) live outside
 * src/ and are never imported: importing one would start the bot.
 */
async function importAllSourceModules(): Promise<number> {
  const srcDir = path.join(PROJECT_ROOT, 'src');
  const files = fs
    .readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .sort();

  for (const name of files) {
    await import(pathToFileURL(path.join(srcDir, name)).href);
  }

  return files.length;
}

/**
 * Loads the project's extensions the way every session does, through Pi's
 * resource loader, so an extension Pi cannot load fails the check instead of
 * going missing from the agent after a restart.
 */
async function verifyProjectExtensions(
  runtime: PiRuntime,
): Promise<{ extensions: number; tools: number }> {
  const loader = await loadResources(runtime, {
    extensionFactories: [],
    systemPromptOverride: () => readSystemPrompt(),
  });
  const { extensions, errors } = loader.getExtensions();
  assert(
    errors.length === 0,
    `Extensions failed to load:\n${errors.map((e) => `- ${e.path}: ${e.error}`).join('\n')}`,
  );
  assert(extensions.length > 0, 'No project extensions were loaded.');
  const tools = extensions.reduce((count, extension) => count + extension.tools.size, 0);
  return { extensions: extensions.length, tools };
}

/**
 * Asserts that both runtimes build, and that every configured model resolves with
 * auth. The runtimes no longer resolve a model themselves, so these checks are
 * explicit — they mirror validateModels() in main.ts. Returns the chat runtime.
 */
async function createSmokeRuntimes(): Promise<PiRuntime> {
  const common = {
    cwd: process.cwd(),
    // As in main.ts: the project root is a Pi package naming extensions/.
    getExtensionPaths: () => [PROJECT_ROOT],
    systemPromptOverride: () => readSystemPrompt(),
    extensionFactories: [
      contextGistSystemPromptExtension,
      memorySystemPromptExtension,
      activeModelSystemPromptExtension,
      protectedEnvToolAccessExtension,
    ],
    workerExtensionFactories: [protectedEnvToolAccessExtension],
  };

  const chat = await createPiRuntime({
    ...common,
    model: MODEL,
    sessionPrefix: 'smoke-chat',
    sessionKind: 'chat',
  });
  assertModelUsable(chat.modelRuntime, MODEL);

  const background = await createPiRuntime({
    ...common,
    model: null,
    sessionPrefix: 'smoke-background',
    sessionKind: 'background',
  });
  // Scheduled tasks fall back to the chat model, already checked above.
  if (HEARTBEAT_MODEL) assertModelUsable(background.modelRuntime, HEARTBEAT_MODEL);
  return chat;
}

/**
 * Registers a gated extension against a fake API and checks its tool names.
 * Gated extensions (scheduled tasks, sub-agents) are only wired into a session
 * when their switch is on, so they are exercised here regardless, or a disabled
 * deploy could ship a definition that fails the moment someone enables it.
 */
function verifyGatedExtensionTools(
  label: string,
  extension: (pi: ExtensionAPI) => void,
  expectedTools: string[],
): number {
  const registeredTools = new Set<string>();
  const fakePi = {
    registerTool(tool: unknown) {
      assert(isRecord(tool), `${label} extension attempted to register a non-object tool.`);
      assert(
        typeof tool.name === 'string' && tool.name.trim(),
        `${label} extension registered a tool without a name.`,
      );
      registeredTools.add(tool.name);
    },
  } as unknown as ExtensionAPI;

  extension(fakePi);

  for (const name of expectedTools) {
    assert(registeredTools.has(name), `${label} extension did not register ${name}.`);
  }
  return registeredTools.size;
}

function verifyScheduledTaskTools(): number {
  return verifyGatedExtensionTools('Scheduled-task', scheduledTasksExtension, [
    'create_schedule_task',
    'list_scheduled_tasks',
    'cancel_scheduled_task',
    'update_scheduled_task',
  ]);
}

function verifySubagentTools(): number {
  const extension = subagentExtension({
    origin: 'chat',
    runWorker: async () => {
      throw new Error('Smoke check never runs a worker.');
    },
  });
  return verifyGatedExtensionTools('Sub-agent', extension, [
    'subagent_run',
    'subagent_read',
    'subagent_stop',
    'subagent_list',
    'subagent_stop_all',
  ]);
}

async function main(): Promise<void> {
  validateConfiguration();
  ensureMemoryFile();
  fs.mkdirSync(SUBAGENT_SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(HEARTBEAT_SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(SCHEDULED_TASKS_SESSIONS_DIR, { recursive: true });
  assert(readSystemPrompt().trim(), 'System prompt is empty.');
  assert(readSubagentSystemPrompt().trim(), 'Sub-agent worker prompt is empty.');

  const importedModules = await importAllSourceModules();
  const chat = await createSmokeRuntimes();
  const loaded = await verifyProjectExtensions(chat);
  const scheduledTaskTools = verifyScheduledTaskTools();
  const subagentTools = verifySubagentTools();

  console.log(
    `Smoke test passed: ${importedModules} src module(s), ${loaded.extensions} extension(s), ${loaded.tools} extension tool(s), ${scheduledTaskTools} scheduled-task tool(s), ${subagentTools} sub-agent tool(s).`,
  );
}

await main();
