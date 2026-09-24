import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatSubagentProgress,
  type SubagentProgressJob,
  type SubagentProgressTask,
  TOOL_CALLS_SHOWN,
} from '../src/subagent-progress.ts';
import { sanitizeTelegramHtml } from '../src/telegram-html.ts';

/**
 * The live sub-agent message is edited in place for as long as a job runs, so
 * every state it passes through has to stay valid Telegram HTML, fit in one
 * message, and keep each Stop button pointing at its task. By default it stays
 * small (the agent's reply carries the results); with the subagentToolCalls
 * setting it also shows each worker's tool calls, then its result.
 */

function task(
  fields: Partial<SubagentProgressTask> & Pick<SubagentProgressTask, 'index' | 'status'>,
): SubagentProgressTask {
  return {
    task: `Task text ${fields.index + 1}`,
    description: null,
    model: 'test/model',
    stopRequested: false,
    toolCalls: [],
    toolUses: 0,
    result: null,
    error: null,
    startedAt: 0,
    endedAt: null,
    ...fields,
  };
}

function job(
  tasks: SubagentProgressTask[],
  fields: Partial<SubagentProgressJob> = {},
): SubagentProgressJob {
  return { id: 'sub_1a2b3c', status: 'running', startedAt: 0, endedAt: null, tasks, ...fields };
}

/** A job mid-run: two workers busy, one queued, one finished. */
function busyJob(): SubagentProgressJob {
  return job([
    task({
      index: 0,
      description: 'Map the cron scheduler',
      status: 'running',
      toolCalls: ['read (src/cron.ts)', 'grep (schedule)'],
      toolUses: 14,
    }),
    task({
      index: 1,
      task: 'Survey every module\nand report back.',
      status: 'running',
      toolCalls: ['bash (npm test)'],
      toolUses: 1,
    }),
    task({ index: 2, description: 'Check the tests', status: 'queued', startedAt: null }),
    task({
      index: 3,
      description: 'Draft the migration',
      status: 'succeeded',
      startedAt: 10_000,
      endedAt: 55_000,
      toolUses: 7,
      result: '## Plan\n**Steps:** run `migrate` <then> verify & ship',
    }),
  ]);
}

/** A job whose tasks have all ended, one of each way. */
function endedJob(): SubagentProgressJob {
  return job(
    [
      task({
        index: 0,
        description: 'Map the cron scheduler',
        status: 'succeeded',
        toolUses: 3,
        endedAt: 53_000,
        result: 'The scheduler lives in src/cron.ts.',
        toolCalls: ['read (src/cron.ts)'],
      }),
      task({
        index: 1,
        description: 'Trace <cron> & co',
        status: 'failed',
        startedAt: 1_000,
        endedAt: 31_000,
        error: 'API error:\n  overloaded',
      }),
      task({
        index: 2,
        description: 'Check the tests',
        status: 'stopped',
        stopRequested: true,
        startedAt: null,
        endedAt: 5_000,
      }),
      task({ index: 3, description: 'Stopped by the agent', status: 'stopped', endedAt: 9_000 }),
    ],
    { status: 'failed', endedAt: 65_000 },
  );
}

describe('by default', () => {
  test('a running job is one line per task, with numbered Stop buttons and no tool calls', () => {
    const message = formatSubagentProgress(busyJob(), { now: 80_000 });
    assert.equal(
      message.html,
      [
        '🤖 <b>Sub-agents</b> · 1m 20s',
        '⏳ 1. Map the cron scheduler · 14 tools',
        '⏳ 2. Survey every module · 1 tool',
        '⏸ 3. Check the tests',
        '✅ 4. Draft the migration · 45s',
      ].join('\n'),
    );
    // Running and queued tasks can be stopped; a finished one cannot.
    assert.deepEqual(message.keyboard, [
      [
        { text: '⏹ 1', callback_data: 'stop:sub_1a2b3c:1' },
        { text: '⏹ 2', callback_data: 'stop:sub_1a2b3c:2' },
        { text: '⏹ 3', callback_data: 'stop:sub_1a2b3c:3' },
      ],
    ]);
  });

  test('a task with a stop in flight reads stopping and loses its button', () => {
    const message = formatSubagentProgress(
      job([
        task({ index: 0, description: 'Map the cron scheduler', status: 'running', toolUses: 2 }),
        task({
          index: 1,
          description: 'Survey every module',
          status: 'running',
          stopRequested: true,
          toolUses: 5,
        }),
      ]),
      { now: 20_000 },
    );
    assert.equal(
      message.html,
      [
        '🤖 <b>Sub-agents</b> · 20s',
        '⏳ 1. Map the cron scheduler · 2 tools',
        '⏳ 2. Survey every module · stopping…',
      ].join('\n'),
    );
    assert.deepEqual(message.keyboard, [[{ text: '⏹ 1', callback_data: 'stop:sub_1a2b3c:1' }]]);
  });

  test('once every task has ended, the message is a one-line summary with the tasks folded', () => {
    const message = formatSubagentProgress(endedJob(), { now: 70_000 });
    assert.equal(
      message.html,
      [
        '🤖 <b>Sub-agents</b> · 1 done · 1 failed · 2 stopped · ⏱ 1m 5s',
        '<blockquote expandable>✅ 1. Map the cron scheduler · 53s',
        '❌ 2. Trace &lt;cron&gt; &amp; co · failed after 30s',
        '⏹ 3. Check the tests · stopped by you',
        '⏹ 4. Stopped by the agent · stopped</blockquote>',
      ].join('\n'),
    );
    assert.deepEqual(message.keyboard, []);
  });

  test('a task still winding down when the job ended shows as stopped, with no button', () => {
    // subagent_stop or shutdown: the job is terminal before the worker settles.
    const message = formatSubagentProgress(
      job(
        [
          task({ index: 0, status: 'running', toolCalls: ['bash (sleep 60)'] }),
          task({ index: 1, status: 'queued', startedAt: null }),
        ],
        { status: 'stopped', endedAt: 12_000 },
      ),
      { now: 15_000 },
    );
    assert.equal(
      message.html,
      [
        '🤖 <b>Sub-agents</b> · 2 stopped · ⏱ 12s',
        '<blockquote expandable>⏹ 1. Task text 1 · stopped',
        '⏹ 2. Task text 2 · stopped</blockquote>',
      ].join('\n'),
    );
    assert.deepEqual(message.keyboard, []);
  });

  test('a one-task job is one line with a plain Stop button', () => {
    const running = formatSubagentProgress(
      job([
        task({
          index: 0,
          description: 'Compare the two bots',
          status: 'running',
          toolCalls: ['read (src/subagent.ts)'],
          toolUses: 6,
        }),
      ]),
      { now: 42_000 },
    );
    assert.equal(running.html, '⏳ <b>Sub-agent</b> · Compare the two bots · 42s · 6 tools');
    assert.deepEqual(running.keyboard, [[{ text: '⏹ Stop', callback_data: 'stop:sub_1a2b3c:1' }]]);

    const queued = formatSubagentProgress(
      job([task({ index: 0, status: 'queued', startedAt: null })]),
    );
    assert.equal(queued.html, '⏸ <b>Sub-agent</b> · Task text 1 · queued');

    const stopping = formatSubagentProgress(
      job([task({ index: 0, status: 'running', stopRequested: true })]),
    );
    assert.equal(stopping.html, '⏳ <b>Sub-agent</b> · Task text 1 · stopping…');
    assert.deepEqual(stopping.keyboard, []);
  });

  test('a one-task job ends on one line saying how it ended', () => {
    const ended = (fields: Partial<SubagentProgressTask>, status: SubagentProgressJob['status']) =>
      formatSubagentProgress(
        job([task({ index: 0, status: 'succeeded', endedAt: 53_000, ...fields })], {
          status,
          endedAt: 53_000,
        }),
      );
    const done = ended({ toolUses: 12, result: 'All good.' }, 'succeeded');
    assert.equal(done.html, '✅ <b>Sub-agent</b> · Task text 1 · 53s');
    assert.deepEqual(done.keyboard, []);
    assert.equal(
      ended({ status: 'failed', error: 'boom' }, 'failed').html,
      '❌ <b>Sub-agent</b> · Task text 1 · failed after 53s',
    );
    assert.equal(
      ended({ status: 'stopped', stopRequested: true }, 'stopped').html,
      '⏹ <b>Sub-agent</b> · Task text 1 · stopped by you',
    );
  });

  test('buttons wrap four to a line', () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task({ index, status: 'running' }));
    const { keyboard } = formatSubagentProgress(job(tasks), { now: 1_000 });
    assert.deepEqual(
      keyboard.map((line) => line.map((button) => button.text)),
      [
        ['⏹ 1', '⏹ 2', '⏹ 3', '⏹ 4'],
        ['⏹ 5', '⏹ 6'],
      ],
    );
  });

  test('each line names its model only when the tasks run on different ones', () => {
    const same = formatSubagentProgress(
      job([task({ index: 0, status: 'running' }), task({ index: 1, status: 'running' })]),
      { now: 1_000 },
    );
    assert.doesNotMatch(same.html, /<code>/);
    const mixed = formatSubagentProgress(
      job([
        task({ index: 0, status: 'running' }),
        task({ index: 1, status: 'queued', startedAt: null, model: 'openrouter/vendor/other' }),
      ]),
      { now: 1_000 },
    );
    assert.match(mixed.html, /\n⏳ 1\. Task text 1 · <code>model<\/code>\n/);
    assert.match(mixed.html, /\n⏸ 2\. Task text 2 · <code>other<\/code>$/);
  });

  test('titles are clipped after escaping, so a line stays short and well formed', () => {
    const heavy = '<&>'.repeat(400);
    const tasks = Array.from({ length: 4 }, (_, index) =>
      task({ index, description: heavy, status: 'running' }),
    );
    const { html } = formatSubagentProgress(job(tasks), { now: 1_000 });
    assert.ok(html.length < 1_000, `${html.length} chars`);
    assert.equal(sanitizeTelegramHtml(html), html);
    assert.match(html, /\n⏳ 1\. (&lt;|&amp;|&gt;)+…\n/);
  });

  test('a job with more tasks than fit keeps the first lines and says how many were left out', () => {
    const tasks = Array.from({ length: 150 }, (_, index) =>
      task({
        index,
        description: `Task number ${index + 1} with a long enough title`,
        status: 'failed',
        endedAt: 5_000,
      }),
    );
    const { html } = formatSubagentProgress(job(tasks, { status: 'failed', endedAt: 5_000 }));
    assert.ok(html.length <= 3_900, `${html.length} chars`);
    assert.match(html, /<blockquote expandable>❌ 1\. Task number 1 with a long enough title · /);
    assert.match(html, /<i>\+ \d+ more not shown<\/i><\/blockquote>$/);
    assert.equal(sanitizeTelegramHtml(html), html);
  });
});

describe('with tool calls on', () => {
  test('a running task folds its recent tool calls, newest first; a finished one its result', () => {
    const message = formatSubagentProgress(busyJob(), { toolCalls: true, now: 80_000 });
    assert.equal(
      message.html,
      [
        '🤖 <b>Sub-agents</b> · 1m 20s',
        '⏳ 1. Map the cron scheduler · 14 tools',
        '<blockquote expandable>grep (schedule)',
        'read (src/cron.ts)</blockquote>',
        '⏳ 2. Survey every module · 1 tool',
        '<blockquote expandable>bash (npm test)</blockquote>',
        '⏸ 3. Check the tests',
        '✅ 4. Draft the migration · 45s',
        '<blockquote expandable>Plan',
        'Steps: run migrate &lt;then&gt; verify &amp; ship</blockquote>',
      ].join('\n'),
    );
    assert.deepEqual(
      message.keyboard,
      formatSubagentProgress(busyJob(), { now: 80_000 }).keyboard,
      'the setting leaves the buttons alone',
    );
  });

  test('once every task has ended, each keeps its result or error; a stopped one shows none', () => {
    const { html } = formatSubagentProgress(endedJob(), { toolCalls: true, now: 70_000 });
    assert.equal(
      html,
      [
        '🤖 <b>Sub-agents</b> · 1 done · 1 failed · 2 stopped · ⏱ 1m 5s',
        '✅ 1. Map the cron scheduler · 53s',
        '<blockquote expandable>The scheduler lives in src/cron.ts.</blockquote>',
        '❌ 2. Trace &lt;cron&gt; &amp; co · failed after 30s',
        '<blockquote expandable>API error: overloaded</blockquote>',
        '⏹ 3. Check the tests · stopped by you',
        '⏹ 4. Stopped by the agent · stopped',
      ].join('\n'),
    );
  });

  test('a one-task job folds its tool calls under its line, then its result', () => {
    const running = formatSubagentProgress(
      job([
        task({
          index: 0,
          description: 'Compare the two bots',
          status: 'running',
          toolCalls: ['read (a.ts)', 'read (b.ts)'],
          toolUses: 2,
        }),
      ]),
      { toolCalls: true, now: 42_000 },
    );
    assert.equal(
      running.html,
      [
        '⏳ <b>Sub-agent</b> · Compare the two bots · 42s · 2 tools',
        '<blockquote expandable>read (b.ts)',
        'read (a.ts)</blockquote>',
      ].join('\n'),
    );

    const done = formatSubagentProgress(
      job(
        [
          task({
            index: 0,
            description: 'Compare the two bots',
            status: 'succeeded',
            endedAt: 53_000,
            toolCalls: ['read (a.ts)'],
            result: 'They differ in who runs the workers.',
          }),
        ],
        { status: 'succeeded', endedAt: 53_000 },
      ),
      { toolCalls: true },
    );
    assert.equal(
      done.html,
      [
        '✅ <b>Sub-agent</b> · Compare the two bots · 53s',
        '<blockquote expandable>They differ in who runs the workers.</blockquote>',
      ].join('\n'),
    );
  });

  test('only the latest tool calls are shown, each clipped after escaping', () => {
    const calls = Array.from({ length: 20 }, (_, i) => `call ${i + 1} ${'<&>'.repeat(40)}`);
    const { html } = formatSubagentProgress(
      job([task({ index: 0, status: 'running', toolCalls: calls })]),
      { toolCalls: true },
    );
    const shown = /<blockquote expandable>([\s\S]*)<\/blockquote>/.exec(html)?.[1]?.split('\n');
    assert.equal(shown?.length, TOOL_CALLS_SHOWN);
    assert.match(shown?.[0] ?? '', /^call 20 /);
    assert.equal(sanitizeTelegramHtml(html), html);
  });

  test('four huge results share the room and the message stays one well-formed piece', () => {
    const huge = '<b>Result</b> & detail\n'.repeat(700);
    const tasks = Array.from({ length: 4 }, (_, index) =>
      task({ index, status: 'succeeded', endedAt: 10_000, result: huge }),
    );
    const { html } = formatSubagentProgress(job(tasks, { status: 'succeeded', endedAt: 10_000 }), {
      toolCalls: true,
    });
    assert.ok(html.length <= 3_900, `${html.length} chars`);
    assert.equal((html.match(/<blockquote expandable>/g) ?? []).length, 4, 'every result is shown');
    assert.equal(sanitizeTelegramHtml(html), html);
  });

  test('a job too big to show tool calls for falls back to one line per task', () => {
    const tasks = Array.from({ length: 150 }, (_, index) =>
      task({ index, status: 'running', toolCalls: ['bash (npm run build --workspaces)'] }),
    );
    const detailed = formatSubagentProgress(job(tasks), { toolCalls: true, now: 1_000 });
    assert.equal(detailed.html, formatSubagentProgress(job(tasks), { now: 1_000 }).html);
    assert.ok(detailed.html.length <= 3_900);
  });
});
