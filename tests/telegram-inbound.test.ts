import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ingestTelegramMessage, type TelegramInput } from '../src/channels/telegram/inbound.ts';
import type { TelegramMessage } from '../src/channels/telegram/types.ts';
import { ALLOWED_CHAT_ID, TMP_DIR } from '../src/config.ts';

const message: TelegramMessage = {
  message_id: 1,
  chat: { id: Number(ALLOWED_CHAT_ID), type: 'private' },
  date: 0,
  document: { file_id: 'download-test', file_name: 'example.txt', file_size: 3 },
};

/** No real files or requests: the download directory starts missing. */
function fakeDownload(t: TestContext, info: unknown, status = 200) {
  const actions: string[] = [];
  const errors: string[] = [];
  let directoryExists = false;

  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args.join(' ')));
  t.mock.method(fs, 'mkdirSync', (...args: unknown[]) => {
    assert.deepEqual(args, [TMP_DIR, { recursive: true }]);
    directoryExists = true;
    actions.push('mkdir');
  });
  t.mock.method(fs, 'writeFileSync', (file: fs.PathOrFileDescriptor, data: unknown) => {
    assert.ok(directoryExists, 'the download must recreate its directory before saving');
    assert.equal(path.dirname(String(file)), TMP_DIR);
    assert.deepEqual(data, Buffer.from('abc'));
    actions.push('write');
  });
  // inbound.ts uses the named fs exports; keep those bound to the fakes too.
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (new URL(String(url)).pathname.endsWith('/getFile')) return Response.json(info);
    return new Response('abc', { status });
  });

  return {
    actions,
    errors,
    removeDirectory() {
      directoryExists = false;
    },
  };
}

async function ingest(): Promise<TelegramInput[]> {
  const inputs: TelegramInput[] = [];
  await ingestTelegramMessage(message, async (input) => {
    inputs.push(input);
  });
  return inputs;
}

test('downloads recreate the temp directory, including after it is swept between files', async (t) => {
  const fake = fakeDownload(t, {
    ok: true,
    result: { file_path: 'documents/example.txt', file_size: 3 },
  });

  const first = await ingest();
  fake.removeDirectory();
  const second = await ingest();

  assert.deepEqual(fake.actions, ['mkdir', 'write', 'mkdir', 'write']);
  assert.deepEqual(fake.errors, []);
  for (const inputs of [first, second]) {
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].attachments.length, 1);
    assert.equal(inputs[0].attachments[0].filename, 'example.txt');
    assert.equal(inputs[0].attachments[0].size, 3);
    assert.equal(inputs[0].attachments[0].temporary, true);
  }
});

test('a missing getFile path is logged and returns the download failure input', async (t) => {
  const fake = fakeDownload(t, { ok: true, result: {} });

  const inputs = await ingest();

  assert.deepEqual(inputs, [{ text: '⚠️ I could not download example.txt.', attachments: [] }]);
  assert.deepEqual(fake.actions, []);
  assert.match(fake.errors.join('\n'), /getFile gave no path for download-test/);
});

test('a failed file response is logged with its HTTP status and saves nothing', async (t) => {
  const fake = fakeDownload(t, { ok: true, result: { file_path: 'documents/example.txt' } }, 503);

  const inputs = await ingest();

  assert.deepEqual(inputs, [{ text: '⚠️ I could not download example.txt.', attachments: [] }]);
  assert.deepEqual(fake.actions, []);
  assert.match(fake.errors.join('\n'), /Failed to download Telegram file download-test: HTTP 503/);
});
