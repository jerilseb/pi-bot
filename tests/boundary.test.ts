import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

/**
 * The core knows no interface: nothing directly in src/ may import from
 * src/channels/ or src/tui/. Interfaces import the core, never the reverse.
 */

const SRC_DIR = path.resolve(import.meta.dirname, '..', 'src');
const INTERFACE_DIRS = ['channels', 'tui'].map((dir) => path.join(SRC_DIR, dir) + path.sep);

// Static imports and re-exports (`from '…'`), side-effect imports, and dynamic import('…').
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

/** The interface modules `source`, a file directly in src/, imports, as paths relative to src/. */
function interfaceImports(source: string): string[] {
  const crossings: string[] = [];
  for (const [, specifier] of source.matchAll(SPECIFIER_RE)) {
    if (!specifier.startsWith('.')) continue;
    const resolved = path.resolve(SRC_DIR, specifier);
    if (INTERFACE_DIRS.some((dir) => resolved.startsWith(dir))) {
      crossings.push(path.relative(SRC_DIR, resolved));
    }
  }
  return crossings;
}

const coreFiles = fs
  .readdirSync(SRC_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => entry.name)
  .sort();

test('no core module imports an interface', () => {
  const crossings = coreFiles.flatMap((file) =>
    interfaceImports(fs.readFileSync(path.join(SRC_DIR, file), 'utf8')).map(
      (target) => `${file} → ${target}`,
    ),
  );
  assert.deepEqual(crossings, []);
});

test('the scan finds every form of import, so a clean result means something', () => {
  const source = [
    "import { a } from './channels/telegram/telegram.ts';",
    "import type { B } from './tui/client.ts';",
    "export { c } from './channels/telegram/channel.ts';",
    "import './channels/telegram/polling.ts';",
    "const d = await import('./tui/screen.ts');",
    "import { e } from './contract.ts';",
  ].join('\n');
  assert.deepEqual(interfaceImports(source), [
    path.join('channels', 'telegram', 'telegram.ts'),
    path.join('tui', 'client.ts'),
    path.join('channels', 'telegram', 'channel.ts'),
    path.join('channels', 'telegram', 'polling.ts'),
    path.join('tui', 'screen.ts'),
  ]);
});
