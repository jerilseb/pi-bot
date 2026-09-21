import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BackgroundBashReport,
  backgroundBashReportPrompt,
  formatReportOutput,
} from '../src/background-bash.ts';
import { BACKGROUND_BASH_REPORT_OUTPUT_MAX_CHARS } from '../src/config.ts';
import type { OutputSnapshot } from '../src/output-buffer.ts';

function report(origin: BackgroundBashReport['origin']): BackgroundBashReport {
  return {
    sessionId: 'bg_abc123',
    command: 'npm test',
    cwd: '/work',
    origin,
    outcome: 'finished with exit code 1 in 3m',
    output: 'FAIL',
  };
}

function snapshot(content: string, overrides: Partial<OutputSnapshot> = {}): OutputSnapshot {
  return {
    content,
    truncated: false,
    totalLines: content.split('\n').length,
    totalBytes: Buffer.byteLength(content),
    fullOutputPath: null,
    ...overrides,
  };
}

test('a report returns to the chat session on whatever model the chat is using', () => {
  const prompt = backgroundBashReportPrompt(report({ session: 'chat', model: 'test/old-chat' }));
  assert.equal(prompt.session, 'chat');
  assert.equal(prompt.source, 'background-bash-report');
  assert.equal(prompt.suppressNoop, true);
  assert.equal(prompt.model, undefined);
  assert.match(prompt.text, /bg_abc123 finished with exit code 1/);
});

test('a report returns to the background session pinned to the model that started it', () => {
  const prompt = backgroundBashReportPrompt(
    report({ session: 'background', model: 'test/job-model' }),
  );
  assert.equal(prompt.session, 'background');
  assert.equal(prompt.model, 'test/job-model');
  assert.equal(prompt.label, 'npm test');
});

test('the report label is the command on one line, cut to fit a note', () => {
  const long = {
    ...report({ session: 'chat' }),
    command: `for i in $(seq 1 200); do\n  echo ${'x'.repeat(120)}\ndone`,
  };
  const label = backgroundBashReportPrompt(long).label ?? '';
  assert.ok(!label.includes('\n'));
  assert.ok(label.length <= 80);
  assert.ok(label.endsWith('…'));
});

test('a background report without a recorded model leaves the model unset', () => {
  const prompt = backgroundBashReportPrompt(report({ session: 'background' }));
  assert.equal(prompt.session, 'background');
  assert.equal(prompt.model, undefined);
});

test('short output is reported whole', () => {
  assert.equal(formatReportOutput(snapshot('line 1\nline 2\n'), 'bg_1'), 'line 1\nline 2');
});

test('empty output is left to the envelope fallback', () => {
  assert.equal(formatReportOutput(snapshot('\n\n'), 'bg_1'), '');
});

test('long output keeps its end, starting on a whole line, and says so first', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(4, '0')} ok`);
  const content = lines.join('\n');
  assert.ok(content.length > BACKGROUND_BASH_REPORT_OUTPUT_MAX_CHARS);

  const result = formatReportOutput(snapshot(content), 'bg_1');
  const [notice, ...shown] = result.split('\n');
  const body = shown.join('\n');

  assert.match(notice, /^\[Truncated for report: showing the last \d+ of \d+ chars\./);
  assert.match(notice, /background_bash_read with session_id "bg_1"/);
  assert.ok(body.length <= BACKGROUND_BASH_REPORT_OUTPUT_MAX_CHARS);
  assert.ok(body.endsWith('line 0399 ok'), 'the end of the output is what the report keeps');
  assert.match(shown[0], /^line \d{4} ok$/, 'the first shown line is whole');
});

test('a single enormous line is clipped rather than dropped', () => {
  const content = 'x'.repeat(BACKGROUND_BASH_REPORT_OUTPUT_MAX_CHARS * 3);
  const result = formatReportOutput(snapshot(content), 'bg_1');
  const body = result.slice(result.indexOf('\n') + 1);
  assert.equal(body.length, BACKGROUND_BASH_REPORT_OUTPUT_MAX_CHARS);
});

test('a buffer that already spilled to disk is announced even when the tail fits', () => {
  const result = formatReportOutput(
    snapshot('tail of output', {
      truncated: true,
      totalLines: 5000,
      totalBytes: 2_000_000,
      fullOutputPath: '/tmp/pi-background-bash-abc.log',
    }),
    'bg_1',
  );
  assert.match(
    result,
    /^\[Truncated for report: 5000 lines, .* in total; full output: \/tmp\/pi-background-bash-abc\.log\./,
  );
  assert.ok(result.endsWith('\ntail of output'));
});

test('a JSON result field is reported on its own', () => {
  const content = JSON.stringify({ result: '  the answer  ', other: 1 });
  assert.equal(formatReportOutput(snapshot(content), 'bg_1'), 'the answer');
});
