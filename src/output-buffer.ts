import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorMessage } from './util.ts';

/**
 * Incrementally buffers streaming command output with bounded memory.
 *
 * Keeps a rolling decoded tail for snapshots and counts running totals. Once
 * the output outgrows what a snapshot can show, the full raw output is spilled
 * to a temp file so truncated content stays reachable on disk.
 */

const MAX_SNAPSHOT_LINES = 2000;
const MAX_SNAPSHOT_BYTES = 50 * 1024;
const TAIL_KEEP_CHARS = MAX_SNAPSHOT_BYTES * 2;
const TAIL_TRIM_THRESHOLD = MAX_SNAPSHOT_BYTES * 4;

export interface OutputSnapshot {
  /** Tail of the output, bounded to the last MAX_SNAPSHOT_LINES/MAX_SNAPSHOT_BYTES. */
  content: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  /** Path of the spilled full output; set once the output outgrows snapshots. */
  fullOutputPath: string | null;
}

export class BoundedOutputBuffer {
  private readonly tempFilePrefix: string;
  private readonly decoder = new TextDecoder();
  private pendingChunks: Buffer[] = [];
  private tail = '';
  private tailStartsAtLineBoundary = true;
  private completedLines = 0;
  private hasOpenLine = false;
  private totalBytes = 0;
  private finished = false;
  private tempFilePath: string | null = null;
  private tempFileStream: fs.WriteStream | null = null;

  constructor(tempFilePrefix: string) {
    this.tempFilePrefix = tempFilePrefix;
  }

  append(data: Buffer): void {
    if (this.finished || data.length === 0) return;
    this.totalBytes += data.length;
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));
    if (this.tempFileStream || this.outgrowsSnapshot()) {
      this.ensureTempFile();
      this.tempFileStream?.write(data);
    } else {
      this.pendingChunks.push(data);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
    if (this.outgrowsSnapshot()) this.ensureTempFile();
    this.tempFileStream?.end();
    this.tempFileStream = null;
    this.pendingChunks = [];
  }

  snapshot(): OutputSnapshot {
    return {
      content: this.boundedTail(),
      truncated: this.outgrowsSnapshot(),
      totalLines: this.totalLines(),
      totalBytes: this.totalBytes,
      fullOutputPath: this.tempFilePath,
    };
  }

  private totalLines(): number {
    return this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private outgrowsSnapshot(): boolean {
    return this.totalLines() > MAX_SNAPSHOT_LINES || this.totalBytes > MAX_SNAPSHOT_BYTES;
  }

  private appendDecodedText(text: string): void {
    if (!text) return;
    this.tail += text;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
      this.completedLines++;
    }
    this.hasOpenLine = !text.endsWith('\n');
    if (this.tail.length > TAIL_TRIM_THRESHOLD) this.trimTail();
  }

  private trimTail(): void {
    let cut = this.tail.length - TAIL_KEEP_CHARS;
    const code = this.tail.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) cut++; // do not split a surrogate pair
    this.tailStartsAtLineBoundary = this.tail.charCodeAt(cut - 1) === 0x0a;
    this.tail = this.tail.slice(cut);
  }

  private boundedTail(): string {
    let text = this.tail;
    if (!this.tailStartsAtLineBoundary) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline !== -1) text = text.slice(firstNewline + 1);
    }

    const endsWithNewline = text.endsWith('\n');
    const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
    if (lines.length > MAX_SNAPSHOT_LINES) {
      text = lines.slice(-MAX_SNAPSHOT_LINES).join('\n') + (endsWithNewline ? '\n' : '');
    }
    return tailByBytes(text, MAX_SNAPSHOT_BYTES);
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) return;
    this.tempFilePath = path.join(
      os.tmpdir(),
      `${this.tempFilePrefix}-${randomBytes(8).toString('hex')}.log`,
    );
    this.tempFileStream = fs.createWriteStream(this.tempFilePath);
    this.tempFileStream.on('error', (error) => {
      console.error(`Failed writing full output to ${this.tempFilePath}:`, errorMessage(error));
      this.tempFileStream = null;
    });
    for (const chunk of this.pendingChunks) {
      this.tempFileStream.write(chunk);
    }
    this.pendingChunks = [];
  }
}

/** Keeps the last maxBytes of text, preferring to start on a line boundary. */
function tailByBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;

  let start = buf.length - maxBytes;
  const newline = buf.indexOf(0x0a, start);
  if (newline !== -1 && newline + 1 < buf.length) {
    start = newline + 1;
  } else {
    // Single oversized line: cut at a UTF-8 character boundary instead.
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  }
  return buf.subarray(start).toString('utf8');
}
