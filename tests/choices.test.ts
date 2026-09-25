import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChoiceRegistry, type ChoiceSpec } from '../src/choices.ts';
import type { ChannelRef, CoreEvent } from '../src/contract.ts';

/**
 * The menu lifecycle every channel shares: single use, the first answer wins,
 * Cancel before a refusal, stale options, failures, expiry, and menus rebuilt
 * from their definition after a restart.
 */

const TELEGRAM: ChannelRef = { id: 'telegram', kind: 'telegram' };
const TUI: ChannelRef = { id: 'tui:1', kind: 'tui' };

function fixture(now = () => 1_000) {
  const events: CoreEvent[] = [];
  const registry = new ChoiceRegistry((event) => events.push(event), now);
  const closed = () =>
    events.flatMap((event) => (event.type === 'choice_closed' ? [event.text.text] : []));
  return { registry, events, closed };
}

function spec(overrides: Partial<ChoiceSpec> = {}): ChoiceSpec {
  return {
    text: 'Pick one',
    options: [{ label: 'A' }, { label: 'B' }],
    cancellable: true,
    unknownOptionText: 'gone',
    failureToast: 'failed',
    audience: 'all',
    async select(index, by) {
      return { toast: 'ok', text: `picked ${index} from ${by.id}` };
    },
    ...overrides,
  };
}

test('a menu is shown with its options, and answered once: the first answer wins', async () => {
  const f = fixture();
  const view = f.registry.add(spec({ columns: 2 }));
  assert.deepEqual(
    { ...view, id: 'x' },
    {
      id: 'x',
      text: { format: 'plain', text: 'Pick one' },
      options: ['A', 'B'],
      columns: 2,
      cancellable: true,
      audience: 'all',
    },
  );

  const [first, second] = await Promise.all([
    f.registry.choose(view.id, 1, TUI),
    f.registry.choose(view.id, 0, TELEGRAM),
  ]);
  assert.deepEqual(first, {
    toast: 'ok',
    text: { format: 'plain', text: 'picked 1 from tui:1' },
    closed: true,
  });
  assert.equal(second.closed, false, 'the second tap finds nothing to answer');
  assert.deepEqual(f.closed(), ['picked 1 from tui:1']);
  assert.deepEqual(f.registry.views(), []);
});

test('Cancel works even when the menu would be refused, and closes it', async () => {
  const f = fixture();
  const busy = spec({ refuse: () => ({ toast: 'busy', text: 'refused' }), cancelText: 'kept' });
  const cancelled = await f.registry.choose(f.registry.add(busy).id, 'cancel', TELEGRAM);
  assert.equal(cancelled.text.text, 'kept');
  const refused = await f.registry.choose(f.registry.add(busy).id, 0, TELEGRAM);
  assert.deepEqual([refused.toast, refused.text.text], ['busy', 'refused']);
  assert.deepEqual(f.closed(), ['kept', 'refused']);
});

test('a stale option, a Cancel the menu does not offer, and a failure all close it', async () => {
  const f = fixture();
  const stale = await f.registry.choose(f.registry.add(spec()).id, 5, TELEGRAM);
  assert.deepEqual([stale.toast, stale.text.text], ['Unknown option.', 'gone']);
  const noCancel = await f.registry.choose(
    f.registry.add(spec({ cancellable: false })).id,
    'cancel',
    TELEGRAM,
  );
  assert.equal(noCancel.text.text, 'gone');
  const failing = spec({
    async select() {
      throw new Error('model <x> unavailable\n    at frame');
    },
  });
  const failed = await f.registry.choose(f.registry.add(failing).id, 0, TELEGRAM);
  assert.deepEqual([failed.toast, failed.text.text], ['failed', '❌ model <x> unavailable']);
});

test('an expired menu says so, and an unknown one is left to the tapped copy', async () => {
  let clock = 0;
  const f = fixture(() => clock);
  const view = f.registry.add(spec({ expiresAt: 10, expiredText: 'too late' }));
  clock = 11;
  const expired = await f.registry.choose(view.id, 0, TELEGRAM);
  assert.deepEqual([expired.text.text, expired.closed], ['too late', true]);
  const unknown = await f.registry.choose('nothing', 0, TELEGRAM);
  assert.equal(unknown.closed, false);
  assert.deepEqual(f.closed(), ['too late']);
});

test('a menu with a stable ID is rebuilt from its definition, with its parameter', async () => {
  const f = fixture();
  const params: Array<string | undefined> = [];
  f.registry.define('levels', (param, by) => {
    params.push(param);
    const options = (param ?? '').split('-').map((label) => ({ label }));
    return spec({
      id: 'ignored',
      options,
      audience: by,
      async select(index) {
        return { toast: 'set', text: `level ${options[index]?.label}` };
      },
    });
  });
  // A copy from before a restart: nothing is open, but the definition knows the menu.
  const outcome = await f.registry.choose('levels.low-high', 1, TELEGRAM);
  assert.deepEqual([outcome.text.text, outcome.closed], ['level high', true]);
  assert.deepEqual(params, ['low-high']);
  const closing = f.events.find((event) => event.type === 'choice_closed');
  assert.equal(closing?.type === 'choice_closed' && closing.choiceId, 'levels.low-high');
});

test('a menu the answer submitted says so, for the channel to acknowledge', async () => {
  const f = fixture();
  const submitting = spec({
    async select() {
      return { toast: 'ok', text: 'sent', submitted: { status: 'steered' } };
    },
  });
  const outcome = await f.registry.choose(f.registry.add(submitting).id, 0, TELEGRAM);
  assert.deepEqual(outcome.submitted, { status: 'steered' });
});
