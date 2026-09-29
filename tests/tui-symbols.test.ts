import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';

/**
 * A symbol that can be an emoji but has no emoji selector (U+FE0F) after it,
 * such as ⚙ or ⏹, counts as one column to the TUI, and many terminals draw it
 * as a two-column emoji over the text beside it. With the selector both count
 * two. Every such symbol the terminal UI draws has one.
 */

const TUI_DIR = path.join(import.meta.dirname, '..', 'src', 'tui');

test('every emoji-capable symbol the terminal UI draws asks for its emoji', () => {
  const bare: string[] = [];
  for (const file of fs.readdirSync(TUI_DIR).filter((name) => name.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(TUI_DIR, file), 'utf8');
    for (const match of source.matchAll(/\p{Extended_Pictographic}(?!️)/gu)) {
      if (visibleWidth(match[0]) === 1) bare.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(bare, []);
});
