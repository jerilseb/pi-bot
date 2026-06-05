import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TavilySearchParams = Type.Object({
	query: Type.String({ description: "What to search for on the web" }),
	topic: Type.Optional(
		StringEnum(["general", "news"] as const, {
			description: "Search topic. Use 'news' for recent events and headlines.",
			default: "general",
		}),
	),
	search_depth: Type.Optional(
		StringEnum(["basic", "advanced"] as const, {
			description: "Search depth. Use 'advanced' for better research.",
			default: "advanced",
		}),
	),
	include_answer: Type.Optional(
		StringEnum(["none", "basic", "advanced"] as const, {
			description: "Whether Tavily should synthesize an answer.",
			default: "basic",
		}),
	),
	max_results: Type.Optional(
		Type.Integer({
			description: "Maximum number of results to return (1-10).",
			minimum: 1,
			maximum: 10,
			default: 5,
		}),
	),
});

type TavilySearchParamsType = {
	query: string;
	topic?: "general" | "news";
	search_depth?: "basic" | "advanced";
	include_answer?: "none" | "basic" | "advanced";
	max_results?: number;
};

type TavilyResult = {
	url?: string;
	title?: string;
	content?: string;
	score?: number;
	favicon?: string;
	raw_content?: string | null;
};

type TavilyResponse = {
	query?: string;
	follow_up_questions?: string[] | null;
	answer?: string | null;
	images?: string[];
	results?: TavilyResult[];
	response_time?: number;
	request_id?: string;
};

function cleanText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function shorten(value: string | null | undefined, max = 320): string {
	const text = cleanText(value);
	if (!text) return "";
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function buildResultText(
	data: TavilyResponse,
	params: TavilySearchParamsType,
): string {
	const lines: string[] = [];
	const results = Array.isArray(data.results) ? data.results : [];
	const followUps = Array.isArray(data.follow_up_questions)
		? data.follow_up_questions
		: [];

	lines.push(`Query: ${data.query ?? params.query}`);
	lines.push(`Topic: ${params.topic ?? "general"}`);
	lines.push(`Depth: ${params.search_depth ?? "advanced"}`);
	lines.push(`Results returned: ${results.length}`);

	if (typeof data.response_time === "number") {
		lines.push(`Response time: ${data.response_time}s`);
	}

	if (data.request_id) {
		lines.push(`Request ID: ${data.request_id}`);
	}

	const answer = cleanText(data.answer);
	if (answer) {
		lines.push("");
		lines.push("Answer:");
		lines.push(answer);
	}

	if (followUps.length > 0) {
		lines.push("");
		lines.push("Follow-up questions:");
		for (const question of followUps) {
			lines.push(`- ${cleanText(question)}`);
		}
	}

	if (results.length > 0) {
		lines.push("");
		lines.push("Top results:");
		results.forEach((result, index) => {
			lines.push(
				`${index + 1}. ${cleanText(result.title) || "Untitled result"}`,
			);
			if (result.url) lines.push(`   URL: ${result.url}`);
			if (typeof result.score === "number")
				lines.push(`   Score: ${result.score.toFixed(3)}`);
			const excerpt = shorten(result.content, 500);
			if (excerpt) lines.push(`   Excerpt: ${excerpt}`);
			if (result.favicon) lines.push(`   Favicon: ${result.favicon}`);
		});
	}

	if ((data.images?.length ?? 0) > 0) {
		lines.push("");
		lines.push(`Images returned: ${data.images?.length ?? 0}`);
	}

	return lines.join("\n");
}

async function saveFullOutput(text: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-tavily-"));
	const path = join(dir, "tavily-search.txt");
	await writeFile(path, text, "utf8");
	return path;
}

function collectApiKeys(): { name: string; value: string }[] {
	const keys: { name: string; value: string }[] = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (/^TAVILY_API_KEY_\d+$/.test(name) && value && value.trim().length > 0) {
			keys.push({ name, value: value.trim() });
		}
	}
	keys.sort((a, b) => a.name.localeCompare(b.name));
	return keys;
}

function pickApiKey(): { name: string; value: string } | null {
	const keys = collectApiKeys();
	if (keys.length === 0) return null;
	return keys[Math.floor(Math.random() * keys.length)];
}

export default function tavilySearchExtension(pi: ExtensionAPI) {
	const selectedKey = pickApiKey();

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const message = selectedKey
			? `Tavily web_search: using ${selectedKey.name}`
			: "Tavily web_search: no API key configured (set TAVILY_API_KEY_1, TAVILY_API_KEY_2, ...)";
		const type: "info" | "warning" = selectedKey ? "info" : "warning";
		// Defer one tick so session rebuild logic after session_start cannot clear a synchronous notify.
		setTimeout(() => ctx.ui.notify(message, type), 0);
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web using Tavily for current or external information. Best for news, recent events, documentation, and anything not available in the local repository. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Set TAVILY_API_KEY_1 (and optionally TAVILY_API_KEY_2, ...) in the environment before starting pi; one is picked at random per session.`,
		promptSnippet: "Search the public web for current or external information",
		promptGuidelines: [
			"Use web_search tool when the user asks for recent news, web research, or information not present in local files.",
			"Prefer local tools like read, grep, find, and bash when the answer should come from the repository itself.",
		],
		parameters: TavilySearchParams,

		async execute(_toolCallId, params, signal) {
			if (!selectedKey) {
				throw new Error(
					"Missing Tavily API key. Set TAVILY_API_KEY_1 (and optionally TAVILY_API_KEY_2, ...) before starting pi, then restart the bot.",
				);
			}

			const requestBody = {
				query: params.query,
				topic: params.topic ?? "general",
				search_depth: params.search_depth ?? "advanced",
				include_answer: params.include_answer ?? "basic",
				max_results: params.max_results ?? 5,
			};

			const response = await fetch("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${selectedKey.value}`,
				},
				body: JSON.stringify(requestBody),
				signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Tavily API error ${response.status}: ${errorText || response.statusText}`,
				);
			}

			const data = (await response.json()) as TavilyResponse;
			const resultText = buildResultText(
				data,
				params as TavilySearchParamsType,
			);
			const truncation = truncateHead(resultText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let outputText = truncation.content;
			let fullOutputPath: string | undefined;

			if (truncation.truncated) {
				fullOutputPath = await saveFullOutput(resultText);
				outputText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details: {
					query: data.query ?? params.query,
					topic: requestBody.topic,
					search_depth: requestBody.search_depth,
					include_answer: requestBody.include_answer,
					max_results: requestBody.max_results,
					answer: cleanText(data.answer),
					follow_up_questions: data.follow_up_questions ?? [],
					images_count: data.images?.length ?? 0,
					response_time: data.response_time,
					request_id: data.request_id,
					truncated: truncation.truncated,
					full_output_path: fullOutputPath,
					results: (data.results ?? []).map((result) => ({
						title: cleanText(result.title),
						url: result.url,
						score: result.score,
						favicon: result.favicon,
						excerpt: shorten(result.content, 240),
					})),
				},
			};
		},
	});
}
