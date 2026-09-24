import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { SUBAGENT_MAX_CONCURRENT_WORKERS, SUBAGENT_MAX_TASKS_PER_JOB } from '../src/config.ts';
import { jobStopCallbackAction } from '../src/job-stop-action.ts';
import {
  interruptedSubagentsNote,
  runningSubagentOriginFiles,
  type RunWorker,
  setSubagentReportHandler,
  stopAllSubagents,
  SUBAGENT_SESSION_ENTRY_TYPE,
  type SubagentReport,
  subagentExtension,
  subagentReportPrompt,
  type WorkerRunRequest,
} from '../src/subagent.ts';
import { notifySteeringMessage } from '../src/steering-signal.ts';
import type { SessionKind } from '../src/types.ts';

/**
 * The tools are driven against a fake extension API with a fake worker whose
 * completion the test controls, so the yield-then-background choreography, the
 * report, stopping, and the concurrency cap are exercised without a model.
 */

function ctx(
  overrides: { model?: { provider: string; id: string } | null; sessionFile?: string } = {},
): ExtensionContext {
  const known = new Set(['chat-model', 'other']);
  return {
    cwd: '/work',
    model:
      overrides.model === null
        ? undefined
        : (overrides.model ?? { provider: 'test', id: 'chat-model' }),
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === 'test' && known.has(id) ? { provider, id } : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: () => [...known].map((id) => ({ provider: 'test', id })),
    },
    sessionManager: {
      getSessionId: () => 'telegram-chat-1',
      getSessionFile: () => overrides.sessionFile ?? '/sessions/chat.jsonl',
      getLeafId: () => 'leaf-1',
    },
  } as unknown as ExtensionContext;
}

function fakeWorker() {
  const requests: WorkerRunRequest[] = [];
  const pending: Array<{
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  }> = [];
  const run: RunWorker = (request) => {
    requests.push(request);
    const file = `/sub/${request.sessionId}.jsonl`;
    request.onSessionFile?.(file);
    return new Promise((resolve, reject) => {
      pending.push({ resolve: (text) => resolve({ text, sessionFile: file }), reject });
      request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
    });
  };
  return {
    run,
    requests,
    finish(index: number, text: string) {
      pending[index]?.resolve(text);
    },
    fail(index: number, message: string) {
      pending[index]?.reject(new Error(message));
    },
    /** The worker started by the index-th request calls a tool. */
    toolStart(index: number, toolName: string, args: unknown) {
      requests[index]?.onToolStart?.({ toolName, args });
    },
  };
}

interface TelegramCall {
  method: string;
  text: string;
  keyboard?: Array<Array<{ text: string; callback_data: string }>>;
}

type Tools = Map<string, ToolDefinition>;

function setup(t: TestContext, origin: SessionKind = 'chat') {
  const worker = fakeWorker();
  const tools: Tools = new Map();
  const fakePi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  subagentExtension({ origin, runWorker: worker.run })(fakePi);
  const reports: SubagentReport[] = [];
  setSubagentReportHandler(async (report) => {
    reports.push(report);
  });
  // Chat jobs keep a progress message; capture it instead of sending.
  const telegram: TelegramCall[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as {
      text?: string;
      reply_markup?: { inline_keyboard: TelegramCall['keyboard'] };
    };
    telegram.push({
      method: String(url).split('/').pop() ?? '',
      text: payload.text ?? '',
      ...(payload.reply_markup ? { keyboard: payload.reply_markup.inline_keyboard } : {}),
    });
    return Response.json({ ok: true, result: { message_id: telegram.length } });
  });
  t.after(() => stopAllSubagents());

  const call = (name: string, params: unknown, signal?: AbortSignal, context = ctx()) => {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} registered`);
    return tool.execute('call-1', params, signal, undefined, context);
  };
  const text = async (result: Promise<{ content: Array<{ type: string; text?: string }> }>) =>
    (await result).content.map((c) => c.text ?? '').join('\n');
  return { worker, reports, call, text, tools, telegram };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('condition not reached');
}

function jobIdIn(text: string): string {
  const match = /sub_[0-9a-f]+/.exec(text);
  assert.ok(match, `job id in: ${text}`);
  return match[0];
}

test('tasks that finish within the yield are returned inline and the job is forgotten', async (t) => {
  const f = setup(t);
  const result = f.call('subagent_run', {
    tasks: [{ task: 'Count the files in the repo.' }],
    yield_time_ms: 2_000,
  });
  await until(() => f.worker.requests.length === 1);
  const request = f.worker.requests[0];
  assert.equal(request.model, 'test/chat-model');
  assert.equal(request.cwd, path.resolve(process.cwd(), '.'));
  assert.equal(request.parentSession, '/sessions/chat.jsonl');
  assert.equal(request.customType, SUBAGENT_SESSION_ENTRY_TYPE);
  assert.equal(request.metadata.parentLeafId, 'leaf-1');
  assert.equal(request.metadata.toolCallId, 'call-1');
  assert.equal(request.metadata.origin, 'chat');
  assert.match(request.systemPrompt, /Working directory: /);
  assert.match(request.sessionName, /^Count the files/);

  f.worker.finish(0, 'There are 3 files.');
  const resolved = await result;
  const text = resolved.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  assert.match(text, /succeeded \(1\/1 tasks\)/);
  assert.match(text, /There are 3 files\./);
  assert.match(text, /Transcript: \/sub\/telegram-subagent-sub_[0-9a-f]+-1\.jsonl/);
  const details = resolved.details as { jobId: string; tasks: Array<{ sessionFile: string }> };
  assert.equal(details.tasks[0]?.sessionFile, `/sub/${request.sessionId}.jsonl`);

  const read = await f.text(f.call('subagent_read', { job_id: details.jobId }));
  assert.match(read, /Unknown sub-agent job/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.reports.length, 0);
});

test('a job still running after the yield is backgrounded and reports once when done', async (t) => {
  const f = setup(t);
  const started = await f.text(
    f.call('subagent_run', {
      tasks: [{ task: 'first task' }, { task: 'second task' }],
      yield_time_ms: 5,
    }),
  );
  const jobId = jobIdIn(started);
  assert.match(started, /still running after/);
  assert.match(started, /If it should finish within 3m, wait for it with subagent_wait/);
  assert.match(started, /If it may run longer, end your turn now/);
  assert.match(started, /Task 1: running/);

  const running = await f.text(f.call('subagent_read', { job_id: jobId }));
  assert.match(running, /running \(0\/2 tasks done\)/);

  f.worker.finish(1, 'second result');
  f.worker.finish(0, 'first result');
  await until(() => f.reports.length === 1);
  const report = f.reports[0];
  assert.equal(report.jobId, jobId);
  assert.match(report.outcome, /^succeeded \(2\/2 tasks\) after /);
  assert.equal(report.tasks[0]?.output, 'first result');
  assert.equal(report.tasks[1]?.output, 'second result');

  const prompt = subagentReportPrompt(report);
  assert.equal(prompt.source, 'subagent-report');
  assert.equal(prompt.session, 'chat');
  assert.equal(prompt.suppressNoop, true);
  assert.equal(prompt.model, undefined);
  assert.equal(prompt.label, 'first task (+1 more)');
  assert.match(prompt.text, /^\[subagent-report\] Sub-agent job sub_/);
  assert.match(prompt.text, /<subagent_result>\nsecond result\n<\/subagent_result>/);
  assert.match(prompt.text, /__SUBAGENT_NOOP__/);
  assert.equal(prompt.isSuperseded?.(), false, 'a read while running does not count');

  const done = await f.text(f.call('subagent_read', { job_id: jobId }));
  assert.match(done, /### Task 2 — succeeded/);

  // One progress message, sent when the job started and edited to the outcome
  // before the report was delivered.
  assert.deepEqual(
    f.telegram.map((call) => call.method),
    ['sendMessage', 'editMessageText'],
  );
  const [sent, final] = f.telegram;
  assert.match(sent?.text ?? '', /^🤖 <b>Sub-agents<\/b> · 2 running\n\n⏳ <b>1\. first task<\/b>/);
  assert.doesNotMatch(sent?.text ?? '', /sub_[0-9a-f]+/);
  assert.deepEqual(
    sent?.keyboard?.map((line) => line.map((button) => button.text)),
    [['⏹ Stop 1 · first task'], ['⏹ Stop 2 · second task']],
  );
  assert.match(final?.text ?? '', /^🤖 <b>Sub-agents<\/b> · 2 done · ⏱ /);
  assert.match(final?.text ?? '', /<blockquote expandable>second result<\/blockquote>/);
  assert.deepEqual(final?.keyboard, [], 'the final message has no buttons');
  assert.equal(prompt.isSuperseded?.(), true, 'the queued report is no longer needed');
});

test('a report from the background session pins the model it started on', async (t) => {
  const f = setup(t, 'background');
  const started = await f.text(
    f.call('subagent_run', { tasks: [{ task: 'bg task' }], yield_time_ms: 5 }),
  );
  jobIdIn(started);
  f.worker.finish(0, 'ok');
  await until(() => f.reports.length === 1);
  const prompt = subagentReportPrompt(f.reports[0]);
  assert.equal(prompt.session, 'background');
  assert.equal(prompt.model, 'test/chat-model');
  // Unattended runs are not watched, so they get no progress message.
  assert.deepEqual(f.telegram, []);
});

test('a failed worker fails the job and its error is in the report', async (t) => {
  const f = setup(t);
  const started = await f.text(
    f.call('subagent_run', { tasks: [{ task: 'fragile' }], yield_time_ms: 5 }),
  );
  jobIdIn(started);
  f.worker.fail(0, 'boom');
  await until(() => f.reports.length === 1);
  assert.match(f.reports[0].outcome, /^failed \(1 of 1 task failed\)/);
  assert.equal(f.reports[0].tasks[0]?.status, 'failed');
  assert.equal(f.reports[0].tasks[0]?.output, 'Error: boom');
  assert.match(
    f.telegram.at(-1)?.text ?? '',
    /^🤖 <b>Sub-agent<\/b> · failed\n\n❌ <b>1\. fragile<\/b>\nfailed after \d+s\n<i>boom<\/i>$/,
  );
});

test('subagent_stop aborts the workers and sends no report', async (t) => {
  const f = setup(t);
  const started = await f.text(
    f.call('subagent_run', { tasks: [{ task: 'slow' }], yield_time_ms: 5 }),
  );
  const jobId = jobIdIn(started);
  const stopped = await f.text(f.call('subagent_stop', { job_id: jobId }));
  assert.match(stopped, /Stopped job/);
  assert.equal(f.worker.requests[0]?.signal.aborted, true);
  const read = await f.text(f.call('subagent_read', { job_id: jobId }));
  assert.match(read, /stopped/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.reports.length, 0);
  assert.match(await f.text(f.call('subagent_stop', { job_id: jobId })), /not running/);
  // The stop is shown even though no report follows.
  assert.match(
    f.telegram.at(-1)?.text ?? '',
    /^🤖 <b>Sub-agent<\/b> · stopped\n\n⏹ <b>1\. slow<\/b>\nstopped after/,
  );
});

test('aborting the turn during the yield window stops the job', async (t) => {
  const f = setup(t);
  const controller = new AbortController();
  const result = f.call(
    'subagent_run',
    { tasks: [{ task: 'interrupted' }], yield_time_ms: 2_000 },
    controller.signal,
  );
  await until(() => f.worker.requests.length === 1);
  controller.abort();
  const text = await f.text(result);
  assert.match(text, /stopped/);
  assert.equal(f.worker.requests[0]?.signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.reports.length, 0);
});

test('an unknown model is rejected before any worker starts', async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.call('subagent_run', { tasks: [{ task: 'a' }, { task: 'b', model: 'test/nope' }] }),
    /Unknown model test\/nope/,
  );
  assert.equal(f.worker.requests.length, 0);
});

test('a per-task model overrides the turn model, and no model at all is an error', async (t) => {
  const f = setup(t);
  const result = f.call('subagent_run', {
    tasks: [{ task: 'a', model: 'test/other' }],
    yield_time_ms: 2_000,
  });
  await until(() => f.worker.requests.length === 1);
  assert.equal(f.worker.requests[0]?.model, 'test/other');
  f.worker.finish(0, 'ok');
  await result;

  await assert.rejects(
    f.call('subagent_run', { tasks: [{ task: 'a' }] }, undefined, ctx({ model: null })),
    /No chat model is active/,
  );
});

test('workers beyond the concurrency cap wait for a free slot', async (t) => {
  const f = setup(t);
  const tasks = Array.from({ length: SUBAGENT_MAX_TASKS_PER_JOB }, (_, i) => ({ task: `t${i}` }));
  const first = await f.text(f.call('subagent_run', { tasks, yield_time_ms: 5 }));
  const second = await f.text(f.call('subagent_run', { tasks, yield_time_ms: 5 }));
  const expectedRunning = Math.min(SUBAGENT_MAX_CONCURRENT_WORKERS, 2 * SUBAGENT_MAX_TASKS_PER_JOB);
  assert.equal(f.worker.requests.length, expectedRunning);
  assert.match(second, /Task 1: queued/);
  jobIdIn(first);

  f.worker.finish(0, 'done');
  await until(() => f.worker.requests.length === expectedRunning + 1);

  const total = 2 * SUBAGENT_MAX_TASKS_PER_JOB;
  for (let i = 1; i < total; i++) {
    await until(() => f.worker.requests.length > i);
    f.worker.finish(i, 'done');
  }
  await until(() => f.reports.length === 2);
});

test('the interrupted note names running jobs of the given session only', async (t) => {
  const f = setup(t, 'background');
  assert.equal(interruptedSubagentsNote('background'), null);
  const started = await f.text(
    f.call('subagent_run', { tasks: [{ task: 'long research' }], yield_time_ms: 5 }),
  );
  const jobId = jobIdIn(started);
  assert.equal(interruptedSubagentsNote('chat'), null);
  const note = interruptedSubagentsNote('background') ?? '';
  assert.match(note, /1 sub-agent job you started was still running/);
  assert.match(note, new RegExp(`- ${jobId}: long research`));
  assert.match(note, /task 1 \(running\): \/sub\/telegram-subagent-sub_[0-9a-f]+-1\.jsonl/);

  await stopAllSubagents();
  assert.equal(interruptedSubagentsNote('background'), null);
});

test('each background run gets an interrupted note for its own jobs only', async (t) => {
  const f = setup(t, 'background');
  const start = (task: string, sessionFile: string) =>
    f.text(
      f.call(
        'subagent_run',
        { tasks: [{ task }], yield_time_ms: 5 },
        undefined,
        ctx({ sessionFile }),
      ),
    );
  const first = jobIdIn(await start('first run task', '/bg/run-a.jsonl'));
  const second = jobIdIn(await start('second run task', '/bg/run-b.jsonl'));

  assert.deepEqual(runningSubagentOriginFiles('background').sort(), [
    '/bg/run-a.jsonl',
    '/bg/run-b.jsonl',
  ]);
  assert.deepEqual(runningSubagentOriginFiles('chat'), []);
  const noteA = interruptedSubagentsNote('background', '/bg/run-a.jsonl') ?? '';
  assert.match(noteA, new RegExp(`- ${first}: first run task`));
  assert.doesNotMatch(noteA, new RegExp(second));
  assert.equal(interruptedSubagentsNote('background', '/bg/other.jsonl'), null);

  await stopAllSubagents();
  assert.deepEqual(runningSubagentOriginFiles('background'), []);
});

test('the guidance says to end the turn rather than wait out a long job', (t) => {
  const f = setup(t);
  const guidelines = f.tools.get('subagent_run')?.promptGuidelines?.join('\n') ?? '';
  assert.match(guidelines, /may run longer than 3m in total[^\n]*end your turn instead of waiting/);
  assert.match(guidelines, /expected to finish within 3m, call subagent_wait/);
  assert.match(guidelines, /Never wait by polling subagent_read or by sleeping in bash/);
});

test('subagent_wait returns the results as soon as the job finishes, and no report is needed', async (t) => {
  const f = setup(t);
  const jobId = jobIdIn(
    await f.text(f.call('subagent_run', { tasks: [{ task: 'look it up' }], yield_time_ms: 5 })),
  );
  const waiting = f.text(f.call('subagent_wait', { job_id: jobId }));
  setTimeout(() => f.worker.finish(0, 'found it'), 5);
  const result = await waiting;
  assert.match(result, /succeeded \(1\/1 tasks\)/);
  assert.match(result, /found it/);
  await until(() => f.reports.length === 1);
  assert.equal(subagentReportPrompt(f.reports[0]).isSuperseded?.(), true);
});

test('subagent_wait ends early when the user sends a message, leaving the job running', async (t) => {
  const f = setup(t);
  const jobId = jobIdIn(
    await f.text(f.call('subagent_run', { tasks: [{ task: 'slow' }], yield_time_ms: 5 })),
  );
  const waiting = f.text(f.call('subagent_wait', { job_id: jobId }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  notifySteeringMessage('chat');
  const result = await waiting;
  assert.match(
    result,
    /the user sent a message, which follows this result; the job is still running/,
  );
  assert.match(result, /Task 1: running/);
  f.worker.finish(0, 'done later');
  await until(() => f.reports.length === 1);
  assert.equal(subagentReportPrompt(f.reports[0]).isSuperseded?.(), false);
});

/** Taps the Stop button for `taskNumber` on the job's progress message, as Telegram would. */
function tapStop(jobId: string, taskNumber: number): string {
  return jobStopCallbackAction.answer(`${jobId}:${taskNumber}`);
}

test('a stop from Telegram ends that task alone, and the report says the user stopped it', async (t) => {
  const f = setup(t);
  const jobId = jobIdIn(
    await f.text(
      f.call('subagent_run', {
        tasks: [
          { task: 'Map the cron scheduler in detail.', description: 'Map the cron scheduler' },
          { task: 'Survey every module.', description: 'Survey every module' },
          { task: 'Check the tests.' },
        ],
        yield_time_ms: 5,
      }),
    ),
  );
  f.worker.toolStart(1, 'read', { path: 'src/cron.ts' });
  f.worker.toolStart(0, 'bash', { command: 'npm test' });
  f.worker.toolStart(0, 'grep', { pattern: 'cron' });

  assert.equal(tapStop(jobId, 2), 'Stopping sub-agent 2…');
  assert.equal(tapStop(jobId, 2), 'Already stopping…');
  assert.equal(f.worker.requests[1]?.signal.aborted, true);
  assert.equal(f.worker.requests[0]?.signal.aborted, false, 'the other workers carry on');
  assert.equal(f.worker.requests[2]?.signal.aborted, false);

  // The tap refreshes the message at once: the row shows the stop (the fake
  // worker ends the moment it is aborted), its button is gone, and the others
  // show what their workers are doing.
  await until(() => f.telegram.some((call) => call.method === 'editMessageText'));
  const tapped = f.telegram.find((call) => call.method === 'editMessageText');
  assert.match(
    tapped?.text ?? '',
    /⏳ <b>1\. Map the cron scheduler<\/b>\n\d+s · 2 tools\n↳ <i>grep \(cron\)<\/i>/,
  );
  assert.match(
    tapped?.text ?? '',
    /⏹ <b>2\. Survey every module<\/b>\nstopped by you after \d+s · 1 tool/,
  );
  assert.deepEqual(
    tapped?.keyboard?.map((line) => line.map((button) => button.callback_data)),
    [[`stop:${jobId}:1`], [`stop:${jobId}:3`]],
  );

  const running = await f.text(f.call('subagent_read', { job_id: jobId }));
  assert.match(running, /Task 2: stopped by the user, \d+s — Survey every module\./);

  f.worker.finish(0, 'cron result');
  f.worker.finish(2, 'tests result');
  await until(() => f.reports.length === 1);
  const report = f.reports[0];
  assert.ok(report);
  assert.match(report.outcome, /^succeeded \(2\/3 tasks; 1 stopped by the user\) after /);
  assert.equal(report.tasks[1]?.status, 'stopped');
  assert.equal(report.tasks[1]?.stoppedByUser, true);
  assert.equal(report.tasks[1]?.output, 'Stopped by the user from Telegram before it finished.');
  const prompt = subagentReportPrompt(report).text;
  assert.match(prompt, /The user stopped task 2 from Telegram on purpose\. Do not start it again/);

  const final = f.telegram.at(-1);
  assert.match(final?.text ?? '', /🤖 <b>Sub-agents<\/b> · 2 done · 1 stopped · ⏱ /);
  assert.match(
    final?.text ?? '',
    /⏹ <b>2\. Survey every module<\/b>\nstopped by you after \d+s · 1 tool/,
  );
  assert.deepEqual(final?.keyboard, []);
  assert.equal(tapStop(jobId, 1), 'That job is no longer running.');
});

test('a job whose every task the user stopped settles stopped, and still reports', async (t) => {
  const f = setup(t);
  const jobId = jobIdIn(
    await f.text(
      f.call('subagent_run', {
        tasks: [{ task: 'one' }, { task: 'two' }],
        yield_time_ms: 5,
      }),
    ),
  );
  tapStop(jobId, 1);
  tapStop(jobId, 2);
  await until(() => f.reports.length === 1);
  assert.match(f.reports[0]?.outcome ?? '', /^stopped \(every task, by the user\) after /);
  const prompt = subagentReportPrompt(f.reports[0] as SubagentReport).text;
  assert.match(
    prompt,
    /The user stopped every task from Telegram on purpose\. Do not start them again/,
  );
});

test('a failed task and a stopped one are counted apart', async (t) => {
  const f = setup(t);
  const jobId = jobIdIn(
    await f.text(
      f.call('subagent_run', {
        tasks: [{ task: 'fragile' }, { task: 'unwanted' }, { task: 'fine' }],
        yield_time_ms: 5,
      }),
    ),
  );
  tapStop(jobId, 2);
  f.worker.fail(0, 'boom');
  f.worker.finish(2, 'ok');
  await until(() => f.reports.length === 1);
  assert.match(
    f.reports[0]?.outcome ?? '',
    /^failed \(1 of 3 tasks failed, 1 stopped by the user\) after /,
  );
});

test('a queued task stopped from Telegram never starts', async (t) => {
  const f = setup(t);
  const tasks = Array.from({ length: SUBAGENT_MAX_CONCURRENT_WORKERS }, (_, i) => ({
    task: `busy ${i}`,
  }));
  jobIdIn(await f.text(f.call('subagent_run', { tasks, yield_time_ms: 5 })));
  const queuedJob = jobIdIn(
    await f.text(f.call('subagent_run', { tasks: [{ task: 'waiting' }], yield_time_ms: 5 })),
  );
  assert.equal(f.worker.requests.length, SUBAGENT_MAX_CONCURRENT_WORKERS);
  assert.equal(tapStop(queuedJob, 1), 'Stopping sub-agent 1…');
  await until(() => f.reports.length === 1);
  assert.match(f.reports[0]?.outcome ?? '', /^stopped \(by the user\) after /);
  assert.equal(f.reports[0]?.tasks[0]?.runtime, 'not started');

  const final = f.telegram.filter((call) => call.method === 'editMessageText').at(-1);
  assert.match(final?.text ?? '', /⏹ <b>1\. waiting<\/b>\nstopped by you before it started/);

  f.worker.finish(0, 'done');
  await until(() => f.worker.requests.length === SUBAGENT_MAX_CONCURRENT_WORKERS);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    f.worker.requests.length,
    SUBAGENT_MAX_CONCURRENT_WORKERS,
    'the freed slot does not go to the stopped task',
  );
});

test('a stale Stop button says the job is no longer running', async (t) => {
  const f = setup(t);
  assert.equal(tapStop('sub_000000', 1), 'That job is no longer running.');
  const jobId = jobIdIn(
    await f.text(f.call('subagent_run', { tasks: [{ task: 'only one' }], yield_time_ms: 5 })),
  );
  assert.equal(tapStop(jobId, 2), 'That job is no longer running.', 'no such task');
  f.worker.finish(0, 'done');
  await until(() => f.reports.length === 1);
  assert.equal(tapStop(jobId, 1), 'That job is no longer running.');
  assert.equal(jobStopCallbackAction.answer('nonsense'), 'Unknown action.');
});

test('the task description names the worker transcript', async (t) => {
  const f = setup(t);
  const result = f.call('subagent_run', {
    tasks: [{ task: 'A long task text that goes on.', description: 'Short title' }],
    yield_time_ms: 2_000,
  });
  await until(() => f.worker.requests.length === 1);
  assert.equal(f.worker.requests[0]?.sessionName, 'Short title');
  f.worker.finish(0, 'ok');
  await result;
});
