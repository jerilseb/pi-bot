/**
 * Web Fetch Tool - Fetches pages using native fetch with Chrome impersonation
 * and converts the HTML to Markdown via Turndown.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import TurndownService from "turndown";

const FetchParams = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
});

interface FetchDetails {
	url: string;
	status?: number;
	statusText?: string;
	contentType?: string;
	truncated?: boolean;
	fullOutputPath?: string;
}

const CHROME_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Accept-Encoding": "gzip, deflate, br",
	"Upgrade-Insecure-Requests": "1",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
};

export default function (pi: ExtensionAPI) {
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch content from a URL impersonating Chrome, convert the page to Markdown. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. If truncated, full output is saved to a temp file.`,
		parameters: FetchParams,

		async execute(_toolCallId, params, signal) {
			const { url } = params;
			const details: FetchDetails = { url };

			try {
				const response = await fetch(url, {
					headers: CHROME_HEADERS,
					signal,
					redirect: "follow",
				});

				details.status = response.status;
				details.statusText = response.statusText;
				details.contentType =
					response.headers.get("content-type") ?? "text/html";

				const html = await response.text();
				const markdown = turndown.turndown(html);

				const truncation = truncateHead(markdown, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});

				let resultText = `HTTP ${details.status} ${details.statusText}\nContent-Type: ${details.contentType}\n\n${truncation.content}`;

				if (truncation.truncated) {
					const tempDir = mkdtempSync(join(tmpdir(), "pi-fetch-"));
					const tempFile = join(tempDir, "response.md");
					writeFileSync(tempFile, markdown);
					details.truncated = true;
					details.fullOutputPath = tempFile;
					resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
				}

				return {
					content: [{ type: "text", text: resultText }],
					details,
					isError: response.status >= 400,
				};
			} catch (error) {
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Request cancelled" }],
						details,
						isError: true,
					};
				}

				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Fetch failed: ${message}` }],
					details,
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("web_fetch ")) +
					theme.fg("muted", args.url),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as FetchDetails | undefined;

			if (!details?.status) {
				const content = result.content[0];
				const msg = content?.type === "text" ? content.text : "Request failed";
				return new Text(theme.fg("error", msg), 0, 0);
			}

			const statusColor = details.status < 400 ? "success" : "error";
			let text = theme.fg(
				statusColor,
				`${details.status} ${details.statusText}`,
			);
			if (details.contentType) {
				text += theme.fg("dim", ` (${details.contentType})`);
			}
			if (details.truncated) {
				text += theme.fg("warning", " [truncated]");
			}

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 30);
					for (const line of lines) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (content.text.split("\n").length > 30) {
						text += `\n${theme.fg("muted", "...")}`;
					}
				}
				if (details.fullOutputPath) {
					text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
