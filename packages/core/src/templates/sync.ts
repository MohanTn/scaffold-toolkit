/**
 * `scaffold templates sync [--update]`: clones or reuses the configured
 * template pack(s) into the local cache. Without `--update`, an already-
 * pinned pack is resolved straight to its pinned SHA (no network round
 * trip beyond what's needed to clone it if the cache is cold). With
 * `--update`, the ref is re-resolved to the remote's current HEAD SHA and
 * `.scaffold/config.json`'s pinned SHA is rewritten — the only supported
 * path to deliberately move a pinned pack forward.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config/loader.js';
import type { PackConfig } from '../config/schema.js';
import { cloneToDir, resolveHeadSha } from './gitClone.js';
import { packCacheDir } from './cache.js';

export function defaultCacheRoot(repoRoot: string): string {
  return path.join(repoRoot, '.scaffold', 'cache');
}

export interface SyncResult {
  pack: string;
  url: string;
  resolvedSha: string;
  changed: boolean;
}

async function ensureCloned(cacheRoot: string, url: string, resolvedSha: string): Promise<void> {
  const dir = packCacheDir(cacheRoot, url, resolvedSha);
  if (existsSync(dir)) return;

  mkdirSync(path.dirname(dir), { recursive: true });
  // git clone accepts an existing *empty* directory as its destination, so
  // the mkdtemp'd dir (guaranteed fresh and empty) is used as-is, then
  // renamed into place once the clone succeeds — a clone that fails partway
  // never leaves a half-populated entry at the final cache path.
  const tmp = mkdtempSync(path.join(tmpdir(), 'scaffold-clone-'));
  try {
    await cloneToDir(url, tmp);
    renameSync(tmp, dir);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

async function syncOnePack(cacheRoot: string, pack: PackConfig, update: boolean): Promise<SyncResult> {
  const resolvedSha = update || !pack.pinnedSha ? await resolveHeadSha(pack.url) : pack.pinnedSha;
  await ensureCloned(cacheRoot, pack.url, resolvedSha);
  return { pack: '', url: pack.url, resolvedSha, changed: resolvedSha !== pack.pinnedSha };
}

export async function syncTemplates(repoRoot: string, cacheRoot: string, options: { update?: boolean } = {}): Promise<SyncResult[]> {
  const config = loadConfig(repoRoot);
  const results: SyncResult[] = [];

  for (const [name, pack] of Object.entries(config.packs)) {
    const result = await syncOnePack(cacheRoot, pack, options.update ?? false);
    result.pack = name;
    if (result.changed) {
      config.packs[name] = { ...pack, pinnedSha: result.resolvedSha };
    }
    results.push(result);
  }

  saveConfig(repoRoot, config);
  return results;
}
