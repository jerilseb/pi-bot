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

export function discoverSkillPaths(...directories: string[]): string[] {
  const paths: string[] = [];
  const seenSkills = new Set<string>();
  const visitedDirectories = new Set<string>();

  const add = (skillPath: string) => {
    const resolved = path.resolve(skillPath);
    const canonical = fs.realpathSync(resolved);
    if (seenSkills.has(canonical)) return;
    seenSkills.add(canonical);
    paths.push(resolved);
  };

  const walk = (current: string, root: string) => {
    // Canonical paths both prevent symlink cycles and deduplicate a skill that
    // is reachable through multiple links or roots.
    const canonicalDirectory = fs.realpathSync(current);
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);

    if (fs.existsSync(path.join(current, 'SKILL.md'))) {
      add(current);
      return;
    }

    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const entryPath = path.join(current, entry.name);
      let stats: fs.Stats;
      try {
        // statSync follows symlinks; dangling links are skipped below.
        stats = fs.statSync(entryPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        walk(entryPath, root);
        continue;
      }

      if (
        current === root &&
        stats.isFile() &&
        path.extname(entry.name).toLowerCase() === '.md' &&
        entry.name.toLowerCase() !== 'readme.md'
      ) {
        add(entryPath);
      }
    }
  };

  for (const directory of directories) {
    const root = path.resolve(directory);
    if (fs.existsSync(root)) walk(root, root);
  }

  return paths.sort((a, b) => a.localeCompare(b));
}
