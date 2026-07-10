/**
 * Orchestrates `scaffold bootstrap-markers`: bootstraps empty
 * `SCAFFOLD:<marker>:START/END` marker pairs into a brownfield repo's
 * existing source files, keyed by the exact configured template-pack
 * version rather than the coarse project-type bucket, so the untouched
 * `scaffold generate` injector can later find and fill them by marker ID.
 *
 * Synchronous end to end (unlike generate.ts's async flow) since every
 * dependency here — the filesystem walk, git status checks, marker
 * placement — is itself synchronous; there is no network or subprocess step
 * that benefits from being awaited.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configExists, loadConfig } from '../config/loader.js';
import { ANCHOR_CATALOG } from './anchorCatalog.js';
import type { PackVersion } from './anchorCatalog.js';
import { findCandidateFiles } from './repoWalk.js';
import { isInsideGitWorkTree, isFileCleanAndTracked } from './gitSafety.js';
import { placeMarkerGroup } from './markerPlacement.js';
import type { BootstrapMarkersReport } from './bootstrapMarkersReport.js';

export interface RunBootstrapMarkersOptions {
  repoRoot: string;
  /** Overrides the configured pack version(s): runs exactly one pass against this version directly, no .scaffold/config.json required. */
  packVersion?: string;
  dryRun: boolean;
}

interface Slot {
  name: string;
  version: string;
}

function isKnownPackVersion(version: string): version is PackVersion {
  return Object.prototype.hasOwnProperty.call(ANCHOR_CATALOG, version);
}

function resolveConfiguredSlots(repoRoot: string): Slot[] {
  if (!configExists(repoRoot)) {
    throw new Error(
      'no .scaffold/config.json found — run "scaffold init --pack <name>=<url>@<version>" first, or pass --pack-version <version> to bootstrap against one version directly without a config file',
    );
  }
  const config = loadConfig(repoRoot);
  return Object.entries(config.packs).map(([name, pack]) => ({ name, version: pack.version }));
}

export function runBootstrapMarkers(options: RunBootstrapMarkersOptions): BootstrapMarkersReport {
  const { repoRoot, dryRun } = options;
  const report: BootstrapMarkersReport = { dryRun, placed: [], alreadyPresent: [], needsManual: [], unsupportedPacks: [] };

  const slots: Slot[] = options.packVersion
    ? [{ name: '(--pack-version override)', version: options.packVersion }]
    : resolveConfiguredSlots(repoRoot);

  const insideGitWorkTree = isInsideGitWorkTree(repoRoot);

  // Threads a file's progressively-updated in-memory content across multiple
  // groups (and multiple slots) that share the same file — e.g. Program.cs's
  // builder-zone and app-zone groups — processing groups in declared order
  // against the previous group's output, never the stale original. This
  // insert-only case doesn't need injector.ts's original-offset rebuild
  // technique since insertions here are sequential and non-overlapping.
  const pendingContent = new Map<string, string>();
  const touchedFiles = new Set<string>();

  for (const slot of slots) {
    if (!isKnownPackVersion(slot.version)) {
      // Not a hard error, and deliberately not a needsManual entry either:
      // this pack version simply has no bootstrap-markers catalog entry
      // (e.g. a frontend pack, or a dotnet version this feature doesn't know
      // yet) and there is no per-marker action the user could take to
      // resolve it, so it must never gate the command's exit code the way an
      // actionable needsManual entry does. Reported under unsupportedPacks
      // so the caller can still see why nothing happened for this slot.
      report.unsupportedPacks.push({
        packSlot: slot.name,
        version: slot.version,
        reason: `pack version "${slot.version}" has no bootstrap-markers anchor catalog entry — supported versions: v8-controller, v8-controller-gcp, v10-minimal-api, v10-minimal-api-gcp`,
      });
      continue;
    }

    for (const group of ANCHOR_CATALOG[slot.version]) {
      const candidates = findCandidateFiles(repoRoot, group.candidateFilenames);
      if (candidates.length !== 1) {
        const reason =
          candidates.length === 0
            ? `no file named ${group.candidateFilenames.join(' or ')} found in the repo`
            : `${candidates.length} candidate files found for ${group.candidateFilenames.join(' or ')}: ${candidates.join(', ')} — expected exactly one`;
        for (const marker of group.markers) report.needsManual.push({ marker, packSlot: slot.name, reason });
        continue;
      }

      const relFile = candidates[0];
      const absFile = path.join(repoRoot, relFile);

      if (insideGitWorkTree && !isFileCleanAndTracked(repoRoot, relFile)) {
        const reason = `${relFile} is not tracked-and-clean in git — commit or stash it before bootstrapping markers`;
        for (const marker of group.markers) report.needsManual.push({ marker, file: relFile, packSlot: slot.name, reason });
        continue;
      }

      const currentContent = pendingContent.get(absFile) ?? readFileSync(absFile, 'utf8');
      const { outcomes, content } = placeMarkerGroup(relFile, currentContent, group);
      pendingContent.set(absFile, content);
      if (content !== currentContent) touchedFiles.add(absFile);

      for (const outcome of outcomes) {
        if (outcome.outcome === 'placed') {
          report.placed.push({ marker: outcome.marker, file: relFile, packSlot: slot.name });
        } else if (outcome.outcome === 'already-present') {
          report.alreadyPresent.push({ marker: outcome.marker, file: relFile, packSlot: slot.name });
        } else {
          report.needsManual.push({ marker: outcome.marker, file: relFile, packSlot: slot.name, reason: outcome.reason ?? 'needs manual placement' });
        }
      }
    }
  }

  if (!dryRun) {
    for (const absFile of touchedFiles) {
      writeFileSync(absFile, pendingContent.get(absFile)!, 'utf8');
    }
  }

  return report;
}
