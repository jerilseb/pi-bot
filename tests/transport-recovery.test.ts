import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTransientTransportError, TRANSPORT_RECOVERY_PROMPT } from '../src/transport-recovery.ts';

for (const message of [
  'WebSocket error',
  'WebSocket connection closed',
  'fetch failed',
  'socket hang up',
  'read ECONNRESET',
  'stream ended before a terminal response event',
]) {
  test(`recognizes transient transport failure: ${message}`, () => {
    assert.equal(isTransientTransportError(message), true);
  });
}

for (const message of [
  'Request aborted',
  'Invalid API key',
  '429 rate limit exceeded',
  'insufficient quota',
  'context window overflow',
  'Tool execution failed',
]) {
  test(`does not recover unsafe/non-transport failure: ${message}`, () => {
    assert.equal(isTransientTransportError(message), false);
  });
}

test('continuation explicitly forbids blind side-effect replay', () => {
  assert.match(TRANSPORT_RECOVERY_PROMPT, /Do not repeat completed side-effecting actions/);
  assert.match(TRANSPORT_RECOVERY_PROMPT, /Verify existing state/);
});
