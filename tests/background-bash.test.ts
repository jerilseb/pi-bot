import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  type BackgroundBashReport,
  backgroundBashExtension,
  backgroundBashReportPrompt,
  formatBackgroundBashProgress,
  formatReportOutput,
} from '../src/background-bash.ts';
import { BACKGROUND_BASH_REPORT_OUTPUT_MAX_CHARS } from '../src/config.ts';
import type { OutputSnapshot } from '../src/output-buffer.ts';

function report(
  origin: BackgroundBashReport['origin'],
  overrides: Partial<BackgroundBashReport> = {},
): BackgroundBashReport {
  return {
    sessionId: 'bg_abc123',
    command: 'npm test',
    cwd: '/work',
    origin,
    outcome: 'finished with exit code 1 in 3m',
    output: 'FAIL',
    stoppedByUser: false,
    ...overrides,
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
  assert.deepEqual(prompt.origin, { kind: 'job-report', source: 'background-bash-report' });
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

function progress(overrides: Partial<Parameters<typeof formatBackgroundBashProgress>[0]>) {
  return formatBackgroundBashProgress({
    id: 'bg_abc123',
    command: 'uv pip install\n  "vllm==0.16.0"',
    status: 'running',
    exitCode: null,
    statusDetail: null,
    startedAt: Date.now() - 372_000,
    endedAt: null,
    stopRequested: false,
    output: { lastLine: () => 'Downloading vllm (484.8MiB)' },
    ...overrides,
  });
}

function progressSession(overrides: Partial<Parameters<typeof formatBackgroundBashProgress>[0]>) {
  return progress(overrides).html;
}

test('the progress message shows status, runtime, the command in an expandable quote, and the latest output', () => {
  const html = progressSession({});
  const lines = html.split('\n');
  assert.equal(lines[0], '⏳ <b>Background bash</b> · running · 6m 12s');
  // No job ID: the command is what the user recognises, and the agent tracks IDs itself.
  // Line breaks are kept so a multi-line script reads as written once expanded.
  assert.equal(
    lines.slice(1, 3).join('\n'),
    '<blockquote expandable><code>uv pip install\n  "vllm==0.16.0"</code></blockquote>',
  );
  assert.equal(lines[3], '<i>Downloading vllm (484.8MiB)</i>');
});

test('the command in the progress message is escaped, and capped after escaping', () => {
  const escaped = progressSession({ command: 'echo "<a>" && ls' });
  assert.match(escaped, /<code>echo "&lt;a&gt;" &amp;&amp; ls<\/code>/);
  const long = progressSession({ command: 'x'.repeat(10_000) });
  assert.ok(long.length <= 3_900);
  assert.match(long, /x…<\/code><\/blockquote>/);
  // Every `<` grows to four characters once escaped: a cap on the raw command
  // would let this one split the message and strand its Stop button.
  const angled = progressSession({
    command: '<'.repeat(3_000),
    output: { lastLine: () => '&'.repeat(500) },
  });
  assert.ok(angled.length <= 3_900, `${angled.length} chars`);
  assert.match(angled, /(&lt;)+…<\/code><\/blockquote>/, 'no entity is cut in half');
});

test('a running command has a Stop button, and none once a stop is on its way or it has ended', () => {
  assert.deepEqual(progress({}).keyboard, [[{ text: '⏹ Stop', callback_data: 'stop:bg_abc123' }]]);

  const stopping = progress({ stopRequested: true });
  assert.deepEqual(stopping.keyboard, []);
  assert.match(stopping.html, /^⏳ <b>Background bash<\/b> · stopping… · 6m 12s/);

  const ended = { startedAt: 0, endedAt: 67_000 };
  const stoppedByYou = progress({
    ...ended,
    status: 'stopped',
    stopRequested: true,
    statusDetail: 'stopped by the user from Telegram',
  });
  assert.deepEqual(stoppedByYou.keyboard, []);
  assert.match(stoppedByYou.html, /^⏹ <b>Background bash<\/b> · stopped by you · 1m 7s/);
  assert.deepEqual(progress({ ...ended, status: 'exited', exitCode: 0 }).keyboard, []);
});

test('the progress message ends on the outcome', () => {
  const ended = { startedAt: 0, endedAt: 663_000 };
  assert.match(
    progressSession({ ...ended, status: 'exited', exitCode: 0 }),
    /^✅ <b>Background bash<\/b> · exited with code 0 · 11m 3s/,
  );
  assert.match(progressSession({ ...ended, status: 'exited', exitCode: 2 }), /^❌ .* code 2/);
  assert.match(progressSession({ ...ended, status: 'stopped' }), /^⏹ .* stopped/);
  assert.match(
    progressSession({ ...ended, status: 'failed', statusDetail: 'spawn failed' }),
    /^❌ .* failed \(spawn failed\)/,
  );
});

test('output in the progress message is escaped, and absent until there is some', () => {
  const html = progressSession({ output: { lastLine: () => '<b>1 < 2</b> & more' } });
  assert.match(html, /<i>&lt;b&gt;1 &lt; 2&lt;\/b&gt; &amp; more<\/i>$/);
  assert.doesNotMatch(progressSession({ output: { lastLine: () => '' } }), /<i>/);
});

test('a report of a command the user stopped says so, and not to start it again', () => {
  const stopped = backgroundBashReportPrompt(
    report(
      { session: 'chat' },
      { outcome: 'stopped by the user from Telegram after 2m 3s', stoppedByUser: true },
    ),
  ).text;
  assert.match(
    stopped,
    /^\[background-bash-report\] Background bash bg_abc123 stopped by the user/,
  );
  assert.match(stopped, /The user stopped this command from Telegram on purpose\./);
  assert.match(stopped, /Do not start it again unless they ask/);
  assert.match(stopped, /__BACKGROUND_BASH_NOOP__/);

  const finished = backgroundBashReportPrompt(report({ session: 'chat' })).text;
  assert.doesNotMatch(finished, /stopped this command/);
});

test('the guidance says to end the turn rather than wait out a long command', () => {
  const tools = new Map<string, ToolDefinition>();
  backgroundBashExtension('chat')({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI);
  const guidelines = tools.get('background_bash_start')?.promptGuidelines?.join('\n') ?? '';
  assert.match(guidelines, /may run longer than 3m in total[^\n]*end your turn instead of waiting/);
  assert.match(guidelines, /expected to finish within 3m, call background_bash_wait/);
  assert.match(guidelines, /Never wait by polling background_bash_read or by sleeping in bash/);
  assert.match(
    tools.get('background_bash_read')?.description ?? '',
    /to wait for the command, use background_bash_wait/,
  );
});
