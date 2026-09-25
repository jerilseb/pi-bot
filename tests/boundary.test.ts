import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

/**
 * The core knows no interface: nothing directly in src/ may import from
 * src/channels/ or src/tui/. Interfaces import the core, never the reverse.
 *
 * KNOWN_CROSSINGS lists the core modules that still reach into the Telegram
 * channel — the commands, menus, uploads, voice notes and job progress messages
 * that have not moved behind the contract yet. It may only shrink: a new
 * crossing fails the first test, and a module that stops crossing fails the
 * second until it is taken off the list.
 */
const KNOWN_CROSSINGS = new Set([
  'background-bash.ts',
  'callback-menu.ts',
  'commands.ts',
  'elevenlabs-usage.ts',
  'job-progress.ts',
  'model-menu.ts',
  'openai-usage.ts',
  'reasoning-menu.ts',
  'restart-flow.ts',
  'status.ts',
  'subagent-progress.ts',
  'subagent-tool-call-menu.ts',
  'telegram-menu.ts',
  'tool-call-menu.ts',
  'transcript-menu.ts',
  'uploads.ts',
  'voice.ts',
]);

const SRC_DIR = path.resolve(import.meta.dirname, '..', 'src');
const INTERFACE_DIRS = ['channels', 'tui'].map((dir) => path.join(SRC_DIR, dir) + path.sep);

// Static imports and re-exports (`from '…'`), side-effect imports, and dynamic import('…').
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

/** The interface modules a core file imports, as paths relative to src/. */
function interfaceImports(file: string): string[] {
  const source = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
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

test('no core module imports an interface, beyond the known crossings', () => {
  const unexpected = coreFiles
    .filter((file) => !KNOWN_CROSSINGS.has(file))
    .flatMap((file) => interfaceImports(file).map((target) => `${file} → ${target}`));
  assert.deepEqual(unexpected, []);
});

test('every known crossing still crosses, so the list only shrinks', () => {
  const fixed = [...KNOWN_CROSSINGS].filter(
    (file) => !coreFiles.includes(file) || interfaceImports(file).length === 0,
  );
  assert.deepEqual(fixed, [], 'take these off KNOWN_CROSSINGS');
});

test('the scan sees imports, so a clean result means something', () => {
  assert.ok(
    interfaceImports('commands.ts').includes(path.join('channels', 'telegram', 'inbound.ts')),
  );
});
