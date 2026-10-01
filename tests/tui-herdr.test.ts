import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TUI_HERDR_RENAME_TIMEOUT_MS } from '../src/config.ts';
import { renameHerdrTab } from '../src/tui/herdr.ts';

function runner() {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  const run = async (file: string, args: string[], timeoutMs: number): Promise<void> => {
    calls.push({ file, args, timeoutMs });
  };
  return { calls, run };
}

test('inside Herdr, the current tab is named TUI with a bounded CLI call', async () => {
  const { calls, run } = runner();
  await renameHerdrTab({ HERDR_ENV: '1', HERDR_TAB_ID: 't1' }, run);
  assert.deepEqual(calls, [
    {
      file: 'herdr',
      args: ['tab', 'rename', 't1', 'TUI'],
      timeoutMs: TUI_HERDR_RENAME_TIMEOUT_MS,
    },
  ]);
  assert.ok(TUI_HERDR_RENAME_TIMEOUT_MS > 0);
});

test('Herdr can supply its executable even when it is not on PATH', async () => {
  const { calls, run } = runner();
  await renameHerdrTab(
    { HERDR_ENV: '1', HERDR_TAB_ID: 't2', HERDR_BIN_PATH: '/opt/Herdr App/herdr' },
    run,
  );
  assert.equal(calls[0]?.file, '/opt/Herdr App/herdr');
  assert.deepEqual(calls[0]?.args, ['tab', 'rename', 't2', 'TUI']);
});

test('outside Herdr, the CLI is never called even if a tab ID is present', async () => {
  const { calls, run } = runner();
  for (const marker of [undefined, '', '0', 'true']) {
    await renameHerdrTab({ HERDR_ENV: marker, HERDR_TAB_ID: 't1' }, run);
  }
  assert.deepEqual(calls, []);
});

test('a missing or blank tab ID is a no-op', async () => {
  const { calls, run } = runner();
  for (const tabId of [undefined, '', '   ']) {
    await renameHerdrTab({ HERDR_ENV: '1', HERDR_TAB_ID: tabId }, run);
  }
  assert.deepEqual(calls, []);
});

test('a blank Herdr executable path falls back to PATH', async () => {
  const { calls, run } = runner();
  await renameHerdrTab({ HERDR_ENV: '1', HERDR_TAB_ID: 't1', HERDR_BIN_PATH: ' ' }, run);
  assert.equal(calls[0]?.file, 'herdr');
});

test('rename failures never prevent the TUI from starting', async () => {
  for (const message of ['spawn herdr ENOENT', 'server unavailable', 'timed out']) {
    await assert.doesNotReject(
      renameHerdrTab({ HERDR_ENV: '1', HERDR_TAB_ID: 't1' }, async () => {
        throw new Error(message);
      }),
    );
  }
});
