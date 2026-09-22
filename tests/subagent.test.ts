import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { SUBAGENT_MAX_CONCURRENT_WORKERS, SUBAGENT_MAX_TASKS_PER_JOB } from '../src/config.ts';
import {
  interruptedSubagentsNote,
  type RunWorker,
  setSubagentReportHandler,
  stopAllSubagents,
  SUBAGENT_SESSION_ENTRY_TYPE,
  type SubagentReport,
  subagentExtension,
  subagentReportPrompt,
  type WorkerRunRequest,
} from '../src/subagent.ts';
import type { SessionKind } from '../src/types.ts';

/**
 * The tools are driven against a fake extension API with a fake worker whose
 * completion the test controls, so the yield-then-background choreography, the
 * report, stopping, and the concurrency cap are exercised without a model.
 */

function ctx(
  overrides: { model?: { provider: string; id: string } | null } = {},
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
      getSessionFile: () => '/sessions/chat.jsonl',
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
  };
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
  // Backgrounded chat jobs keep a progress message; capture it instead of sending.
  const telegram: Array<{ method: string; text: string }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
    telegram.push({ method: String(url).split('/').pop() ?? '', text: payload.text ?? '' });
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

  // One progress message, sent when the job was backgrounded and edited to the
  // outcome before the report was delivered.
  assert.deepEqual(
    f.telegram.map((call) => call.method),
    ['sendMessage', 'editMessageText'],
  );
  assert.match(f.telegram[0]?.text ?? '', /^⏳ <b>Sub-agents<\/b> · running \(0\/2 tasks done\)/);
  assert.match(f.telegram[0]?.text ?? '', /<code>first task \(\+1 more\)<\/code>/);
  assert.match(f.telegram[1]?.text ?? '', /^✅ <b>Sub-agents<\/b> · succeeded \(2\/2 tasks\)/);
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
    /^❌ <b>Sub-agents<\/b> · failed \(1 of 1 task failed\)/,
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
  assert.match(f.telegram.at(-1)?.text ?? '', /^⏹ <b>Sub-agents<\/b> · stopped/);
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
