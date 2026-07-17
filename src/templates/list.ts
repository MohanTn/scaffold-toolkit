/** `scaffold templates list`: lists available version folders for each configured pack. */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/loader.js';
import { isPathPack } from '../config/schema.js';
import { packCacheDir, LOCAL_PACK_RESOLVED_SHA } from './cache.js';

export interface PackVersionListing {
  pack: string;
  url: string;
  resolvedSha?: string;
  versions: string[];
}

/** Every immediate subdirectory of `dir` that holds a `manifest.templates.json`, or `[]` if `dir` doesn't exist. */
function listVersionFolders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() && existsSync(path.join(full, 'manifest.templates.json'));
  });
}

export function listTemplateVersions(repoRoot: string, cacheRoot: string): PackVersionListing[] {
  const config = loadConfig(repoRoot);

  return Object.entries(config.packs).map(([name, pack]) => {
    if (isPathPack(pack)) {
      const dir = path.resolve(repoRoot, pack.path);
      return { pack: name, url: pack.path, resolvedSha: LOCAL_PACK_RESOLVED_SHA, versions: listVersionFolders(dir) };
    }

    if (!pack.pinnedSha) return { pack: name, url: pack.url, versions: [] };

    const dir = packCacheDir(cacheRoot, pack.url, pack.pinnedSha);
    return { pack: name, url: pack.url, resolvedSha: pack.pinnedSha, versions: listVersionFolders(dir) };
  });
}
