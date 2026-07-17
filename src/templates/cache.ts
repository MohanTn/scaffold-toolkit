/**
 * Cache path resolution for cloned template packs: sha256(normalizedUrl)/
 * <resolvedSha>, collision-safe by construction. Two different pack URLs
 * that happen to contain a same-named version folder (e.g. both ship a
 * "v10-minimal-api") never collide, because the cache key is the pack's own
 * identity plus the exact commit it was cloned at, not the version-folder
 * name alone.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

/** The `resolvedSha` recorded (in provenance and sync results) for a `path`-based pack, which has no git commit to pin — reads its live working-tree state instead. */
export const LOCAL_PACK_RESOLVED_SHA = 'local';

/** Normalizes a git remote URL (or local path) for stable hashing: trims whitespace, a trailing slash, a trailing ".git", and case. */
export function normalizePackUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

export function packCacheDir(cacheRoot: string, url: string, resolvedSha: string): string {
  const hash = createHash('sha256').update(normalizePackUrl(url)).digest('hex');
  return path.join(cacheRoot, hash, resolvedSha);
}
