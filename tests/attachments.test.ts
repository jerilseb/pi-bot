import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { cleanupAttachments } from '../src/attachments.ts';
import { parseClientMessage } from '../src/channels/socket/protocol.ts';
import { TMP_DIR } from '../src/config.ts';

function tempFile(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `attachments-test-${randomBytes(4).toString('hex')}.png`);
  fs.writeFileSync(file, 'png');
  return file;
}

test('only the downloads a channel marked temporary are deleted, and only in the temp folder', (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-attachments-'));
  const download = tempFile(TMP_DIR);
  const botsOwn = tempFile(TMP_DIR);
  const elsewhere = tempFile(outside);
  t.after(() => {
    for (const file of [download, botsOwn]) fs.rmSync(file, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  cleanupAttachments({
    attachments: [
      { type: 'image', path: download, temporary: true },
      { type: 'image', path: botsOwn },
      { type: 'image', path: elsewhere, temporary: true },
    ],
  });

  assert.equal(fs.existsSync(download), false);
  assert.equal(fs.existsSync(botsOwn), true, "a terminal's path into the temp folder stays");
  assert.equal(fs.existsSync(elsewhere), true, 'nothing outside the temp folder is deleted');
});

test('a terminal cannot mark what it submits temporary', () => {
  const message = parseClientMessage({
    id: 1,
    type: 'submit',
    text: '[Image 1]',
    attachments: [{ type: 'image', path: path.join(TMP_DIR, 'sent.png'), temporary: true }],
  });
  assert.ok(message?.type === 'submit');
  assert.equal(message.attachments[0]?.temporary, undefined);
});
