/** `scaffold templates list`: lists available version folders for each configured pack. */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/loader.js';
import { packCacheDir } from './cache.js';

export interface PackVersionListing {
  pack: string;
  url: string;
  resolvedSha?: string;
  versions: string[];
}

export function listTemplateVersions(repoRoot: string, cacheRoot: string): PackVersionListing[] {
  const config = loadConfig(repoRoot);

  return Object.entries(config.packs).map(([name, pack]) => {
    if (!pack.pinnedSha) return { pack: name, url: pack.url, versions: [] };

    const dir = packCacheDir(cacheRoot, pack.url, pack.pinnedSha);
    if (!existsSync(dir)) return { pack: name, url: pack.url, resolvedSha: pack.pinnedSha, versions: [] };

    const versions = readdirSync(dir).filter((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() && existsSync(path.join(full, 'manifest.templates.json'));
    });
    return { pack: name, url: pack.url, resolvedSha: pack.pinnedSha, versions };
  });
}
