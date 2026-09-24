import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatSubagentProgress,
  type SubagentProgressJob,
  type SubagentProgressTask,
} from '../src/subagent-progress.ts';
import { sanitizeTelegramHtml } from '../src/telegram-html.ts';

/**
 * The live sub-agent message is edited in place for as long as a job runs, so
 * every state it passes through has to stay valid Telegram HTML, fit in one
 * message, and keep each Stop button pointing at its task.
 */

function task(
  fields: Partial<SubagentProgressTask> & Pick<SubagentProgressTask, 'index' | 'status'>,
): SubagentProgressTask {
  return {
    task: `Task text ${fields.index + 1}`,
    description: null,
    model: 'test/model',
    stopRequested: false,
    activity: null,
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

test('shows what running workers are doing, a queued task, and a finished one’s result', () => {
  const message = formatSubagentProgress(
    job([
      task({
        index: 0,
        description: 'Map the cron scheduler',
        status: 'running',
        activity: 'read (src/cron.ts)',
        toolUses: 14,
      }),
      task({
        index: 1,
        task: 'Survey every module\nand report back.',
        status: 'running',
        startedAt: 2_000,
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
    ]),
    80_000,
  );
  assert.equal(
    message.html,
    [
      '🤖 <b>Sub-agents</b> · 2 running · 1 queued · 1 done',
      '',
      '⏳ <b>1. Map the cron scheduler</b>',
      '1m 20s · 14 tools',
      '↳ <i>read (src/cron.ts)</i>',
      '',
      '⏳ <b>2. Survey every module</b>',
      '1m 18s · 1 tool',
      '↳ <i>starting…</i>',
      '',
      '⏸ <b>3. Check the tests</b>',
      'waiting for a free worker',
      '',
      '✅ <b>4. Draft the migration</b>',
      '45s · 7 tools',
      '<blockquote expandable>Plan\nSteps: run migrate &lt;then&gt; verify &amp; ship</blockquote>',
    ].join('\n'),
  );
  // Running and queued tasks can be stopped; a finished one cannot.
  assert.deepEqual(message.keyboard, [
    [{ text: '⏹ Stop 1 · Map the cron scheduler', callback_data: 'stop:sub_1a2b3c:1' }],
    [{ text: '⏹ Stop 2 · Survey every module', callback_data: 'stop:sub_1a2b3c:2' }],
    [{ text: '⏹ Stop 3 · Check the tests', callback_data: 'stop:sub_1a2b3c:3' }],
  ]);
});

test('more than three stoppable tasks get numbered buttons, three to a line', () => {
  const tasks = Array.from({ length: 4 }, (_, index) => task({ index, status: 'running' }));
  assert.deepEqual(formatSubagentProgress(job(tasks), 1_000).keyboard, [
    [
      { text: '⏹ Stop 1', callback_data: 'stop:sub_1a2b3c:1' },
      { text: '⏹ Stop 2', callback_data: 'stop:sub_1a2b3c:2' },
      { text: '⏹ Stop 3', callback_data: 'stop:sub_1a2b3c:3' },
    ],
    [{ text: '⏹ Stop 4', callback_data: 'stop:sub_1a2b3c:4' }],
  ]);
});

test('a stop in flight reads stopping and loses its button; a lone task gets a singular header', () => {
  const message = formatSubagentProgress(
    job([
      task({
        index: 0,
        description: 'Survey every module',
        status: 'running',
        stopRequested: true,
        activity: 'grep (cron)',
        toolUses: 5,
      }),
    ]),
    20_000,
  );
  assert.equal(
    message.html,
    [
      '🤖 <b>Sub-agent</b> · stopping',
      '',
      '⏳ <b>1. Survey every module</b>',
      '20s · 5 tools · stopping…',
      '↳ <i>grep (cron)</i>',
    ].join('\n'),
  );
  assert.deepEqual(message.keyboard, []);
});

test('up to three stoppable tasks get full-width buttons that name them', () => {
  const message = formatSubagentProgress(
    job([
      task({ index: 0, description: 'Map the cron scheduler and its store', status: 'running' }),
      task({ index: 1, status: 'succeeded', endedAt: 1_000, result: 'ok' }),
      task({ index: 2, description: 'Check the tests', status: 'queued', startedAt: null }),
    ]),
    5_000,
  );
  assert.deepEqual(message.keyboard, [
    [{ text: '⏹ Stop 1 · Map the cron scheduler and…', callback_data: 'stop:sub_1a2b3c:1' }],
    [{ text: '⏹ Stop 3 · Check the tests', callback_data: 'stop:sub_1a2b3c:3' }],
  ]);
});

test('totals the time once every task has ended, and says how each one ended', () => {
  const message = formatSubagentProgress(
    job(
      [
        task({
          index: 0,
          description: 'Map the cron scheduler',
          status: 'stopped',
          stopRequested: true,
          toolUses: 3,
          endedAt: 20_000,
        }),
        task({
          index: 1,
          description: 'Trace <cron> & co',
          status: 'failed',
          toolUses: 1,
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
    ),
    70_000,
  );
  assert.equal(
    message.html,
    [
      '🤖 <b>Sub-agents</b> · 1 failed · 3 stopped · ⏱ 1m 5s',
      '',
      '⏹ <b>1. Map the cron scheduler</b>',
      'stopped by you after 20s · 3 tools',
      '',
      '❌ <b>2. Trace &lt;cron&gt; &amp; co</b>',
      'failed after 30s · 1 tool',
      '<i>API error: overloaded</i>',
      '',
      '⏹ <b>3. Check the tests</b>',
      'stopped by you before it started',
      '',
      '⏹ <b>4. Stopped by the agent</b>',
      'stopped after 9s',
    ].join('\n'),
  );
  assert.deepEqual(message.keyboard, []);
});

test('a task still winding down when the job ended shows as stopped, with no button', () => {
  // subagent_stop or shutdown: the job is terminal before the worker settles.
  const message = formatSubagentProgress(
    job(
      [
        task({ index: 0, status: 'running', activity: 'bash (sleep 60)' }),
        task({ index: 1, status: 'queued', startedAt: null }),
      ],
      { status: 'stopped', endedAt: 12_000 },
    ),
    15_000,
  );
  assert.equal(
    message.html,
    [
      '🤖 <b>Sub-agents</b> · 2 stopped · ⏱ 12s',
      '',
      '⏹ <b>1. Task text 1</b>',
      'stopped after 12s',
      '',
      '⏹ <b>2. Task text 2</b>',
      'stopped before it started',
    ].join('\n'),
  );
  assert.deepEqual(message.keyboard, []);
});

test('each row names its model only when the tasks run on different ones', () => {
  const same = formatSubagentProgress(
    job([task({ index: 0, status: 'running' }), task({ index: 1, status: 'running' })]),
    1_000,
  );
  assert.doesNotMatch(same.html, /<code>/);
  const mixed = formatSubagentProgress(
    job([
      task({ index: 0, status: 'running' }),
      task({ index: 1, status: 'queued', startedAt: null, model: 'openrouter/other' }),
    ]),
    1_000,
  );
  assert.match(mixed.html, /<b>1\. Task text 1<\/b>\n<code>test\/model<\/code> · 1s\n/);
  assert.match(
    mixed.html,
    /<b>2\. Task text 2<\/b>\n<code>openrouter\/other<\/code> · waiting for a free worker/,
  );
});

test('four huge results share the room and the message stays one well-formed piece', () => {
  const huge = `${'<b>Result</b> & detail\n'.repeat(700)}`;
  const tasks = Array.from({ length: 4 }, (_, index) =>
    task({ index, status: 'succeeded', endedAt: 10_000, result: huge }),
  );
  const { html } = formatSubagentProgress(job(tasks, { status: 'succeeded', endedAt: 10_000 }));
  assert.ok(html.length <= 3_900, `${html.length} chars`);
  assert.equal((html.match(/<blockquote expandable>/g) ?? []).length, 4, 'every result is shown');
  assert.equal(sanitizeTelegramHtml(html), html, 'balanced tags, whole entities');
});

test('titles, activity and errors are clipped after escaping, so no row can overflow', () => {
  const heavy = '<&>'.repeat(400);
  const tasks = Array.from({ length: 4 }, (_, index) =>
    task({ index, description: heavy, status: 'running', activity: heavy, error: heavy }),
  );
  const { html } = formatSubagentProgress(job(tasks), 1_000);
  assert.ok(html.length <= 3_900, `${html.length} chars`);
  assert.equal(sanitizeTelegramHtml(html), html);
  assert.match(html, /<b>1\. (&lt;|&amp;|&gt;)+…<\/b>/);
});

test('a job too large for full rows falls back to one line per task', () => {
  const tasks = Array.from({ length: 100 }, (_, index) =>
    task({
      index,
      description: `Task number ${index + 1} with a long enough title`,
      status: 'failed',
      endedAt: 5_000,
      error: 'x'.repeat(200),
    }),
  );
  const { html } = formatSubagentProgress(job(tasks, { status: 'failed', endedAt: 5_000 }));
  assert.ok(html.length <= 3_900, `${html.length} chars`);
  assert.match(html, /\n❌ <b>1\.<\/b> Task number 1 with a long enoug… · 5s\n/);
  assert.match(html, /<i>\+ \d+ more not shown<\/i>$/);
  assert.equal(sanitizeTelegramHtml(html), html);
});
