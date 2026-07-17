/**
 * Hand-rolled recursive filename walker — no glob dependency, matching this
 * project's stated dependency discipline (hand-roll small wrappers instead
 * of adding a dependency; see docs/prd.md's "Established conventions").
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist', 'build', '.scaffold']);

/** Walks every file under `repoRoot`, skipping common build/vcs/cache directories, invoking `onFile` with each repo-relative path (POSIX separators, for regex matching against Handlebars path templates). */
export function walkAllFiles(repoRoot: string, onFile: (relPath: string) => void): void {
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race with a concurrent delete) — skip rather than fail the whole walk
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        onFile(path.relative(repoRoot, path.join(dir, entry.name)).split(path.sep).join('/'));
      }
    }
  }

  walk(repoRoot);
}

/** Finds every file under `repoRoot` whose base name is in `filenames`, skipping common build/vcs/cache directories. Returns repo-relative paths (OS-native separators, matching this function's pre-existing callers). */
export function findCandidateFiles(repoRoot: string, filenames: string[]): string[] {
  const wanted = new Set(filenames);
  const results: string[] = [];
  walkAllFiles(repoRoot, (relPath) => {
    if (wanted.has(path.basename(relPath))) results.push(relPath.split('/').join(path.sep));
  });
  return results;
}
