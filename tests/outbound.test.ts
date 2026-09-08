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
    return Response.json({ ok: true });
  });

  const body = '<b>News</b> &amp; updates';
  await sendPiResponse({ text: body }, { source: 'cron' });
  assert.deepEqual(messages, [`⏰ <b>Scheduled report</b>\n\n${body}`]);

  const otherSources: IncomingPrompt['source'][] = [
    undefined,
    'telegram',
    'heartbeat',
    'background-bash-report',
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
