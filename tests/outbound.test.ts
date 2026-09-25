import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRON_NOOP } from '../src/config.ts';
import { isSilentResponse } from '../src/outbound.ts';

const unattended = { suppressNoop: true };

test('an unattended noop reply is silent', () => {
  assert.equal(isSilentResponse({ text: CRON_NOOP }, unattended), true);
});

test('a sentinel wrapped in fences, backticks, bold, or a full stop is still a noop', () => {
  for (const text of [
    `\`\`\`text\n${CRON_NOOP}\n\`\`\``,
    `\`${CRON_NOOP}\``,
    `**${CRON_NOOP}**`,
    `${CRON_NOOP}.`,
    CRON_NOOP.replace(/^_+|_+$/g, ''),
    '   ',
  ]) {
    assert.equal(isSilentResponse({ text }, unattended), true, text);
  }
});

test('a report that merely mentions a sentinel is delivered', () => {
  const text = `Disk is 95% full on /data. (I would reply ${CRON_NOOP} otherwise.)`;
  assert.equal(isSilentResponse({ text }, unattended), false);
});

test('narration before a sentinel does not make it a report', () => {
  const response = { text: `Checking state.\n\n${CRON_NOOP}`, finalText: CRON_NOOP };
  assert.equal(isSilentResponse(response, unattended), true);
});

test('a reply that must be sent is never silent, even when blank or a sentinel', () => {
  assert.equal(isSilentResponse({ text: '' }, {}), false);
  assert.equal(isSilentResponse({ text: CRON_NOOP }, {}), false);
});
