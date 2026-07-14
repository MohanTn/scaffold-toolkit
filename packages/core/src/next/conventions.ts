/**
 * Resolves a pack version's optional conventions.md — pack-authored house
 * rules a host agent should follow while filling AI_IMPLEMENTATION blocks —
 * for `scaffold next`'s single preamble field. Scoped per pack version
 * (packSlot + packVersion, as recorded on the pending record at generate
 * time, not the currently-configured version — a pending block still
 * reflects the pack version it was actually generated against). If the
 * repo's currently-open blocks span more than one distinct pack version, no
 * single preamble unambiguously applies, so none is attached rather than
 * guessing which one to show.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { configExists, loadConfig } from '../config/loader.js';
import { isPathPack } from '../config/schema.js';
import { packCacheDir } from '../templates/cache.js';
import { defaultCacheRoot } from '../templates/sync.js';

function resolveVersionDir(repoRoot: string, packSlot: string, packVersion: string): string | undefined {
  if (!configExists(repoRoot)) return undefined;
  const pack = loadConfig(repoRoot).packs[packSlot];
  if (!pack) return undefined;
  if (isPathPack(pack)) {
    return path.join(path.resolve(repoRoot, pack.path), packVersion);
  }
  if (!pack.pinnedSha) return undefined;
  return path.join(packCacheDir(defaultCacheRoot(repoRoot), pack.url, pack.pinnedSha), packVersion);
}

export function resolveConventions(repoRoot: string, blocks: { packSlot?: string; packVersion?: string }[]): string | undefined {
  const identified = blocks.filter(
    (b): b is { packSlot: string; packVersion: string } => b.packSlot !== undefined && b.packVersion !== undefined,
  );
  if (identified.length === 0) return undefined;

  const { packSlot, packVersion } = identified[0];
  const allSamePack = identified.every((b) => b.packSlot === packSlot && b.packVersion === packVersion);
  if (!allSamePack) return undefined;

  const versionDir = resolveVersionDir(repoRoot, packSlot, packVersion);
  if (!versionDir) return undefined;

  const conventionsPath = path.join(versionDir, 'conventions.md');
  return existsSync(conventionsPath) ? readFileSync(conventionsPath, 'utf8') : undefined;
}
