import { execFile } from 'node:child_process';
import { PROJECT_ROOT } from './config.ts';

const PRE_RESTART_TIMEOUT_MS = 180_000;
const OUTPUT_TAIL_CHARS = 3500;

export interface PreRestartCheckResult {
  ok: boolean;
  durationMs: number;
  output: string;
}

type ExecFileError = Error & {
  code?: unknown;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  killed?: boolean;
};

export async function runPreRestartChecks(): Promise<PreRestartCheckResult> {
  const startedAt = Date.now();

  try {
    const output = await execFileText('npm', ['run', 'verify'], {
      cwd: PROJECT_ROOT,
      timeout: PRE_RESTART_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      output: tailOutput(output),
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      output: tailOutput(errorOutput(error)),
    };
  }
}

export function formatPreRestartDuration(durationMs: number): string {
  const seconds = Math.max(0.1, durationMs / 1000);
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
}

function execFileText(
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      const output = combineOutput(stdout, stderr);
      if (error) {
        const execError = error as ExecFileError;
        execError.stdout = stdout;
        execError.stderr = stderr;
        reject(execError);
        return;
      }
      resolve(output);
    });
  });
}

function errorOutput(error: unknown): string {
  const execError = error as ExecFileError;
  const output = combineOutput(execError.stdout, execError.stderr);
  const details = [
    execError.message ? `Error: ${execError.message}` : 'Pre-restart checks failed.',
    execError.code === undefined ? '' : `Exit code: ${String(execError.code)}`,
    execError.signal ? `Signal: ${execError.signal}` : '',
    execError.killed ? 'Process was killed, likely due to timeout.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  return [output.trim(), details].filter(Boolean).join('\n\n');
}

function combineOutput(
  stdout: string | Buffer | undefined,
  stderr: string | Buffer | undefined,
): string {
  return [stdout, stderr]
    .map((value) => (value ? value.toString() : ''))
    .filter(Boolean)
    .join('\n');
}

function tailOutput(output: string): string {
  const trimmed = output.trim() || '(no output)';
  if (trimmed.length <= OUTPUT_TAIL_CHARS) return trimmed;
  return `[showing last ${OUTPUT_TAIL_CHARS} characters]\n${trimmed.slice(-OUTPUT_TAIL_CHARS)}`;
}
