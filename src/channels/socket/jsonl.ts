import { StringDecoder } from 'node:string_decoder';

/**
 * Strict JSONL framing, as Pi's RPC mode uses it: one JSON value per line,
 * split on LF alone. Not Node's readline, which also splits on the Unicode
 * line separators JSON strings may legitimately contain. JSON.stringify never
 * emits a raw LF, so a record can never be cut by its own content.
 */

/** One record, LF-terminated. */
export function encodeLine(
  value: unknown,
  replacer?: (this: unknown, key: string, value: unknown) => unknown,
): string {
  return `${JSON.stringify(value, replacer)}\n`;
}

export interface JsonlDecoderOptions {
  /** Longest line accepted, in characters; a longer one is an error and the rest is ignored. */
  maxLineLength?: number;
}

/**
 * Turns chunks of a stream into records. A chunk may hold part of a line or
 * several lines, and a multi-byte character may be split between chunks.
 * Each record goes to `onRecord` as parsed JSON; a line that is not JSON, or
 * is too long, goes to `onError`, which should end the connection.
 */
export class JsonlDecoder {
  private readonly text = new StringDecoder('utf8');
  /** The start of the line being received, in pieces, so a long line is not rescanned per chunk. */
  private pending: string[] = [];
  private pendingLength = 0;
  private failed = false;
  private readonly onRecord: (value: unknown) => void;
  private readonly onError: (error: Error) => void;
  private readonly maxLineLength: number;

  constructor(
    onRecord: (value: unknown) => void,
    onError: (error: Error) => void,
    options: JsonlDecoderOptions = {},
  ) {
    this.onRecord = onRecord;
    this.onError = onError;
    this.maxLineLength = options.maxLineLength ?? Number.POSITIVE_INFINITY;
  }

  push(chunk: Buffer | string): void {
    if (this.failed) return;
    let rest = typeof chunk === 'string' ? chunk : this.text.write(chunk);
    let newline = rest.indexOf('\n');
    while (newline !== -1) {
      this.pending.push(rest.slice(0, newline));
      const line = this.pending.join('');
      this.pending = [];
      this.pendingLength = 0;
      rest = rest.slice(newline + 1);
      if (!this.emit(line)) return;
      newline = rest.indexOf('\n');
    }
    if (rest.length === 0) return;
    this.pending.push(rest);
    this.pendingLength += rest.length;
    if (this.pendingLength > this.maxLineLength) this.fail(new Error('line too long'));
  }

  /** The stream ended: a last line without its LF still counts. */
  end(): void {
    if (this.failed) return;
    const line = this.pending.join('') + this.text.end();
    this.pending = [];
    this.pendingLength = 0;
    if (line.trim()) this.emit(line);
  }

  private emit(line: string): boolean {
    if (line.length > this.maxLineLength) {
      this.fail(new Error('line too long'));
      return false;
    }
    // A blank line is no record, and harmless.
    if (!line.trim()) return true;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.fail(new Error('a line is not JSON'));
      return false;
    }
    this.onRecord(value);
    return !this.failed;
  }

  private fail(error: Error): void {
    this.failed = true;
    this.pending = [];
    this.onError(error);
  }
}
