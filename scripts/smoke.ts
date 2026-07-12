import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ALLOWED_CHATS_PATH,
	BOT_SETTINGS_PATH,
	ALLOWED_MODELS,
	BACKGROUND_MODEL,
	BOT_TOKEN,
	DEFAULT_MODEL,
	MODEL,
	PROJECT_EXTENSIONS_DIR,
	PROJECT_ROOT,
	PROJECT_SKILLS_DIR,
	SUBAGENT_MODEL,
	SUBAGENT_SKILLS,
	getAllowedTelegramChatIds,
} from "../src/config.ts";
import { discoverExtensionPaths, discoverSkillPaths } from "../src/discovery.ts";
import { protectedEnvToolAccessExtension } from "../src/env-guard.ts";
import { createPiRuntime, type PiRuntime } from "../src/pi-session.ts";
import { scheduledTasksExtension } from "../src/scheduled-tasks.ts";
import { subagentToolsExtension } from "../src/subagents.ts";
import {
	activeModelSystemPromptExtension,
	allowedChatsSystemPromptExtension,
	ensureMemoryFile,
	memorySystemPromptExtension,
	readSystemPrompt,
} from "../src/system-prompt.ts";

const INDEX_ENTRYPOINTS = ["index.ts", "index.js", "index.mjs", "index.cjs"] as const;

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEnvironment(): void {
	assert(BOT_TOKEN, "Missing TELEGRAM_BOT_TOKEN or BOT_TOKEN.");
	assert(DEFAULT_MODEL, "Missing default chat model.");
	assert(ALLOWED_MODELS.length > 0, "No allowed chat models configured.");
	assert(
		ALLOWED_MODELS.includes(DEFAULT_MODEL),
		`Default chat model (${DEFAULT_MODEL}) must be present in CONFIG_ALLOWED_MODELS.`,
	);
	assert(
		ALLOWED_MODELS.includes(MODEL),
		`Active chat model (${MODEL}) must be present in CONFIG_ALLOWED_MODELS. Check ${BOT_SETTINGS_PATH}.`,
	);
	assert(BACKGROUND_MODEL, "Missing background model.");
	assert(
		ALLOWED_MODELS.includes(BACKGROUND_MODEL),
		`Background model (${BACKGROUND_MODEL}) must be present in CONFIG_ALLOWED_MODELS.`,
	);
	assert(SUBAGENT_MODEL, "Missing sub-agent model.");
	assert(
		ALLOWED_MODELS.includes(SUBAGENT_MODEL),
		`Sub-agent model (${SUBAGENT_MODEL}) must be present in CONFIG_ALLOWED_MODELS.`,
	);
	assert(
		getAllowedTelegramChatIds().length > 0,
		`No enabled Telegram chats configured. Check ${ALLOWED_CHATS_PATH}.`,
	);
}

/**
 * Imports every src module so import-time crashes are caught before a restart.
 * main.ts is excluded: importing it would start the bot (top-level await).
 */
async function importAllSourceModules(): Promise<number> {
	const srcDir = path.join(PROJECT_ROOT, "src");
	const files = fs
		.readdirSync(srcDir)
		.filter((name) => name.endsWith(".ts"))
		.sort();

	for (const name of files) {
		await import(pathToFileURL(path.join(srcDir, name)).href);
	}

	return files.length;
}

function resolveExtensionImportPaths(extensionPath: string): string[] {
	const stat = fs.statSync(extensionPath);
	if (stat.isFile()) return [extensionPath];

	const packageJsonPath = path.join(extensionPath, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageJson;
		const extensionEntries = packageJson.pi?.extensions;
		if (Array.isArray(extensionEntries) && extensionEntries.length > 0) {
			return extensionEntries.map((entry) => {
				assert(typeof entry === "string", `${packageJsonPath}: pi.extensions entries must be strings.`);
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
			assert(isRecord(tool), "Extension attempted to register a non-object tool.");
			assert(typeof tool.name === "string" && tool.name.trim(), "Extension registered a tool without a name.");
			registeredTools++;
		},
		on(eventName: unknown, callback: unknown) {
			assert(typeof eventName === "string" && eventName.trim(), "Extension registered an invalid event name.");
			assert(typeof callback === "function", `Extension event ${eventName} must use a function callback.`);
			return () => undefined;
		},
	} as unknown as ExtensionAPI;

	for (const extensionPath of extensionPaths) {
		for (const importPath of resolveExtensionImportPaths(extensionPath)) {
			const module = (await import(pathToFileURL(importPath).href)) as ExtensionModule;
			assert(typeof module.default === "function", `${importPath} must export a default extension function.`);
			(module.default as (pi: ExtensionAPI) => void)(fakePi);
		}
	}

	return registeredTools;
}

function createSmokeRuntimes(extensionPaths: string[], skillPaths: string[]): PiRuntime {
	const common = {
		cwd: process.cwd(),
		getExtensionPaths: () => extensionPaths,
		getSkillPaths: () => skillPaths,
		systemPromptOverride: () => readSystemPrompt(),
		extensionFactories: [
			memorySystemPromptExtension,
			activeModelSystemPromptExtension,
			allowedChatsSystemPromptExtension,
			protectedEnvToolAccessExtension,
		],
	};

	const chatRuntime = createPiRuntime({
		...common,
		model: MODEL,
		sessionPrefix: "smoke-chat",
	});

	createPiRuntime({
		...common,
		model: BACKGROUND_MODEL,
		sessionPrefix: "smoke-background",
	});

	return chatRuntime;
}

function verifySubagentSkillConfig(skillPaths: string[]): void {
	const discovered = new Set(
		skillPaths.flatMap((skillPath) => [
			path.basename(skillPath),
			path.basename(skillPath).replace(/\.[^.]+$/, ""),
			path.basename(path.dirname(skillPath)),
		]),
	);

	for (const skill of SUBAGENT_SKILLS) {
		assert(discovered.has(skill), `Configured sub-agent skill was not discovered: ${skill}`);
	}
}

function verifyScheduledTaskTools(): number {
	const registeredTools = new Set<string>();
	const fakePi = {
		registerTool(tool: unknown) {
			assert(isRecord(tool), "Scheduled-task extension attempted to register a non-object tool.");
			assert(
				typeof tool.name === "string" && tool.name.trim(),
				"Scheduled-task extension registered a tool without a name.",
			);
			registeredTools.add(tool.name);
		},
	} as unknown as ExtensionAPI;

	scheduledTasksExtension("smoke-chat")(fakePi);

	for (const name of [
		"create_schedule_task",
		"list_scheduled_tasks",
		"cancel_scheduled_task",
		"update_scheduled_task",
	]) {
		assert(registeredTools.has(name), `Scheduled-task extension did not register ${name}.`);
	}
	return registeredTools.size;
}

function verifySubagentTools(runtime: PiRuntime): number {
	const registeredTools = new Set<string>();
	const fakePi = {
		registerTool(tool: unknown) {
			assert(isRecord(tool), "Sub-agent extension attempted to register a non-object tool.");
			assert(
				typeof tool.name === "string" && tool.name.trim(),
				"Sub-agent extension registered a tool without a name.",
			);
			registeredTools.add(tool.name);
		},
		on() {
			return () => undefined;
		},
	} as unknown as ExtensionAPI;

	subagentToolsExtension("smoke-chat", runtime)(fakePi);

	for (const name of ["subagent_start", "subagent_read", "subagent_cancel", "subagent_list"]) {
		assert(registeredTools.has(name), `Sub-agent extension did not register ${name}.`);
	}
	return registeredTools.size;
}

async function main(): Promise<void> {
	validateEnvironment();
	ensureMemoryFile();
	assert(readSystemPrompt().trim(), "System prompt is empty.");

	const importedModules = await importAllSourceModules();
	const extensionPaths = discoverExtensionPaths(PROJECT_EXTENSIONS_DIR);
	const skillPaths = discoverSkillPaths(PROJECT_SKILLS_DIR);
	verifySubagentSkillConfig(skillPaths);
	const registeredTools = await importAndRegisterExtensions(extensionPaths);
	const chatRuntime = createSmokeRuntimes(extensionPaths, skillPaths);
	const scheduledTaskTools = verifyScheduledTaskTools();
	const subagentTools = verifySubagentTools(chatRuntime);

	console.log(
		`Smoke test passed: ${importedModules} src module(s), ${extensionPaths.length} extension path(s), ${registeredTools} registered tool(s), ${scheduledTaskTools} scheduled-task tool(s), ${subagentTools} sub-agent tool(s), ${skillPaths.length} skill(s).`,
	);
}

await main();
