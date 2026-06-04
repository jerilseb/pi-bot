import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
	addCronJob,
	cancelCronJob,
	formatCronJob,
	readCronJobs,
	updateCronJob,
	type CronJobKind,
} from "../src/cron-store.ts";
import { textResult } from "../src/tool-result.ts";

const JobKind = Type.Union([
	Type.Literal("once"),
	Type.Literal("interval"),
	Type.Literal("cron"),
]);

const ScheduleTaskParams = Type.Object({
	kind: JobKind,
	prompt: Type.String({
		description: "The exact instructions to run when the scheduled task fires.",
		minLength: 1,
	}),
	title: Type.Optional(
		Type.String({ description: "Short human-readable title for the task." }),
	),
	run_at: Type.Optional(
		Type.String({
			description: "ISO timestamp for one-time tasks, e.g. 2026-05-29T09:00:00+05:30.",
		}),
	),
	interval_minutes: Type.Optional(
		Type.Integer({
			description: "Repeat interval in minutes for interval tasks. Minimum 1.",
			minimum: 1,
		}),
	),
	schedule: Type.Optional(
		Type.String({
			description: "Five-field cron expression for cron tasks, e.g. '0 9 * * 1-5'.",
		}),
	),
	timezone: Type.Optional(
		Type.String({
			description: "IANA timezone for cron expressions, e.g. Asia/Kolkata or America/New_York.",
		}),
	),
});

type ScheduleTaskParamsType = Static<typeof ScheduleTaskParams>;

const ListScheduledTasksParams = Type.Object({});

const CancelScheduledTaskParams = Type.Object({
	id: Type.String({ description: "Scheduled task id to cancel." }),
});

type CancelScheduledTaskParamsType = Static<typeof CancelScheduledTaskParams>;

const UpdateScheduledTaskParams = Type.Object({
	id: Type.String({ description: "Scheduled task id to update." }),
	enabled: Type.Optional(Type.Boolean({ description: "Enable or disable this task." })),
	kind: Type.Optional(JobKind),
	prompt: Type.Optional(Type.String({ minLength: 1 })),
	title: Type.Optional(Type.String()),
	run_at: Type.Optional(Type.String()),
	interval_minutes: Type.Optional(Type.Integer({ minimum: 1 })),
	schedule: Type.Optional(Type.String()),
	timezone: Type.Optional(Type.String()),
});

type UpdateScheduledTaskParamsType = Static<typeof UpdateScheduledTaskParams>;

export default function scheduledTasksExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "schedule_task",
		label: "Schedule Task",
		description: "Create a scheduled task for the Telegram assistant. Use for reminders, recurring checks, or future/proactive work. For kind='once', provide run_at. For kind='interval', provide interval_minutes. For kind='cron', provide a five-field cron schedule and preferably timezone.",
		promptSnippet: "Schedule one-time, interval, or cron-like Telegram assistant tasks.",
		promptGuidelines: [
			"Use schedule_task when the user asks you to do something later, at a specific time, or repeatedly.",
			"If the user gives a relative time like tomorrow or next week, get the current time with bash date before scheduling.",
			"Prefer timezone-aware ISO timestamps for one-time tasks and IANA timezones for cron tasks.",
			"Keep the scheduled prompt self-contained; include what to check and when to notify the user.",
		],
		parameters: ScheduleTaskParams,
		async execute(_toolCallId, params: ScheduleTaskParamsType) {
			const input = toCreateInput(params);
			const job = addCronJob(input);
			return textResult(`Scheduled task created:\n${formatCronJob(job)}`);
		},
	});

	pi.registerTool({
		name: "list_scheduled_tasks",
		label: "List Scheduled Tasks",
		description: "List scheduled one-time, interval, and cron-like tasks for the Telegram assistant.",
		promptSnippet: "List scheduled Telegram assistant tasks.",
		parameters: ListScheduledTasksParams,
		async execute() {
			const jobs = readCronJobs();
			return textResult(
				jobs.length
					? jobs.map(formatCronJob).join("\n")
					: "No scheduled tasks.",
			);
		},
	});

	pi.registerTool({
		name: "cancel_scheduled_task",
		label: "Cancel Scheduled Task",
		description: "Disable a scheduled task by id.",
		promptSnippet: "Cancel scheduled Telegram assistant tasks.",
		parameters: CancelScheduledTaskParams,
		async execute(_toolCallId, params: CancelScheduledTaskParamsType) {
			const job = cancelCronJob(params.id);
			return textResult(`Scheduled task cancelled:\n${formatCronJob(job)}`);
		},
	});

	pi.registerTool({
		name: "update_scheduled_task",
		label: "Update Scheduled Task",
		description: "Update a scheduled task. Provide only fields that should change. Changing schedule fields recomputes the next run time.",
		promptSnippet: "Update scheduled Telegram assistant tasks.",
		parameters: UpdateScheduledTaskParams,
		async execute(_toolCallId, params: UpdateScheduledTaskParamsType) {
			const job = updateCronJob(params.id, {
				...(params.enabled === undefined ? {} : { enabled: params.enabled }),
				...(params.kind ? { kind: params.kind as CronJobKind } : {}),
				...(params.prompt ? { prompt: params.prompt } : {}),
				...(params.title ? { title: params.title } : {}),
				...(params.run_at ? { runAt: params.run_at } : {}),
				...(params.interval_minutes
					? { intervalMs: params.interval_minutes * 60_000 }
					: {}),
				...(params.schedule ? { schedule: params.schedule } : {}),
				...(params.timezone ? { timezone: params.timezone } : {}),
			});
			return textResult(`Scheduled task updated:\n${formatCronJob(job)}`);
		},
	});
}

function toCreateInput(params: ScheduleTaskParamsType): {
	kind: CronJobKind;
	prompt: string;
	title?: string;
	runAt?: string;
	intervalMs?: number;
	schedule?: string;
	timezone?: string;
} {
	if (params.kind === "once" && !params.run_at) {
		throw new Error("kind='once' requires run_at");
	}
	if (params.kind === "interval" && !params.interval_minutes) {
		throw new Error("kind='interval' requires interval_minutes");
	}
	if (params.kind === "cron" && !params.schedule) {
		throw new Error("kind='cron' requires schedule");
	}

	return {
		kind: params.kind,
		prompt: params.prompt,
		...(params.title ? { title: params.title } : {}),
		...(params.run_at ? { runAt: params.run_at } : {}),
		...(params.interval_minutes
			? { intervalMs: params.interval_minutes * 60_000 }
			: {}),
		...(params.schedule ? { schedule: params.schedule } : {}),
		...(params.timezone ? { timezone: params.timezone } : {}),
	};
}

