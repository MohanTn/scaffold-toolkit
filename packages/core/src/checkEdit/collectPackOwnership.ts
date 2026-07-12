/**
 * Builds the set of path matchers `scaffold check-edit` tests a candidate
 * file against: one matcher per configured pack's `targets[].output` /
 * `injections[].file` entry, each reverse-compiled via
 * `resolveTemplatePattern` — plus, ahead of those, one exact-path matcher per
 * entry in the pack slot's persisted `adoptedPaths` (see `config/schema.ts`).
 * `adoptedPaths` matchers are pushed first so `matchOwnership`'s `.find()`
 * prefers them: a brownfield file that `scaffold bootstrap-markers` mapped
 * to a descriptor entry is owned exactly as-is, even if the descriptor's raw
 * template (or the resolved-pathConfig regex) would for some reason no
 * longer match it (e.g. a pack update changed the template shape after
 * adoption ran).
 *
 * `resolveTemplatePattern` is passed the slot's persisted
 * `companyProjectName`/`pathConfig` (when present), so a template like
 * `src/{{companyProjectName}}.Api/{{pathConfig.apiControllers}}/{{entity}}Controller.cs`
 * resolves to the repo's *real* directory layout instead of always treating
 * every placeholder as a wildcard — this is what lets a brownfield repo
 * using e.g. `Services/` instead of the pack's hardcoded `src/*.Api/Controllers/`
 * be recognized as pack-owned once that layout is persisted (via adoption),
 * without needing an `adoptedPaths` entry for every single file.
 *
 * Per-slot fail-open by construction: a pack that hasn't been synced yet
 * (`pinnedSha` unset), whose cache entry is missing, or whose descriptor
 * fails to load (schema-invalid, or a `requires.scaffoldCli` mismatch after
 * a CLI upgrade) is silently skipped rather than aborting the whole check —
 * consistent with the plan's decision that a broken/unsynced pack slot must
 * never turn `check-edit` itself into a hard failure. The cost is that a
 * file only that slot would have owned is treated as `packOwned: false`
 * (open ground) until the slot is fixed, which is the deliberately chosen
 * lesser evil versus blocking edits repo-wide over one bad pack config.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadDescriptor } from '../descriptor/load.js';
import { packCacheDir } from '../templates/cache.js';
import type { ScaffoldConfig, PackConfig } from '../config/schema.js';
import { isPathPack } from '../config/schema.js';
import { resolveTemplatePattern } from './pathTemplateMatch.js';

export interface PackOwnershipMatcher {
  packSlot: string;
  kind: 'target' | 'injection';
  template: string;
  regex: RegExp;
}

function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One exact-path matcher per `pack.adoptedPaths` entry, keyed `"<kind>:<template>"` or `"<kind>:<template>::<entity>"` (see `bootstrapMarkers/descriptorMapper.ts`). */
function adoptedPathMatchers(packSlot: string, pack: PackConfig): PackOwnershipMatcher[] {
  if (!pack.adoptedPaths) return [];
  const matchers: PackOwnershipMatcher[] = [];
  for (const [key, realPath] of Object.entries(pack.adoptedPaths)) {
    const kind = key.startsWith('injection:') ? 'injection' : 'target';
    const template = key.slice(key.indexOf(':') + 1).split('::')[0];
    matchers.push({ packSlot, kind, template, regex: new RegExp(`^${escapeRegExpLiteral(realPath)}$`) });
  }
  return matchers;
}

export function collectPackOwnership(config: ScaffoldConfig, repoRoot: string, cacheRoot: string): PackOwnershipMatcher[] {
  const matchers: PackOwnershipMatcher[] = [];

  for (const [packSlot, pack] of Object.entries(config.packs)) {
    matchers.push(...adoptedPathMatchers(packSlot, pack));

    let versionDir: string;

    if (isPathPack(pack)) {
      // A path-based pack reads straight off disk, relative to repoRoot.
      const packDir = path.resolve(repoRoot, pack.path);
      versionDir = path.join(packDir, pack.version);
    } else {
      // A URL-based pack is read from the cache (requires sync).
      if (!pack.pinnedSha) continue; // not synced yet — fail-open for this slot
      versionDir = path.join(packCacheDir(cacheRoot, pack.url, pack.pinnedSha), pack.version);
    }

    const descriptorPath = path.join(versionDir, 'manifest.templates.json');
    if (!existsSync(descriptorPath)) continue; // not found — fail-open for this slot

    let descriptor;
    try {
      descriptor = loadDescriptor(descriptorPath);
    } catch {
      continue; // schema-invalid or requires.scaffoldCli mismatch — fail-open for this slot
    }

    const context = { companyProjectName: pack.companyProjectName, pathConfig: pack.pathConfig };
    for (const target of descriptor.targets) {
      matchers.push({ packSlot, kind: 'target', template: target.output, regex: resolveTemplatePattern(target.output, context) });
    }
    for (const injection of descriptor.injections) {
      matchers.push({ packSlot, kind: 'injection', template: injection.file, regex: resolveTemplatePattern(injection.file, context) });
    }
  }

  return matchers;
}

export function matchOwnership(matchers: PackOwnershipMatcher[], relPath: string): PackOwnershipMatcher | undefined {
  return matchers.find((m) => m.regex.test(relPath));
}
