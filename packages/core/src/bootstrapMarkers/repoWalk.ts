/**
 * Hand-rolled recursive filename walker — no glob dependency, matching this
 * project's stated dependency discipline (hand-roll small wrappers instead
 * of adding a dependency; see docs/prd.md's "Established conventions").
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist', 'build', '.scaffold']);

/**
 * Walks every file under `repoRoot`, skipping common build/vcs/cache
 * directories, invoking `onFile` with each repo-relative path (POSIX
 * separators, for regex matching against Handlebars path templates).
 * `excludeDirs` additionally skips any directory whose repo-relative POSIX
 * path (not just its basename) is in the set — e.g. a configured pack's own
 * vendored directory, which IGNORED_DIRS' basename-only check can't name
 * since it lives at an arbitrary in-repo path.
 */
export function walkAllFiles(repoRoot: string, onFile: (relPath: string) => void, excludeDirs: string[] = []): void {
  const excludeSet = new Set(excludeDirs);
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race with a concurrent delete) — skip rather than fail the whole walk
    }
    for (const entry of entries) {
      const relPath = path.relative(repoRoot, path.join(dir, entry.name)).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || excludeSet.has(relPath)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        onFile(relPath);
      }
    }
  }

  walk(repoRoot);
}

/** Finds every file under `repoRoot` whose base name is in `filenames`, skipping common build/vcs/cache directories and `excludeDirs`. Returns repo-relative paths (OS-native separators, matching this function's pre-existing callers). */
export function findCandidateFiles(repoRoot: string, filenames: string[], excludeDirs: string[] = []): string[] {
  const wanted = new Set(filenames);
  const results: string[] = [];
  walkAllFiles(
    repoRoot,
    (relPath) => {
      if (wanted.has(path.basename(relPath))) results.push(relPath.split('/').join(path.sep));
    },
    excludeDirs,
  );
  return results;
}
