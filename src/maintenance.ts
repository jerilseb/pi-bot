import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "./config.ts";
import { escapeTelegramHtml } from "./telegram.ts";
import { errorMessage } from "./util.ts";

const execFileAsync = promisify(execFile);

export interface GitPullResult {
	ok: boolean;
	output: string;
}

export async function gitPull(): Promise<GitPullResult> {
	try {
		const { stdout, stderr } = await execFileAsync("git", ["pull"], {
			cwd: PROJECT_ROOT,
			maxBuffer: 1024 * 1024,
		});
		return { ok: true, output: joinCommandOutput(stdout, stderr) };
	} catch (error) {
		const execError = error as Partial<{
			stdout: string | Buffer;
			stderr: string | Buffer;
		}>;
		const output = joinCommandOutput(execError.stdout, execError.stderr);
		return { ok: false, output: output || errorMessage(error) };
	}
}

function joinCommandOutput(
	stdout: string | Buffer | undefined,
	stderr: string | Buffer | undefined,
): string {
	return [stdout, stderr]
		.map((value) => value?.toString().trim() ?? "")
		.filter(Boolean)
		.join("\n");
}

/** Redacts embedded credentials, truncates, and HTML-escapes command output. */
export function formatCommandOutput(output: string): string {
	const redacted = output.replace(/(https?:\/\/)([^@\s]+)@/g, "$1***@");
	const trimmed = redacted.trim() || "(no output)";
	const truncated =
		trimmed.length > 3000 ? `${trimmed.slice(0, 3000)}…` : trimmed;
	return escapeTelegramHtml(truncated);
}
