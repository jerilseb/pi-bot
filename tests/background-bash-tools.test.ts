import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  backgroundBashExtension,
  backgroundBashReportPrompt,
  type BackgroundBashReport,
  setBackgroundBashReportHandler,
  stopAllBackgroundSessions,
  stopBackgroundBashByUser,
} from '../src/background-bash.ts';
import { jobStopCallbackAction } from '../src/channels/telegram/job-stop-action.ts';
import { TelegramJobProgress } from '../src/channels/telegram/jobs.ts';
import { setJobEventSink } from '../src/job-registry.ts';

const stopAction = jobStopCallbackAction(async (jobId) => stopBackgroundBashByUser(jobId));

interface TelegramCall {
  method: string;
  text: string;
  keyboard?: Array<Array<{ text: string; callback_data: string }>>;
}

/**
 * background_bash_wait and background_bash_read against real, short shell
 * commands: what they return and when is the contract the agent relies on, and
 * it depends on the command actually streaming output. The commands only echo
 * and sleep.
 */

function setup(t: TestContext) {
  const tools = new Map<string, ToolDefinition>();
  backgroundBashExtension('chat')({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI);
  const reports: BackgroundBashReport[] = [];
  setBackgroundBashReportHandler(async (report) => {
    reports.push(report);
  });
  // Chat jobs announce their progress; Telegram's renderer turns it into a
  // message, captured here instead of sent.
  const progress = new TelegramJobProgress({ subagentToolCalls: () => false });
  setJobEventSink((event) => void progress.onJob(event));
  t.after(() => setJobEventSink(null));
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
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  t.after(() => stopAllBackgroundSessions());
  const ctx = { model: undefined } as unknown as ExtensionContext;
  const call = async (name: string, params: unknown): Promise<string> => {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} registered`);
    const result = await tool.execute('call-1', params, undefined, undefined, ctx);
    return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  };
  const start = async (command: string): Promise<string> => {
    const started = await call('background_bash_start', { command, yield_time_ms: 0 });
    const id = /bg_[0-9a-f]+/.exec(started)?.[0];
    assert.ok(id, `session id in: ${started}`);
    return id;
  };
  /** Taps the Stop button the progress message was first sent with. */
  const tapStop = (): Promise<string> => {
    const data = telegram.find((c) => c.method === 'sendMessage')?.keyboard?.[0]?.[0]
      ?.callback_data;
    assert.ok(data, 'the progress message has a Stop button');
    return Promise.resolve(stopAction.answer(data.slice(stopAction.prefix.length)));
  };
  return { call, start, reports, telegram, tapStop };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition not reached');
}

test('a wait returns when the command finishes, with the output and no report to follow', async (t) => {
  const f = setup(t);
  const id = await f.start('sleep 0.2; echo built');
  const result = await f.call('background_bash_wait', { session_id: id });
  assert.match(result, new RegExp(`^Session ${id}: finished\\.`));
  assert.match(result, /exited with code 0/);
  assert.match(result, /New output since you last saw it:\nbuilt$/);
  await until(() => f.reports.length === 1);
  assert.equal(backgroundBashReportPrompt(f.reports[0]).isSuperseded?.(), true);
});

test('a wait ends on an until match while the command keeps running', async (t) => {
  const f = setup(t);
  const id = await f.start('sleep 0.2; echo "listening on :8080"; sleep 30');
  const result = await f.call('background_bash_wait', {
    session_id: id,
    until: 'listening on :\\d+',
  });
  assert.match(result, /matched `until`; the command is still running/);
  assert.match(result, /listening on :8080/);
});

test('a second wait returns only output the first one did not', async (t) => {
  const f = setup(t);
  const id = await f.start('sleep 0.2; echo first; sleep 1; echo second');
  const first = await f.call('background_bash_wait', { session_id: id, until: 'first' });
  assert.match(first, /\nfirst$/);
  const second = await f.call('background_bash_wait', { session_id: id });
  assert.match(second, /finished\./);
  assert.match(second, /New output since you last saw it:\nsecond$/);
});

test('an invalid until pattern is reported instead of waiting', async (t) => {
  const f = setup(t);
  const id = await f.start('sleep 30');
  assert.match(
    await f.call('background_bash_wait', { session_id: id, until: '(' }),
    /^Invalid until pattern:/,
  );
});

test('a read returns only output not seen yet, under a one-line header', async (t) => {
  const f = setup(t);
  const id = await f.start('echo one; sleep 0.3; echo two; sleep 30');
  const first = await f.call('background_bash_wait', { session_id: id, until: 'two' });
  assert.match(first, /\none\ntwo$/);

  const read = await f.call('background_bash_read', { session_id: id });
  const [header] = read.split('\n');
  assert.equal(header, `Session ${id}: echo one; sleep 0.3; echo two; sleep 30`);
  assert.match(
    read,
    /New output since you last saw it:\n\(no new output since you last looked, \d+s ago\)$/,
  );
});

test('mode tail returns the whole buffered output again', async (t) => {
  const f = setup(t);
  const id = await f.start('echo one; echo two; sleep 30');
  await f.call('background_bash_wait', { session_id: id, until: 'two' });
  const tail = await f.call('background_bash_read', { session_id: id, mode: 'tail' });
  assert.match(tail, /\nOutput:\none\ntwo$/);
  // A tail read counts as seeing everything, so the next default read is empty.
  assert.match(await f.call('background_bash_read', { session_id: id }), /no new output/);
});

test('a stop from Telegram kills the command and reports that the user stopped it', async (t) => {
  const f = setup(t);
  const id = await f.start('sleep 30');
  assert.equal(await f.tapStop(), 'Stopping the command…');
  assert.equal(await f.tapStop(), 'Already stopping…');
  await until(() => f.reports.length === 1);

  const report = f.reports[0];
  assert.ok(report);
  assert.equal(report.stoppedByUser, true);
  assert.match(report.outcome, /^stopped by the user from Telegram after /);
  const prompt = backgroundBashReportPrompt(report).text;
  assert.match(prompt, /The user stopped this command from Telegram on purpose/);
  assert.match(prompt, /__BACKGROUND_BASH_NOOP__/);

  const read = await f.call('background_bash_read', { session_id: id });
  assert.match(read, /Status: stopped by the user from Telegram, ran for/);
  assert.equal(await f.tapStop(), 'That job is no longer running.');

  // The message ends on the stop, with its button gone.
  const last = f.telegram.at(-1);
  assert.equal(last?.method, 'editMessageText');
  assert.match(last?.text ?? '', /^⏹ <b>Background bash<\/b> · stopped by you · /);
  assert.deepEqual(last?.keyboard, []);
});

test('background_bash_stop still sends no report', async (t) => {
  const f = setup(t);
  const id = await f.start('sleep 30');
  assert.match(await f.call('background_bash_stop', { session_id: id }), /^Stopped session/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(f.reports, []);
  const read = await f.call('background_bash_read', { session_id: id });
  assert.match(read, /Status: stopped, ran for/);
});

test('a wait in progress when the user stops the command returns it, and the report is not needed', async (t) => {
  const f = setup(t);
  const id = await f.start('sleep 30');
  const waiting = f.call('background_bash_wait', { session_id: id });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.tapStop();
  const result = await waiting;
  assert.match(result, new RegExp(`^Session ${id}: finished\\.`));
  assert.match(result, /stopped by the user from Telegram/);
  await until(() => f.reports.length === 1);
  assert.equal(backgroundBashReportPrompt(f.reports[0]).isSuperseded?.(), true);
});

test('a stop during the yield returns the stop inline, with no report to follow', async (t) => {
  const f = setup(t);
  const starting = f.call('background_bash_start', { command: 'sleep 30', yield_time_ms: 10_000 });
  await until(() => f.telegram.some((c) => c.method === 'sendMessage'));
  await f.tapStop();
  const result = await starting;
  assert.match(result, /^Command stopped by the user from Telegram after /);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(f.reports, []);
});
