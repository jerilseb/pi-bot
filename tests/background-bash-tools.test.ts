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
} from '../src/background-bash.ts';

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
  // Backgrounded chat jobs keep a progress message; answer it without sending.
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ok: true, result: { message_id: 1 } }),
  );
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
  return { call, start, reports };
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
