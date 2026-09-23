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
