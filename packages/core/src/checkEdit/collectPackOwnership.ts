/**
 * Builds the set of path matchers `scaffold check-edit` tests a candidate
 * file against: one matcher per configured pack's `targets[].output` /
 * `injections[].file` entry, each reverse-compiled via templateToRegex.
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
import type { ScaffoldConfig } from '../config/schema.js';
import { templateToRegex } from './pathTemplateMatch.js';

export interface PackOwnershipMatcher {
  packSlot: string;
  kind: 'target' | 'injection';
  template: string;
  regex: RegExp;
}

export function collectPackOwnership(config: ScaffoldConfig, cacheRoot: string): PackOwnershipMatcher[] {
  const matchers: PackOwnershipMatcher[] = [];

  for (const [packSlot, pack] of Object.entries(config.packs)) {
    if (!pack.pinnedSha) continue; // not synced yet — fail-open for this slot

    const versionDir = path.join(packCacheDir(cacheRoot, pack.url, pack.pinnedSha), pack.version);
    const descriptorPath = path.join(versionDir, 'manifest.templates.json');
    if (!existsSync(descriptorPath)) continue; // cache entry missing — fail-open for this slot

    let descriptor;
    try {
      descriptor = loadDescriptor(descriptorPath);
    } catch {
      continue; // schema-invalid or requires.scaffoldCli mismatch — fail-open for this slot
    }

    for (const target of descriptor.targets) {
      matchers.push({ packSlot, kind: 'target', template: target.output, regex: templateToRegex(target.output) });
    }
    for (const injection of descriptor.injections) {
      matchers.push({ packSlot, kind: 'injection', template: injection.file, regex: templateToRegex(injection.file) });
    }
  }

  return matchers;
}

export function matchOwnership(matchers: PackOwnershipMatcher[], relPath: string): PackOwnershipMatcher | undefined {
  return matchers.find((m) => m.regex.test(relPath));
}
