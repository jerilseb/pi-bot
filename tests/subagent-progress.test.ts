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
 * every state it passes through has to stay valid Telegram HTML, stay small
 * (the agent's reply carries the results), and keep each Stop button pointing
 * at its task.
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
    activityAt: null,
    toolUses: 0,
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

test('a running job is one line per task, the latest tool call, and numbered Stop buttons', () => {
  const message = formatSubagentProgress(
    job([
      task({
        index: 0,
        description: 'Map the cron scheduler',
        status: 'running',
        activity: 'read (src/cron.ts)',
        activityAt: 79_000,
        toolUses: 14,
      }),
      task({
        index: 1,
        task: 'Survey every module\nand report back.',
        status: 'running',
        activity: 'bash (npm test)',
        activityAt: 78_000,
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
      }),
    ]),
    80_000,
  );
  assert.equal(
    message.html,
    [
      '🤖 <b>Sub-agents</b> · 1m 20s',
      '⏳ 1. Map the cron scheduler · 14 tools',
      '⏳ 2. Survey every module · 1 tool',
      '⏸ 3. Check the tests',
      '✅ 4. Draft the migration · 45s',
      '<i>↳ 1: read (src/cron.ts)</i>',
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

test('a task with a stop in flight reads stopping, loses its button, and is not the latest activity', () => {
  const message = formatSubagentProgress(
    job([
      task({
        index: 0,
        description: 'Map the cron scheduler',
        status: 'running',
        activity: 'grep (cron)',
        activityAt: 10_000,
        toolUses: 2,
      }),
      task({
        index: 1,
        description: 'Survey every module',
        status: 'running',
        stopRequested: true,
        activity: 'read (a.ts)',
        activityAt: 19_000,
        toolUses: 5,
      }),
    ]),
    20_000,
  );
  assert.equal(
    message.html,
    [
      '🤖 <b>Sub-agents</b> · 20s',
      '⏳ 1. Map the cron scheduler · 2 tools',
      '⏳ 2. Survey every module · stopping…',
      '<i>↳ 1: grep (cron)</i>',
    ].join('\n'),
  );
  assert.deepEqual(message.keyboard, [[{ text: '⏹ 1', callback_data: 'stop:sub_1a2b3c:1' }]]);
});

test('no activity line until a running worker has called a tool', () => {
  const { html } = formatSubagentProgress(
    job([task({ index: 0, status: 'running' }), task({ index: 1, status: 'running' })]),
    3_000,
  );
  assert.equal(
    html,
    ['🤖 <b>Sub-agents</b> · 3s', '⏳ 1. Task text 1', '⏳ 2. Task text 2'].join('\n'),
  );
});

test('once every task has ended, the message is a one-line summary with the tasks folded', () => {
  const message = formatSubagentProgress(
    job(
      [
        task({
          index: 0,
          description: 'Map the cron scheduler',
          status: 'succeeded',
          toolUses: 3,
          endedAt: 53_000,
        }),
        task({
          index: 1,
          description: 'Trace <cron> & co',
          status: 'failed',
          startedAt: 1_000,
          endedAt: 31_000,
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
        task({ index: 0, status: 'running', activity: 'bash (sleep 60)', activityAt: 1_000 }),
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
        activity: 'read (src/subagent.ts)',
        activityAt: 40_000,
        toolUses: 6,
      }),
    ]),
    42_000,
  );
  assert.equal(
    running.html,
    [
      '⏳ <b>Sub-agent</b> · Compare the two bots · 42s · 6 tools',
      '<i>↳ read (src/subagent.ts)</i>',
    ].join('\n'),
  );
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
  const done = ended({ toolUses: 12 }, 'succeeded');
  assert.equal(done.html, '✅ <b>Sub-agent</b> · Task text 1 · 53s');
  assert.deepEqual(done.keyboard, []);
  assert.equal(
    ended({ status: 'failed' }, 'failed').html,
    '❌ <b>Sub-agent</b> · Task text 1 · failed after 53s',
  );
  assert.equal(
    ended({ status: 'stopped', stopRequested: true }, 'stopped').html,
    '⏹ <b>Sub-agent</b> · Task text 1 · stopped by you',
  );
});

test('buttons wrap four to a line', () => {
  const tasks = Array.from({ length: 6 }, (_, index) => task({ index, status: 'running' }));
  const { keyboard } = formatSubagentProgress(job(tasks), 1_000);
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
    1_000,
  );
  assert.doesNotMatch(same.html, /<code>/);
  const mixed = formatSubagentProgress(
    job([
      task({ index: 0, status: 'running' }),
      task({ index: 1, status: 'queued', startedAt: null, model: 'openrouter/vendor/other' }),
    ]),
    1_000,
  );
  assert.match(mixed.html, /\n⏳ 1\. Task text 1 · <code>model<\/code>\n/);
  assert.match(mixed.html, /\n⏸ 2\. Task text 2 · <code>other<\/code>$/);
});

test('titles and activity are clipped after escaping, so a line stays short and well formed', () => {
  const heavy = '<&>'.repeat(400);
  const tasks = Array.from({ length: 4 }, (_, index) =>
    task({ index, description: heavy, status: 'running', activity: heavy, activityAt: index }),
  );
  const { html } = formatSubagentProgress(job(tasks), 1_000);
  assert.ok(html.length < 1_000, `${html.length} chars`);
  assert.equal(sanitizeTelegramHtml(html), html);
  assert.match(html, /\n⏳ 1\. (&lt;|&amp;|&gt;)+…\n/);
  assert.match(html, /<i>↳ 4: (&lt;|&amp;|&gt;)+…<\/i>$/);
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
