## Openai Usage Extension

```
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	matchesKey,
	Spacer,
	Text,
} from "@mariozechner/pi-tui";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_MODEL = "gpt-5.4-mini";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const ESC = String.fromCharCode(27);
const ANSI_REGEX = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

type UsageWindow = {
	name: string;
	usedPercent?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
	windowMinutes?: number;
};

type OpenAIUsage = {
	status: number;
	statusText: string;
	requestId?: string;
	planType?: string;
	activeLimit?: string;
	modelsEtag?: string;
	creditsBalance?: string;
	creditsHasCredits?: boolean;
	creditsUnlimited?: boolean;
	primaryOverSecondaryLimitPercent?: number;
	primary: UsageWindow;
	secondary: UsageWindow;
};

function visualWidth(text: string): number {
	return [...text.replace(ANSI_REGEX, "")].length;
}

function padRight(text: string, width: number): string {
	const pad = width - visualWidth(text);
	return pad > 0 ? text + " ".repeat(pad) : text;
}

function titleCase(value: string | undefined): string {
	if (!value) return "—";
	return value
		.split(/[ _-]+/g)
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
		.join(" ");
}

function parseNumber(value: string | null): number | undefined {
	if (value === null || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: string | null): boolean | undefined {
	if (value === null) return undefined;
	if (/^true$/i.test(value)) return true;
	if (/^false$/i.test(value)) return false;
	return undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const payload = token.split(".")[1];
	if (!payload) throw new Error("Access token is not a JWT");
	const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64.padEnd(
		base64.length + ((4 - (base64.length % 4)) % 4),
		"=",
	);
	return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function getAccountId(accessToken: string): string {
	const payload = decodeJwtPayload(accessToken);
	const auth = payload[JWT_CLAIM_PATH] as
		| { chatgpt_account_id?: unknown }
		| undefined;
	const accountId = auth?.chatgpt_account_id;
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error(
			"Could not find chatgpt_account_id in the OpenAI Codex access token.",
		);
	}
	return accountId;
}

function formatPercent(value: number | undefined): string {
	if (value === undefined) return "—";
	return `${value.toFixed(value < 10 && value !== 0 ? 1 : 0)}%`;
}

function formatWindow(minutes: number | undefined): string {
	if (minutes === undefined) return "—";
	if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function formatDuration(totalSeconds: number | undefined): string {
	if (totalSeconds === undefined) return "—";
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0 || days > 0) parts.push(`${hours}h`);
	parts.push(`${minutes}m`);
	return parts.join(" ");
}

function formatResetAt(unixSeconds: number | undefined): string {
	if (unixSeconds === undefined) return "—";
	return new Date(unixSeconds * 1000).toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function usageBar(
	percent: number | undefined,
	width: number,
	theme: Theme,
): string {
	const normalized = percent === undefined ? 0 : percent / 100;
	const clamped = Math.max(0, Math.min(1, normalized));
	const filled = Math.round(clamped * width);
	const empty = width - filled;
	const fillColor: Parameters<Theme["fg"]>[0] =
		clamped >= 0.9 ? "error" : clamped >= 0.7 ? "warning" : "success";
	return (
		theme.fg(fillColor, "█".repeat(filled)) +
		theme.fg("borderMuted", "░".repeat(empty))
	);
}

function sectionHeading(label: string, theme: Theme): Text {
	return new Text(theme.fg("accent", theme.bold(label)), 1, 0);
}

function rule(theme: Theme, char = "─"): Text {
	return new Text(theme.fg("borderMuted", char.repeat(64)), 1, 0);
}

function field(label: string, value: string, theme: Theme): Text {
	return new Text(
		padRight(theme.fg("muted", label), 14) + theme.fg("text", value),
		1,
		0,
	);
}

function windowColor(window: UsageWindow): Parameters<Theme["fg"]>[0] {
	const used = window.usedPercent ?? 0;
	if (used >= 90) return "error";
	if (used >= 70) return "warning";
	return "success";
}

function buildOverviewSection(usage: OpenAIUsage, theme: Theme): Component[] {
	const out: Component[] = [];
	out.push(sectionHeading("ACCOUNT", theme));
	out.push(rule(theme));
	out.push(field("Plan", titleCase(usage.planType), theme));
	out.push(field("Limit", titleCase(usage.activeLimit), theme));

	const credits = usage.creditsUnlimited
		? "Unlimited"
		: usage.creditsHasCredits
			? usage.creditsBalance || "Available"
			: "No extra credits";
	out.push(field("Credits", credits, theme));

	if (usage.primaryOverSecondaryLimitPercent !== undefined) {
		out.push(
			field(
				"Overage",
				formatPercent(usage.primaryOverSecondaryLimitPercent),
				theme,
			),
		);
	}

	return out;
}

function buildWindowSection(window: UsageWindow, theme: Theme): Component[] {
	const out: Component[] = [];
	const color = windowColor(window);
	out.push(sectionHeading(`${window.name.toUpperCase()} WINDOW`, theme));
	out.push(rule(theme));
	out.push(
		new Text(
			padRight(theme.fg("muted", "Used"), 14) +
				theme.fg(color, theme.bold(formatPercent(window.usedPercent))) +
				theme.fg("dim", `  of ${formatWindow(window.windowMinutes)} window`),
			1,
			0,
		),
	);
	out.push(new Text(usageBar(window.usedPercent, 48, theme), 1, 0));
	out.push(field("Resets in", formatDuration(window.resetAfterSeconds), theme));
	out.push(field("Reset at", formatResetAt(window.resetAt), theme));
	return out;
}

function buildWarningsSection(warnings: string[], theme: Theme): Component[] {
	const out: Component[] = [];
	out.push(sectionHeading("WARNINGS", theme));
	out.push(rule(theme));
	for (const warning of warnings) {
		out.push(new Text(theme.fg("warning", `! ${warning}`), 1, 0));
	}
	return out;
}

function parseUsageHeaders(response: Response): OpenAIUsage {
	const h = response.headers;
	return {
		status: response.status,
		statusText: response.statusText,
		requestId: h.get("x-oai-request-id") ?? undefined,
		planType: h.get("x-codex-plan-type") ?? undefined,
		activeLimit: h.get("x-codex-active-limit") ?? undefined,
		modelsEtag: h.get("x-models-etag") ?? undefined,
		creditsBalance: h.get("x-codex-credits-balance") ?? undefined,
		creditsHasCredits: parseBoolean(h.get("x-codex-credits-has-credits")),
		creditsUnlimited: parseBoolean(h.get("x-codex-credits-unlimited")),
		primaryOverSecondaryLimitPercent: parseNumber(
			h.get("x-codex-primary-over-secondary-limit-percent"),
		),
		primary: {
			name: "5 hour",
			usedPercent: parseNumber(h.get("x-codex-primary-used-percent")),
			resetAfterSeconds: parseNumber(
				h.get("x-codex-primary-reset-after-seconds"),
			),
			resetAt: parseNumber(h.get("x-codex-primary-reset-at")),
			windowMinutes: parseNumber(h.get("x-codex-primary-window-minutes")),
		},
		secondary: {
			name: "7 day",
			usedPercent: parseNumber(h.get("x-codex-secondary-used-percent")),
			resetAfterSeconds: parseNumber(
				h.get("x-codex-secondary-reset-after-seconds"),
			),
			resetAt: parseNumber(h.get("x-codex-secondary-reset-at")),
			windowMinutes: parseNumber(h.get("x-codex-secondary-window-minutes")),
		},
	};
}

async function fetchOpenAIUsage(
	accessToken: string,
	signal?: AbortSignal,
): Promise<{ usage: OpenAIUsage; warnings: string[] }> {
	const accountId = getAccountId(accessToken);
	const response = await fetch(CODEX_RESPONSES_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"OpenAI-Beta": "responses=experimental",
			accept: "text/event-stream",
			"chatgpt-account-id": accountId,
			"content-type": "application/json",
			originator: "pi",
		},
		body: JSON.stringify({
			model: DEFAULT_MODEL,
			store: false,
			stream: true,
			instructions: "You are a usage probe. Reply with exactly: ok",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "ok" }],
				},
			],
			text: { verbosity: "medium" },
			include: ["reasoning.encrypted_content"],
			tool_choice: "auto",
			parallel_tool_calls: true,
		}),
		signal,
	});

	const usage = parseUsageHeaders(response);
	const warnings: string[] = [];
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		warnings.push(
			`Usage probe returned HTTP ${response.status}${body ? ` — ${body.slice(0, 160)}` : ""}`,
		);
	} else {
		await response.body?.cancel();
	}

	return { usage, warnings };
}

function buildMarkdownReport(usage: OpenAIUsage, warnings: string[]): string {
	const lines: string[] = [];
	lines.push("# OpenAI Codex Usage");
	lines.push("");
	lines.push(`- Plan: ${titleCase(usage.planType)}`);
	lines.push(`- Limit: ${titleCase(usage.activeLimit)}`);
	lines.push(
		`- Credits: ${usage.creditsHasCredits ? usage.creditsBalance || "Available" : "No extra credits"}`,
	);
	lines.push("");
	for (const window of [usage.primary, usage.secondary]) {
		lines.push(`## ${window.name} window`);
		lines.push(`- Used: ${formatPercent(window.usedPercent)}`);
		lines.push(`- Window: ${formatWindow(window.windowMinutes)}`);
		lines.push(`- Resets in: ${formatDuration(window.resetAfterSeconds)}`);
		lines.push(`- Reset at: ${formatResetAt(window.resetAt)}`);
		lines.push("");
	}
	if (warnings.length > 0) {
		lines.push("");
		lines.push("## Warnings");
		for (const warning of warnings) lines.push(`- ${warning}`);
	}
	return lines.join("\n");
}

async function showReport(
	usage: OpenAIUsage,
	warnings: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(buildMarkdownReport(usage, warnings), "info");
		return;
	}

	try {
		await ctx.ui.custom((_tui, theme, _kb, done) => {
			const container = new Container();
			const border = new DynamicBorder((s: string) =>
				theme.fg("borderAccent", s),
			);

			container.addChild(border);
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold("◆ OPENAI CODEX USAGE ◆")),
					1,
					0,
				),
			);
			container.addChild(new Spacer(1));

			for (const component of buildOverviewSection(usage, theme)) {
				container.addChild(component);
			}

			container.addChild(new Spacer(1));
			for (const component of buildWindowSection(usage.primary, theme)) {
				container.addChild(component);
			}

			container.addChild(new Spacer(1));
			for (const component of buildWindowSection(usage.secondary, theme)) {
				container.addChild(component);
			}

			if (warnings.length > 0) {
				container.addChild(new Spacer(1));
				for (const component of buildWarningsSection(warnings, theme)) {
					container.addChild(component);
				}
			}

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg("dim", "↵ Enter or Esc to close"), 1, 0),
			);
			container.addChild(border);

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
						done(undefined);
					}
				},
			};
		});
	} catch {
		ctx.ui.notify(buildMarkdownReport(usage, warnings), "info");
	}
}

export default function openaiUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("openai-usage", {
		description: "Show OpenAI Codex Plus/Pro usage windows and reset times",
		handler: async (_args, ctx) => {
			const accessToken = await ctx.modelRegistry.getApiKeyForProvider(
				OPENAI_CODEX_PROVIDER,
			);
			if (!accessToken) {
				ctx.ui.notify(
					"No OpenAI Codex OAuth credentials found. Run /login openai-codex first.",
					"error",
				);
				return;
			}

			ctx.ui.notify("Fetching OpenAI Codex usage...", "info");

			try {
				const { usage, warnings } = await fetchOpenAIUsage(
					accessToken,
					ctx.signal,
				);
				await showReport(usage, warnings, ctx);
			} catch (error) {
				ctx.ui.notify(
					`Failed to fetch OpenAI Codex usage: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
```
