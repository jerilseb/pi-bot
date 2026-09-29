import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { imageFallback, stripTerminalSequences } from '@earendil-works/pi-tui';

/**
 * What a tool call came to, in a few words, for the one row the terminal gives
 * it: `412 lines` for a read, `6 matches` for a grep, `exit 1` for a command
 * that failed. Pi's own tools are summarised from the shape of their results,
 * and the web tools by how many lines they returned; any other tool by the
 * first line of its output, which the bot's tools write as a sentence saying
 * what happened. Plain text: the row styles it.
 */

export interface ToolOutcome {
  content: Array<TextContent | ImageContent>;
  details?: unknown;
  isError: boolean;
}

export interface ToolSummary {
  /** Shown after the call on its row; empty for nothing. */
  text: string;
  /** Why a failed call failed, for the line under its row. */
  error?: string;
}

/** A tool's output as the terminal prints it: no terminal sequences, carriage returns or tabs. */
export function toolOutput(content: Array<TextContent | ImageContent>): string {
  return content
    .map((part) =>
      part.type === 'text'
        ? stripTerminalSequences(part.text).replace(/\r/g, '').replace(/\t/g, '   ')
        : imageFallback(part.mimeType),
    )
    .join('\n')
    .replace(/^\n+/, '')
    .trimEnd();
}

export function summarizeTool(name: string, args: unknown, outcome: ToolOutcome): ToolSummary {
  const output = toolOutput(outcome.content);
  if (outcome.isError) return name === 'bash' ? bashFailure(output) : failure(output);
  switch (name) {
    case 'read':
      if (outcome.content.some((part) => part.type === 'image')) return { text: 'image' };
      return { text: readSummary(output, args) };
    case 'bash': {
      const total = /\[Showing lines \d+-\d+ of (\d+)[.\s(]/.exec(output)?.[1];
      const lines = total ? Number(total) : lineCount(withoutNotice(output));
      return { text: lines ? plural(lines, 'line') : 'no output' };
    }
    case 'edit': {
      const diff = editDiff(name, outcome);
      if (!diff) break;
      const rows = diff.split('\n');
      const added = rows.filter((row) => row.startsWith('+')).length;
      const removed = rows.filter((row) => row.startsWith('-')).length;
      return { text: `+${added} −${removed}` };
    }
    case 'write': {
      const content = field(args, 'content');
      if (typeof content === 'string') return { text: plural(lineCount(content), 'line') };
      break;
    }
    case 'grep': {
      if (output === 'No matches found') return { text: 'no matches' };
      const matches = rows(withoutNotice(output)).filter((row) => /^.+?:\d+: /.test(row)).length;
      return {
        text: plural(matches, 'match', 'matches', limitReached(outcome, 'matchLimitReached')),
      };
    }
    case 'find': {
      if (output === 'No files found matching pattern') return { text: 'no files' };
      const files = rows(withoutNotice(output)).filter(Boolean).length;
      return { text: plural(files, 'file', 'files', limitReached(outcome, 'resultLimitReached')) };
    }
    case 'ls': {
      if (output === '(empty directory)') return { text: 'empty' };
      const entries = rows(withoutNotice(output)).filter(Boolean).length;
      return {
        text: plural(entries, 'entry', 'entries', limitReached(outcome, 'entryLimitReached')),
      };
    }
    case 'web_search':
      return { text: webLines(output) };
    case 'web_fetch':
      if (/\n\n\[Binary content\b/.test(output)) return { text: 'binary' };
      // The page, after the status and content type the tool heads it with.
      return { text: webLines(output.replace(/^HTTP [^\n]*\nContent-Type: [^\n]*\n*/, '')) };
  }
  return { text: firstLine(output) };
}

/**
 * How many lines a web tool (extensions/) returned: all of them, which its
 * notice gives when it cut the output short.
 */
function webLines(output: string): string {
  const total = /\[Output truncated: showing \d+ of (\d+) lines\b/.exec(output)?.[1];
  const lines = total ? Number(total) : lineCount(withoutNotice(output));
  return lines ? plural(lines, 'line') : 'no output';
}

/** An edit's diff as Pi's edit tool reports it, for /expand to show in place of its output. */
export function editDiff(name: string, outcome: ToolOutcome): string | null {
  if (name !== 'edit' || outcome.isError) return null;
  const diff = field(outcome.details, 'diff');
  return typeof diff === 'string' && diff.trim() ? diff.trimEnd() : null;
}

/** The last line with something on it: what a command running now last printed. */
export function lastLine(text: string): string {
  return (
    rows(text)
      .map((row) => row.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  );
}

function firstLine(text: string): string {
  return (
    rows(text)
      .find((row) => row.trim())
      ?.trim() ?? ''
  );
}

/** A call that failed: said in its error line, or on its row when there is nothing more to say. */
function failure(output: string): ToolSummary {
  if (output === 'Operation aborted') return { text: 'aborted' };
  const error = firstLine(output);
  return error ? { text: '', error } : { text: 'failed' };
}

/**
 * A command that failed, which Pi's bash tool reports as its output and then
 * its status (`Command exited with code 1`): the status on the row, the last
 * line it printed under it.
 */
function bashFailure(output: string): ToolSummary {
  const lines = rows(output);
  const status = lines.at(-1) ?? '';
  const code = /^Command exited with code (\d+)$/.exec(status)?.[1];
  const timeout = /^Command timed out after (\d+) seconds$/.exec(status)?.[1];
  let text: string;
  if (code) text = `exit ${code}`;
  else if (timeout) text = `timed out after ${timeout}s`;
  else if (status === 'Command aborted') text = 'aborted';
  else if (status === 'Command terminated without an exit code') text = 'killed';
  else return failure(output);
  const error = lastLine(withoutNotice(lines.slice(0, -1).join('\n').trimEnd()));
  return error ? { text, error } : { text };
}

function readSummary(output: string, args: unknown): string {
  const range = /\[Showing lines (\d+)-(\d+) of (\d+)[.\s(]/.exec(output);
  if (range) return `lines ${range[1]}–${range[2]} of ${range[3]}`;
  const shown = lineCount(withoutNotice(output));
  const more = /\[(\d+) more lines in file\./.exec(output)?.[1];
  if (!more) return plural(shown, 'line');
  const offset = field(args, 'offset');
  const start = typeof offset === 'number' && offset > 0 ? offset : 1;
  const end = start + shown - 1;
  return `lines ${start}–${end} of ${end + Number(more)}`;
}

/** The output without the bracketed notice Pi's tools end it with when they cut it short. */
function withoutNotice(output: string): string {
  return output.replace(/\n\n\[[^\n]*\]$/, '');
}

function rows(text: string): string[] {
  return text ? text.split('\n') : [];
}

function lineCount(text: string): number {
  return text ? text.replace(/\n$/, '').split('\n').length : 0;
}

function plural(count: number, one: string, many = `${one}s`, orMore = false): string {
  return `${count}${orMore ? '+' : ''} ${count === 1 && !orMore ? one : many}`;
}

function limitReached(outcome: ToolOutcome, key: string): boolean {
  return typeof field(outcome.details, key) === 'number';
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
