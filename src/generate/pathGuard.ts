/** Resolves every output path and confirms it stays inside the target repo root; rejects any path that would escape it. */

import { realpathSync } from 'node:fs';
import path from 'node:path';

export class PathEscapeError extends Error {}

function escapesRoot(root: string, candidate: string): boolean {
  if (candidate === root) return false;
  const relative = path.relative(root, candidate);
  return relative === '' ? false : relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative);
}

/**
 * Resolves symlinks in whatever prefix of `p` already exists on disk, then
 * re-appends whatever trailing segments don't exist yet (a create-mode
 * target's own file, and possibly some of its parent directories, won't
 * exist until this run writes them). Walking up to the nearest existing
 * ancestor and resolving *that* is what catches a symlinked intermediate
 * directory (e.g. a repo-committed `build -> /etc`): a purely lexical
 * `path.resolve`/`path.relative` check never follows symlinks at all, so it
 * would accept a path that lands outside the repo root once the OS actually
 * follows the link at write time.
 */
function resolveRealPrefix(p: string): string {
  let current = p;
  let trailing: string[] = [];
  while (true) {
    try {
      const real = realpathSync(current);
      return trailing.length > 0 ? path.join(real, ...trailing) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p; // no ancestor exists at all; fall back to the lexical path
      trailing = [path.basename(current), ...trailing];
      current = parent;
    }
  }
}

export function resolveInsideRepo(repoRoot: string, relativeOutput: string): string {
  const resolvedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(resolvedRoot, relativeOutput);

  if (escapesRoot(resolvedRoot, resolved)) {
    throw new PathEscapeError(`output path "${relativeOutput}" resolves outside the target repo root (${resolvedRoot})`);
  }

  const realRoot = resolveRealPrefix(resolvedRoot);
  const realResolved = resolveRealPrefix(resolved);
  if (escapesRoot(realRoot, realResolved)) {
    throw new PathEscapeError(`output path "${relativeOutput}" escapes the target repo root via a symlink (${resolvedRoot})`);
  }

  return resolved;
}
