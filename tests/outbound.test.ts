import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRON_NOOP } from '../src/config.ts';
import { sendPiResponse } from '../src/outbound.ts';
import type { IncomingPrompt } from '../src/types.ts';

test('adds a scheduled report header only to cron responses', async (t) => {
  const messages: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { text: string };
    messages.push(payload.text);
    return Response.json({ ok: true, result: { message_id: messages.length } });
  });

  const body = '<b>News</b> &amp; updates';
  await sendPiResponse({ text: body }, { source: 'cron' });
  assert.deepEqual(messages, [`⏰ <b>Scheduled report</b>\n\n${body}`]);

  const otherSources: IncomingPrompt['source'][] = [
    undefined,
    'telegram',
    'heartbeat',
    'background-bash-report',
    'subagent-report',
  ];
  for (const source of otherSources) {
    await sendPiResponse({ text: body }, { source });
    assert.equal(messages.at(-1), body);
  }
  assert.equal(messages.length, 1 + otherSources.length);
});

test('suppresses cron noop responses without sending a header', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));

  await sendPiResponse({ text: CRON_NOOP }, { source: 'cron', suppressNoop: true });

  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a sentinel wrapped in fences, backticks, bold, or a full stop is still a noop', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));

  for (const text of [
    `\`\`\`text\n${CRON_NOOP}\n\`\`\``,
    `\`${CRON_NOOP}\``,
    `**${CRON_NOOP}**`,
    `${CRON_NOOP}.`,
    CRON_NOOP.replace(/^_+|_+$/g, ''),
    '   ',
  ]) {
    await sendPiResponse({ text }, { source: 'cron', suppressNoop: true });
  }

  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a report that merely mentions a sentinel is delivered', async (t) => {
  const messages: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { text: string };
    messages.push(payload.text);
    return Response.json({ ok: true, result: { message_id: messages.length } });
  });

  const body = `Disk is 95% full on /data. (I would reply ${CRON_NOOP} otherwise.)`;
  await sendPiResponse({ text: body }, { source: 'cron', suppressNoop: true });

  assert.equal(messages.length, 1);
  assert.ok(messages[0].endsWith(body));
});

test('narration before a sentinel does not make it a report', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));

  await sendPiResponse(
    { text: `Checking state.\n\n${CRON_NOOP}`, finalText: CRON_NOOP },
    { source: 'cron', suppressNoop: true },
  );

  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a reply that must be sent says so when the model said nothing', async (t) => {
  const messages: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    messages.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return Response.json({ ok: true, result: { message_id: messages.length } });
  });

  await sendPiResponse({ text: '' });
  await sendPiResponse({ text: '' }, { source: 'cron' });

  assert.deepEqual(messages, ['(no response)', '⏰ <b>Scheduled report</b>\n\n(no response)']);
});
