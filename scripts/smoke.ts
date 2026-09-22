import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  HEARTBEAT_MODEL,
  MODEL,
  PI_AGENT_SKILLS_DIR,
  PROJECT_EXTENSIONS_DIR,
  PROJECT_ROOT,
  PROJECT_SKILLS_DIR,
  SUBAGENT_SESSIONS_DIR,
} from '../src/config.ts';
import { collectConfigProblems } from '../src/config-validation.ts';
import { contextGistSystemPromptExtension } from '../src/context-gist.ts';
import { discoverExtensionPaths, discoverSkillPaths } from '../src/discovery.ts';
import { protectedEnvToolAccessExtension } from '../src/env-guard.ts';
import { assertModelUsable, createPiRuntime } from '../src/pi-session.ts';
import { scheduledTasksExtension } from '../src/scheduled-tasks.ts';
import { subagentExtension } from '../src/subagent.ts';
import { isRecord } from '../src/util.ts';
import {
  activeModelSystemPromptExtension,
  ensureMemoryFile,
  ensureSubagentPromptFile,
  memorySystemPromptExtension,
  readSubagentSystemPrompt,
  readSystemPrompt,
} from '../src/system-prompt.ts';

const INDEX_ENTRYPOINTS = ['index.ts', 'index.js', 'index.mjs', 'index.cjs'] as const;

type ExtensionModule = {
  default?: unknown;
};

type PackageJson = {
  pi?: {
    extensions?: unknown;
  };
};

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
 * Imports every src module so import-time crashes are caught before a restart.
 * main.ts is excluded: importing it would start the bot (top-level await).
 */
async function importAllSourceModules(): Promise<number> {
  const srcDir = path.join(PROJECT_ROOT, 'src');
  const files = fs
    .readdirSync(srcDir)
    .filter((name) => name.endsWith('.ts'))
    .sort();

  for (const name of files) {
    await import(pathToFileURL(path.join(srcDir, name)).href);
  }

  return files.length;
}

function resolveExtensionImportPaths(extensionPath: string): string[] {
  const stat = fs.statSync(extensionPath);
  if (stat.isFile()) return [extensionPath];

  const packageJsonPath = path.join(extensionPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
    const extensionEntries = packageJson.pi?.extensions;
    if (Array.isArray(extensionEntries) && extensionEntries.length > 0) {
      return extensionEntries.map((entry) => {
        assert(
          typeof entry === 'string',
          `${packageJsonPath}: pi.extensions entries must be strings.`,
        );
        return path.resolve(extensionPath, entry);
      });
    }
  }

  for (const entrypoint of INDEX_ENTRYPOINTS) {
    const candidate = path.join(extensionPath, entrypoint);
    if (fs.existsSync(candidate)) return [candidate];
  }

  throw new Error(`Could not find an importable extension entrypoint for ${extensionPath}.`);
}

async function importAndRegisterExtensions(extensionPaths: string[]): Promise<number> {
  let registeredTools = 0;

  const fakePi = {
    registerTool(tool: unknown) {
      assert(isRecord(tool), 'Extension attempted to register a non-object tool.');
      assert(
        typeof tool.name === 'string' && tool.name.trim(),
        'Extension registered a tool without a name.',
      );
      registeredTools++;
    },
    on(eventName: unknown, callback: unknown) {
      assert(
        typeof eventName === 'string' && eventName.trim(),
        'Extension registered an invalid event name.',
      );
      assert(
        typeof callback === 'function',
        `Extension event ${eventName} must use a function callback.`,
      );
      return () => undefined;
    },
  } as unknown as ExtensionAPI;

  for (const extensionPath of extensionPaths) {
    for (const importPath of resolveExtensionImportPaths(extensionPath)) {
      const module = (await import(pathToFileURL(importPath).href)) as ExtensionModule;
      assert(
        typeof module.default === 'function',
        `${importPath} must export a default extension function.`,
      );
      (module.default as (pi: ExtensionAPI) => void)(fakePi);
    }
  }

  return registeredTools;
}

/**
 * Asserts that both runtimes build, and that every configured model resolves with
 * auth. The runtimes no longer resolve a model themselves, so these checks are
 * explicit — they mirror validateModels() in main.ts.
 */
async function createSmokeRuntimes(extensionPaths: string[], skillPaths: string[]): Promise<void> {
  const common = {
    cwd: process.cwd(),
    getExtensionPaths: () => extensionPaths,
    getSkillPaths: () => skillPaths,
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
  ensureSubagentPromptFile();
  fs.mkdirSync(SUBAGENT_SESSIONS_DIR, { recursive: true });
  assert(readSystemPrompt().trim(), 'System prompt is empty.');
  assert(readSubagentSystemPrompt().trim(), 'Sub-agent worker prompt is empty.');

  const importedModules = await importAllSourceModules();
  const extensionPaths = discoverExtensionPaths(PROJECT_EXTENSIONS_DIR);
  const skillPaths = discoverSkillPaths(PROJECT_SKILLS_DIR, PI_AGENT_SKILLS_DIR);
  const registeredTools = await importAndRegisterExtensions(extensionPaths);
  await createSmokeRuntimes(extensionPaths, skillPaths);
  const scheduledTaskTools = verifyScheduledTaskTools();
  const subagentTools = verifySubagentTools();

  console.log(
    `Smoke test passed: ${importedModules} src module(s), ${extensionPaths.length} extension path(s), ${registeredTools} registered tool(s), ${scheduledTaskTools} scheduled-task tool(s), ${subagentTools} sub-agent tool(s), ${skillPaths.length} skill(s).`,
  );
}

await main();
