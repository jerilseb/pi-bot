import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import { formatFirstToolArgument } from '../tool-call-description.ts';
import { bold, cyan, dim, gray, green, red } from './style.ts';
import {
  editDiff,
  lastLine,
  summarizeTool,
  type ToolOutcome,
  type ToolSummary,
  toolOutput,
} from './tool-summary.ts';

/**
 * A tool call as one row: a mark for where it stands, the tool and its first
 * argument, and what it came to (`● read ~/notes.md · 12 lines`). While it
 * runs, the row ends with the last line its output printed; a failure adds the
 * line saying why under it. /expand opens the whole output (an edit's diff)
 * under the row.
 */

/**
 * Columns kept for the summary, whatever the argument's length: enough for any
 * of Pi's tools' (`lines 1–2000 of 51234`), so only another tool's sentence is
 * cut short, and only past the argument.
 */
const SUMMARY_RESERVE = 24;
/** Columns an argument needs to be worth showing cut short. */
const ARGUMENT_MIN_WIDTH = 8;
const SEPARATOR = ' · ';
const OUTPUT_PREFIX = `  ${dim('⎿')} `;
const OUTPUT_INDENT = '    ';

export class ToolCall implements Component {
  private readonly name: string;
  private args: unknown;
  private running = false;
  private outcome: ToolOutcome | null = null;
  private partial = false;
  private expanded = false;
  private cache: { width: number; lines: string[] } | null = null;

  constructor(name: string, args: unknown) {
    this.name = name;
    this.args = args;
  }

  /** The arguments so far, while the model streams them. */
  updateArgs(args: unknown): void {
    this.args = args;
    this.invalidate();
  }

  start(): void {
    this.running = true;
    this.invalidate();
  }

  /** What it has printed so far while it runs, then its result. */
  updateResult(outcome: ToolOutcome, partial = false): void {
    this.outcome = outcome;
    this.partial = partial;
    if (partial) this.running = true;
    this.invalidate();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.invalidate();
  }

  invalidate(): void {
    this.cache = null;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const inner = Math.max(1, width - 2);
    const done = this.outcome && !this.partial ? this.outcome : null;
    const summary = done ? summarizeTool(this.name, this.args, done) : null;
    const lines = [this.row(inner, summary), ...this.body(inner, summary)].map(
      (line) => ` ${line}`,
    );
    this.cache = { width, lines };
    return lines;
  }

  private row(width: number, summary: ToolSummary | null): string {
    const said = summary
      ? summary.text
      : this.outcome
        ? lastLine(toolOutput(this.outcome.content))
        : '';
    const head = `${this.mark(summary)} ${bold(this.name)}`;
    const wanted = said ? visibleWidth(SEPARATOR) + visibleWidth(said) : 0;
    const room = width - visibleWidth(head) - Math.min(wanted, SUMMARY_RESERVE) - 1;
    const argument = formatFirstToolArgument(this.args);
    const shown =
      argument && room >= Math.min(ARGUMENT_MIN_WIDTH, visibleWidth(argument))
        ? ` ${gray(truncateToWidth(argument, room, '…'))}`
        : '';
    const left = width - visibleWidth(head) - visibleWidth(shown) - visibleWidth(SEPARATOR);
    const tail = said && left > 0 ? dim(`${SEPARATOR}${truncateToWidth(said, left, '…')}`) : '';
    return truncateToWidth(`${head}${shown}${tail}`, width, '…');
  }

  private mark(summary: ToolSummary | null): string {
    if (summary) return this.outcome?.isError ? red('✗') : green('●');
    return this.running ? cyan('○') : gray('○');
  }

  private body(width: number, summary: ToolSummary | null): string[] {
    if (this.expanded && this.outcome) return this.output(width, this.outcome);
    if (summary?.error)
      return [truncateToWidth(`${OUTPUT_PREFIX}${red(summary.error)}`, width, '…')];
    return [];
  }

  /** The whole output under the row, wrapped to fit; an edit's diff in its place. */
  private output(width: number, outcome: ToolOutcome): string[] {
    const diff = this.partial ? null : editDiff(this.name, outcome);
    const text = diff ?? toolOutput(outcome.content);
    if (!text) return [`${OUTPUT_PREFIX}${dim('(no output)')}`];
    const color = outcome.isError ? red : gray;
    const room = Math.max(1, width - visibleWidth(OUTPUT_INDENT));
    return text
      .split('\n')
      .flatMap((line) => {
        const style = diff ? diffColor(line) : color;
        const wrapped = wrapTextWithAnsi(line, room);
        return (wrapped.length ? wrapped : ['']).map((row) => style(row));
      })
      .map((row, index) => `${index === 0 ? OUTPUT_PREFIX : OUTPUT_INDENT}${row}`);
  }
}

function diffColor(line: string): (text: string) => string {
  if (line.startsWith('+')) return green;
  if (line.startsWith('-')) return red;
  return dim;
}
