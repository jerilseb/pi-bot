import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderCollapsedToolCalls } from '../src/tool-notifications.ts';

test('renders one tool call under a singular header', () => {
  assert.equal(
    renderCollapsedToolCalls(['🛠 bash (<code>ls</code>)']),
    '🛠 <b>1 tool call</b>\n<blockquote expandable>bash (<code>ls</code>)</blockquote>',
  );
});

test('drops each line’s leading icon, including a variation selector', () => {
  const html = renderCollapsedToolCalls([
    '🛠 bash',
    '🧠 memory updated',
    '📗 pdf',
    '⚠️ something',
    'no icon at all',
  ]);
  assert.equal(
    html,
    [
      '🛠 <b>5 tool calls</b>',
      '<blockquote expandable>bash\nmemory updated\npdf\nsomething\nno icon at all</blockquote>',
    ].join('\n'),
  );
});

test('counts hidden lines in the header', () => {
  assert.equal(
    renderCollapsedToolCalls(['🛠 bash'], 4),
    '🛠 <b>5 tool calls</b> <i>(4 not shown)</i>\n<blockquote expandable>bash</blockquote>',
  );
});

test('renders a header alone when every line was dropped', () => {
  assert.equal(renderCollapsedToolCalls([], 3), '🛠 <b>3 tool calls</b> <i>(3 not shown)</i>');
});
