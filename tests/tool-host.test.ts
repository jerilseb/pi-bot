import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ChoiceSpec } from '../src/choices.ts';
import type { ChannelRef, Receipt, UserInput } from '../src/contract.ts';
import { telegramMenuExtension } from '../src/telegram-menu.ts';
import {
  type DeliveryDraft,
  describeReceipts,
  setToolHost,
  type ToolHost,
} from '../src/tool-host.ts';
import type { SessionKind } from '../src/types.ts';
import { telegramVoiceNoteExtension } from '../src/voice.ts';

/**
 * The agent's tools reach the user only through the core's ToolHost, so they
 * are tested against a fake one: what they deliver, what they tell the agent
 * about the receipts, and how a menu's answer comes back.
 */

const TELEGRAM: ChannelRef = { id: 'telegram', kind: 'telegram' };
const TUI: ChannelRef = { id: 'tui:1', kind: 'tui' };

function fakeHost(t: TestContext, options: { held?: boolean; voice?: boolean } = {}) {
  const delivered: DeliveryDraft[] = [];
  const choices: ChoiceSpec[] = [];
  const submitted: UserInput[] = [];
  const closed: string[] = [];
  let receipts: Receipt[] = [{ channel: TELEGRAM, ok: true }];
  const host: ToolHost = {
    async deliver(_session: SessionKind, _label, draft, after) {
      if (options.held) return { outcome: 'held' };
      const item = draft();
      delivered.push(item);
      after?.(receipts, item);
      return { outcome: 'delivered', receipts };
    },
    openChoice(spec) {
      choices.push(spec);
      return {
        id: `choice-${choices.length}`,
        text: { format: 'plain', text: spec.text },
        options: spec.options.map((option) => option.label),
        columns: spec.columns ?? 1,
        cancellable: spec.cancellable,
        audience: spec.audience,
      };
    },
    closeChoice: (id) => closed.push(id),
    async submit(input) {
      submitted.push(input);
      return { status: 'queued' };
    },
    anyChannelCan: (capability) => capability !== 'voice' || options.voice === true,
    notice: () => {},
  };
  setToolHost(host);
  t.after(() => setToolHost(null));
  return {
    delivered,
    choices,
    submitted,
    closed,
    setReceipts: (next: Receipt[]) => {
      receipts = next;
    },
  };
}

function tool(extension: (pi: ExtensionAPI) => void, name: string) {
  const tools = new Map<string, ToolDefinition>();
  extension({
    registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
  } as unknown as ExtensionAPI);
  const definition = tools.get(name);
  assert.ok(definition, `${name} registered`);
  return async (params: unknown): Promise<string> => {
    const result = await definition.execute(
      'call-1',
      params as never,
      undefined,
      undefined,
      {} as never,
    );
    return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  };
}

test('receipts: silent when every channel took it, named when some did not, an error when none did', () => {
  assert.equal(describeReceipts('images', [{ channel: TELEGRAM, ok: true }]), '');
  assert.equal(
    describeReceipts('images', [
      { channel: TELEGRAM, ok: true },
      { channel: TUI, ok: false, error: 'closed' },
      { channel: TUI, ok: false, skipped: 'unsupported' },
    ]),
    ' It did not reach tui:1 (closed).',
  );
  assert.throws(
    () => describeReceipts('images', [{ channel: TELEGRAM, ok: false, error: 'too large' }]),
    /too large/,
  );
  assert.throws(() => describeReceipts('images', []), /No connected interface can show images/);
});

test('a menu goes to every channel, and its answer comes back as the answering user', async (t) => {
  const f = fakeHost(t);
  const send = tool(telegramMenuExtension('chat'), 'send_telegram_menu');
  const result = await send({
    text: 'Deploy now?',
    options: [{ label: '✅ Yes', value: 'yes' }, { label: '❌ No' }],
    allow_cancel: true,
  });
  assert.match(result, /^Sent the menu\./);
  const [spec] = f.choices;
  assert.ok(spec);
  assert.equal(spec.audience, 'all');
  assert.equal(spec.columns, 2);
  assert.ok((spec.expiresAt ?? 0) > Date.now());

  const reply = await spec.select(0, TUI);
  assert.equal(reply?.text, 'Deploy now?\n\nSelected: ✅ Yes');
  assert.deepEqual(reply?.submitted, { status: 'queued' });
  assert.deepEqual(f.submitted[0]?.from, TUI);
  assert.match(f.submitted[0]?.text ?? '', /Selected value:\nyes/);

  const cancelled = await spec.cancel?.(TELEGRAM);
  assert.equal(cancelled?.text, 'Deploy now?\n\nCancelled.');
  assert.match(f.submitted[1]?.text ?? '', /cancelled/);
});

test('a menu no channel could show is closed again, and the agent is told', async (t) => {
  const f = fakeHost(t);
  f.setReceipts([{ channel: TELEGRAM, ok: false, error: 'chat not found' }]);
  const send = tool(telegramMenuExtension('chat'), 'send_telegram_menu');
  await assert.rejects(send({ text: 'Pick', options: [{ label: 'A' }] }), /chat not found/);
  assert.deepEqual(f.closed, ['choice-1']);
});

test('a held menu tells the agent the answer will come later', async (t) => {
  fakeHost(t, { held: true });
  const send = tool(telegramMenuExtension('background'), 'send_telegram_menu');
  assert.match(await send({ text: 'Pick', options: [{ label: 'A' }] }), /queued: the user is busy/);
});

test('with no channel that plays voice notes, a voice note goes out as its text', async (t) => {
  const f = fakeHost(t, { voice: false });
  const send = tool(telegramVoiceNoteExtension('chat'), 'send_voice_note');
  const result = await send({ text: 'Hello **there**, see `code`.' });
  assert.match(result, /^Voice note sent \(\d+ characters\)\.$/);
  assert.deepEqual(f.delivered, [{ kind: 'voice', text: 'Hello **there**, see code.' }]);
});
