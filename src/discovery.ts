import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXTENSION_ENTRYPOINT_EXTS } from './config.ts';

export function discoverExtensionPaths(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];

      const entryPath = path.join(directory, entry.name);
      if (entry.isFile()) {
        return EXTENSION_ENTRYPOINT_EXTS.has(path.extname(entry.name).toLowerCase())
          ? [entryPath]
          : [];
      }

      if (entry.isDirectory() && isExtensionDirectory(entryPath)) {
        return [entryPath];
      }

      return [];
    })
    .sort((a, b) => a.localeCompare(b));
}

function isExtensionDirectory(directory: string): boolean {
  return ['index.ts', 'index.js', 'index.mjs', 'index.cjs', 'package.json'].some((entrypoint) =>
    fs.existsSync(path.join(directory, entrypoint)),
  );
}

export function discoverSkillPaths(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];

  const paths: string[] = [];
  const seen = new Set<string>();

  const add = (skillPath: string) => {
    const normalized = path.resolve(skillPath);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    paths.push(normalized);
  };

  const walk = (current: string) => {
    if (fs.existsSync(path.join(current, 'SKILL.md'))) {
      add(current);
      return;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (
        current === directory &&
        entry.isFile() &&
        path.extname(entry.name).toLowerCase() === '.md' &&
        entry.name.toLowerCase() !== 'readme.md'
      ) {
        add(entryPath);
      }
    }
  };

  walk(directory);
  return paths.sort((a, b) => a.localeCompare(b));
}
