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
 *
 * **Pack-driven fallback chain** (axis 3): for a given slot, candidate
 * anchors are consulted in this order:
 *
 * 1. **Pack-declared** `descriptor.bootstrapAnchors` (if the descriptor was
 *    accessible — loaded from cache for a configured slot, or from a `--pack
 *    <dir>` local override), compiled via `compileBootstrapAnchors`. Any
 *    pack can declare its own anchors this way, and a non-dotnet pack's
 *    Rust/Swift/Python file-extension markers just work.
 * 2. **Built-in fallback** `ANCHOR_CATALOG[version]` — preserved for every
 *    existing dotnet pack unchanged so a dotnet install works without
 *    editing the descriptor to declare anchors it would otherwise inherit
 *    from the built-in.
 * 3. **`unsupportedPacks`** — same report field and same exit-code behavior
 *    as today; never conflated with `needsManual` since an unsupported slot
 *    has no per-marker remediation for the user.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configExists, loadConfig, saveConfig } from '../config/loader.js';
import { isPathPack } from '../config/schema.js';
import type { PackConfig, ScaffoldConfig } from '../config/schema.js';
import { loadDescriptor } from '../descriptor/load.js';
import type { TemplateDescriptor, PackCommentSyntaxMap } from '../descriptor/schema.js';
import { ANCHOR_CATALOG, compileBootstrapAnchors } from './anchorCatalog.js';
import type { AnchorGroup, PackVersion } from './anchorCatalog.js';
import { findCandidateFiles } from './repoWalk.js';
import { isInsideGitWorkTree, isFileCleanAndTracked } from './gitSafety.js';
import { placeMarkerGroup } from './markerPlacement.js';
import { resolveMarkerSyntax } from '../generate/commentSyntax.js';
import { mapDescriptorToRepo, adoptedPathKey } from './descriptorMapper.js';
import type { BootstrapMarkersReport } from './bootstrapMarkersReport.js';
import { packCacheDir } from '../templates/cache.js';
import { defaultCacheRoot } from '../templates/sync.js';

export interface RunBootstrapMarkersOptions {
  repoRoot: string;
  /** Overrides the configured pack version(s): runs exactly one pass against this version directly, no .scaffold/config.json required. */
  packVersion?: string;
  /**
   * Local pack directory override; when combined with `packVersion`, reads
   * the descriptor directly from `<packDir>/<packVersion>/manifest.templates.json`
   * without going through the cache. Lets a pack author bootstrap against
   * an un-synced local pack descriptor in CI / local development.
   */
  packDir?: string;
  dryRun: boolean;
}

interface Slot {
  name: string;
  version: string;
  /** Set for a url-based pack; mutually exclusive with packPath. */
  packUrl?: string;
  pinnedSha?: string;
  /** Set for a path-based pack; mutually exclusive with packUrl. */
  packPath?: string;
}

/** Resolved packs from an optional descriptor, plus the pack-level comment-syntax map that host files in this slot use. `full` is the whole loaded descriptor, carried through for the descriptor-driven mapping phase (`targets[]`/`injections[]`), which needs more than just `bootstrapAnchors`/`commentSyntax`. */
interface SlotDescriptor {
  full: TemplateDescriptor;
  bootstrapAnchors?: AnchorGroup[];
  packSyntaxMap?: PackCommentSyntaxMap;
}

/**
 * Wraps `loadDescriptor` for the bootstrap-markers cache path. A descriptor
 * that *exists* but fails to load (e.g. `requires.scaffoldCli` out of
 * range, or a malformed `bootstrapAnchors` that ajv rejected) returns
 * `undefined` plus a warning string, never throws: bootstrap-markers must
 * still be able to fall through to the built-in `ANCHOR_CATALOG`, the way
 * it did before this feature. Throwing here would silently regress a
 * career path that worked: pack synced yesterday with a different CLI,
 * user upgrades CLI today, bootstrap-markers today refuses loudly but
 * yesterday just used the built-in catalog. The warning keeps the failure
 * observable in the report; the fallback keeps the command useful.
 */
function loadBootstrapDescriptorForCache(
  packUrl: string,
  packVersion: string,
  pinnedSha: string | undefined,
  cacheRoot: string,
): { descriptor: SlotDescriptor | undefined; warning?: string } {
  if (!pinnedSha) return { descriptor: undefined };
  const descriptorPath = path.join(packCacheDir(cacheRoot, packUrl, pinnedSha), packVersion, 'manifest.templates.json');
  if (!existsSync(descriptorPath)) return { descriptor: undefined };
  try {
    const descriptor = loadDescriptor(descriptorPath);
    return bootstrapFromDescriptor(descriptor);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { descriptor: undefined, warning: `could not load pack descriptor for "${packUrl}"@${packVersion} (${reason}) — falling back to built-in ANCHOR_CATALOG` };
  }
}

function loadBootstrapDescriptorForLocal(packDir: string, packVersion: string): { descriptor: SlotDescriptor | undefined; warning?: string } {
  const descriptorPath = path.join(packDir, packVersion, 'manifest.templates.json');
  if (!existsSync(descriptorPath)) return { descriptor: undefined };
  try {
    const descriptor = loadDescriptor(descriptorPath);
    return bootstrapFromDescriptor(descriptor);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { descriptor: undefined, warning: `could not load pack descriptor at ${descriptorPath} (${reason}) — falling back to built-in ANCHOR_CATALOG` };
  }
}

function bootstrapFromDescriptor(descriptor: TemplateDescriptor): { descriptor: SlotDescriptor; warning?: string } {
  return {
    descriptor: {
      full: descriptor,
      bootstrapAnchors: descriptor.bootstrapAnchors !== undefined ? compileBootstrapAnchors(descriptor.bootstrapAnchors) : undefined,
      packSyntaxMap: descriptor.commentSyntax,
    },
  };
}

function isKnownPackVersion(version: string): version is PackVersion {
  return Object.prototype.hasOwnProperty.call(ANCHOR_CATALOG, version);
}

function resolveConfiguredSlots(repoRoot: string): { slots: Slot[]; config: ScaffoldConfig } {
  if (!configExists(repoRoot)) {
    throw new Error(
      'no .scaffold/config.json found — run "scaffold init --pack <name>=<path>@<version>" first, or pass --pack-version <version> to bootstrap against one version directly without a config file',
    );
  }
  const config = loadConfig(repoRoot);
  const slots = Object.entries(config.packs).map(([name, pack]) =>
    isPathPack(pack)
      ? { name, version: pack.version, packPath: pack.path }
      : { name, version: pack.version, packUrl: pack.url, pinnedSha: pack.pinnedSha },
  );
  return { slots, config };
}

export function runBootstrapMarkers(options: RunBootstrapMarkersOptions): BootstrapMarkersReport {
  const { repoRoot, dryRun } = options;
  const report: BootstrapMarkersReport = { dryRun, placed: [], alreadyPresent: [], needsManual: [], pendingGenerate: [], unsupportedPacks: [], warnings: [], mapped: [], mappingNeedsManual: [] };

  // The configured-slot path consults each pack's descriptor in the cache and
  // uses its declared `bootstrapAnchors` when present, falling back to the
  // built-in `ANCHOR_CATALOG[version]`, then unsupportedPacks. The
  // `--pack-version` override keeps the legacy behavior (built-in catalog
  // only) unless it's combined with `--pack <dir>`, in which case the
  // descriptor at `<packDir>/<packVersion>/manifest.templates.json` is
  // consulted with the same fallback chain. A descriptor that exists but
  // fails to load (e.g. `requires.scaffoldCli` out of range) never blocks
  // the fallback — it produces a warning and falls through to the built-in
  // catalog, preserving the legacy "just use the built-in" behavior.
  //
  // `config` (when resolved) is also the descriptor-mapping phase's
  // persistence target: a confident mapping for a *configured* slot mutates
  // `config.packs[name].adoptedPaths` in place, and the whole config is
  // saved once at the end (only if `!dryRun` and something actually
  // changed) — an override slot (`--pack-version`) has no config-backed
  // slot to persist into, so its mappings are reported but never saved.
  const resolved = options.packVersion ? undefined : resolveConfiguredSlots(repoRoot);
  const configuredSlots: Slot[] = resolved?.slots ?? [];
  const config = resolved?.config;
  let configDirty = false;

  const overrideSlots: { name: string; version: string }[] = options.packVersion
    ? [{ name: options.packDir ? '(--pack + --pack-version override)' : '(--pack-version override)', version: options.packVersion }]
    : [];

  const cacheRoot = defaultCacheRoot(repoRoot);

  const insideGitWorkTree = isInsideGitWorkTree(repoRoot);

  // Threads a file's progressively-updated in-memory content across multiple
  // groups (and multiple slots) that share the same file — e.g. Program.cs's
  // builder-zone and app-zone groups — processing groups in declared order
  // against the previous group's output, never the stale original. This
  // insert-only case doesn't need injector.ts's original-offset rebuild
  // technique since insertions here are sequential and non-overlapping.
  const pendingContent = new Map<string, string>();
  const touchedFiles = new Set<string>();

  function processSlot(slotName: string, slotVersion: string, slotDescriptor: SlotDescriptor | undefined, descriptorWarning?: string, persistTarget?: PackConfig): void {
    // A descriptor existed but failed to load (e.g. `requires.scaffoldCli`
    // out of range). Surface the failure on a separate channel — the
    // report's `warnings` array — so it stays observable, while still
    // falling through to the built-in ANCHOR_CATALOG for the placements.
    // Critically, this does NOT also write every built-in marker as a
    // needsManual entry: a marker ends up in exactly one of the four
    // outcome channels (placed / already-present / needsManual /
    // unsupportedPacks) per run, with descriptor-load warnings traveling
    // on their own channel so the report never says "needs manual" and
    // "placed" for the same marker in the same report.
    if (descriptorWarning) {
      report.warnings.push({ packSlot: slotName, message: descriptorWarning });
    }

    // Descriptor-driven ownership mapping runs independently of the
    // anchor/marker-placement machinery below (and of whether this pack
    // version has any ANCHOR_CATALOG/bootstrapAnchors entry at all) — it
    // only needs the descriptor's own targets[]/injections[] list, which
    // every pack has. A confident match for a *configured* slot
    // (`persistTarget` set) is persisted into `adoptedPaths`; for an
    // override slot it's reported but not saved, since there is no
    // `.scaffold/config.json` pack entry to persist into.
    if (slotDescriptor?.full) {
      const context = { companyProjectName: persistTarget?.companyProjectName, pathConfig: persistTarget?.pathConfig };
      const { mapped, needsManual: mappingNeedsManual } = mapDescriptorToRepo(repoRoot, slotDescriptor.full, context, insideGitWorkTree);
      for (const entry of mapped) {
        report.mapped.push({ ...entry, packSlot: slotName });
        if (persistTarget) {
          persistTarget.adoptedPaths = { ...persistTarget.adoptedPaths, [adoptedPathKey(entry.kind, entry.template, entry.entity)]: entry.file };
          configDirty = true;
        }
      }
      for (const entry of mappingNeedsManual) {
        report.mappingNeedsManual.push({ ...entry, packSlot: slotName });
      }
    } else if (persistTarget && !descriptorWarning) {
      // A configured pack slot with no reachable descriptor at all (most
      // commonly: a url-based pack that has never been synced, so there is
      // no pinned SHA to read a cache entry from) must not be silently
      // treated as "nothing to adopt here" — unlike check-edit's per-slot
      // fail-open (appropriate for a live, cheap, repeated edit-time gate),
      // a one-time adoption decision staying silent would let a user believe
      // a slot was fully considered when it never was.
      report.warnings.push({
        packSlot: slotName,
        message: `no synced pack descriptor available for pack slot "${slotName}" — skipping descriptor-driven ownership mapping (run "scaffold templates sync" first)`,
      });
    }

    // Empty `bootstrapAnchors: []` is treated as authoritative ("no
    // anchors declared") and intentionally does NOT fall back to the
    // built-in ANCHOR_CATALOG — the descriptor is declaring an explicit
    // decision; an absent field (`undefined`) does fall back.
    const groups: AnchorGroup[] =
      slotDescriptor?.bootstrapAnchors ?? (isKnownPackVersion(slotVersion) ? ANCHOR_CATALOG[slotVersion] : []);

    if (groups.length === 0) {
      // Not a hard error, and deliberately not a needsManual entry either:
      // this pack version simply has no bootstrap-markers anchor catalog entry
      // (e.g. a frontend pack, or a dotnet version this feature doesn't know
      // yet) and there is no per-marker action the user could take to
      // resolve it, so it must never gate the command's exit code the way an
      // actionable needsManual entry does. Reported under unsupportedPacks
      // so the caller can still see why nothing happened for this slot.
      report.unsupportedPacks.push({
        packSlot: slotName,
        version: slotVersion,
        reason: `pack version "${slotVersion}" has no bootstrap-markers anchor catalog entry — supported versions: v8-controller, v8-controller-gcp, v10-minimal-api, v10-minimal-api-gcp`,
      });
      return;
    }

    for (const group of groups) {
      const candidates = findCandidateFiles(repoRoot, group.candidateFilenames);

      let relFile: string;
      if (candidates.length === 1) {
        relFile = candidates[0];
      } else if (candidates.length > 1) {
        // Multiple candidate files are not automatically fatal: a candidate
        // that already carries the group's markers (a developer hand-placed
        // them, or a prior run placed them) is an unambiguous winner and is
        // classified already-present by placeMarkerGroup below. Failing
        // that, a single candidate whose content matches the group's anchor
        // pattern is also unambiguous. Only when neither test isolates
        // exactly one file does the group fall back to needs-manual.
        const narrowed = narrowCandidateFiles(repoRoot, candidates, group, slotDescriptor?.packSyntaxMap);
        if (narrowed === undefined) {
          const reason = `${candidates.length} candidate files found for ${group.candidateFilenames.join(' or ')}: ${candidates.join(', ')} — none uniquely carries the group's markers or matches its anchor; place the marker pair by hand in the intended file and re-run`;
          for (const marker of group.markers) report.needsManual.push({ marker, packSlot: slotName, reason });
          continue;
        }
        relFile = narrowed;
      } else {
        // Zero candidates. When the pack's own descriptor shows the marker's
        // injection file is also one of its generate targets, the file (and
        // its marker pair) will be created by `scaffold generate` itself —
        // report that on the informational pendingGenerate channel instead
        // of needsManual, so bootstrap-markers can exit 0 on a repo that is
        // simply waiting for its first generate.
        const missingReason = `no file named ${group.candidateFilenames.join(' or ')} found in the repo`;
        for (const marker of group.markers) {
          const providingTemplate = generateProvidedTemplate(slotDescriptor?.full, marker);
          if (providingTemplate !== undefined) {
            report.pendingGenerate.push({
              marker,
              packSlot: slotName,
              template: providingTemplate,
              reason: `${missingReason} — "scaffold generate" creates it (target ${providingTemplate}) with this marker already in place`,
            });
          } else {
            report.needsManual.push({ marker, packSlot: slotName, reason: missingReason });
          }
        }
        continue;
      }
      const absFile = path.join(repoRoot, relFile);

      const currentContent = pendingContent.get(absFile) ?? readFileSync(absFile, 'utf8');
      const { outcomes, content } = placeMarkerGroup(relFile, currentContent, group, slotDescriptor?.packSyntaxMap);

      // Git safety gates *writes*, not reads: a dirty or untracked file only
      // blocks markers this run would actually place into it. Markers found
      // already present (e.g. hand-placed moments ago, still uncommitted —
      // the normal brownfield adoption flow) are recognized as-is, since
      // recognizing them changes nothing on disk.
      if (content !== currentContent && insideGitWorkTree && !isFileCleanAndTracked(repoRoot, relFile)) {
        const reason = `${relFile} is not tracked-and-clean in git — commit or stash it before bootstrapping markers`;
        for (const outcome of outcomes) {
          if (outcome.outcome === 'placed') {
            report.needsManual.push({ marker: outcome.marker, file: relFile, packSlot: slotName, reason });
          } else if (outcome.outcome === 'already-present') {
            report.alreadyPresent.push({ marker: outcome.marker, file: relFile, packSlot: slotName });
          } else {
            report.needsManual.push({ marker: outcome.marker, file: relFile, packSlot: slotName, reason: outcome.reason ?? 'needs manual placement' });
          }
        }
        continue;
      }

      pendingContent.set(absFile, content);
      if (content !== currentContent) touchedFiles.add(absFile);

      for (const outcome of outcomes) {
        if (outcome.outcome === 'placed') {
          report.placed.push({ marker: outcome.marker, file: relFile, packSlot: slotName });
        } else if (outcome.outcome === 'already-present') {
          report.alreadyPresent.push({ marker: outcome.marker, file: relFile, packSlot: slotName });
        } else {
          report.needsManual.push({ marker: outcome.marker, file: relFile, packSlot: slotName, reason: outcome.reason ?? 'needs manual placement' });
        }
      }
    }
  }

  // Configured slots: a path-based pack reads its descriptor straight off
  // disk (same helper the --pack <dir> override path already uses); a
  // url-based pack reads from the cache (with pinned SHA). Either way,
  // falls back to the built-in catalog, then unsupportedPacks.
  for (const slot of configuredSlots) {
    const { descriptor, warning } = slot.packPath
      ? loadBootstrapDescriptorForLocal(path.resolve(repoRoot, slot.packPath), slot.version)
      : loadBootstrapDescriptorForCache(slot.packUrl!, slot.version, slot.pinnedSha, cacheRoot);
    processSlot(slot.name, slot.version, descriptor, warning, config!.packs[slot.name]);
  }

  // Override slot (--pack-version only, or --pack + --pack-version): descriptor overrides take precedence if available.
  for (const slot of overrideSlots) {
    let descriptor: SlotDescriptor | undefined;
    let warning: string | undefined;
    if (options.packDir) {
      const loaded = loadBootstrapDescriptorForLocal(options.packDir, slot.version);
      descriptor = loaded.descriptor;
      warning = loaded.warning;
    }
    processSlot(slot.name, slot.version, descriptor, warning);
  }

  if (!dryRun) {
    for (const absFile of touchedFiles) {
      writeFileSync(absFile, pendingContent.get(absFile)!, 'utf8');
    }
    // Persist any confident descriptor-driven mappings discovered above.
    // `config` only exists for the configured-slot path, and `configDirty`
    // only flips true when a mapping was actually persisted into one of its
    // packs' `adoptedPaths` — an override-only run, or a run that mapped
    // nothing new, never rewrites .scaffold/config.json.
    if (config && configDirty) {
      saveConfig(repoRoot, config);
    }
  }

  return report;
}

/**
 * Disambiguates multiple candidate files for one anchor group. Returns the
 * single winning rel path, or undefined when no unambiguous winner exists.
 * Precedence: exactly one candidate already carrying any of the group's
 * marker START lines wins (hand-placed or previously bootstrapped); else
 * exactly one candidate whose content matches the group's anchor pattern
 * exactly once wins; else undefined.
 */
function narrowCandidateFiles(
  repoRoot: string,
  candidates: string[],
  group: AnchorGroup,
  packSyntaxMap?: PackCommentSyntaxMap,
): string | undefined {
  const contents = new Map<string, string[]>();
  for (const rel of candidates) {
    contents.set(rel, readFileSync(path.join(repoRoot, rel), 'utf8').split('\n'));
  }

  const carrying = candidates.filter((rel) => {
    const lines = contents.get(rel)!;
    return group.markers.some((marker) => {
      try {
        const syntax = resolveMarkerSyntax(rel, marker, undefined, packSyntaxMap);
        const target = syntax.startLine.trim();
        return lines.some((line) => line.trim() === target);
      } catch {
        return false;
      }
    });
  });
  if (carrying.length === 1) return carrying[0];
  if (carrying.length > 1) return undefined;

  const pattern = group.anchor.kind === 'after-line' ? group.anchor.pattern : group.anchor.declarationPattern;
  const anchored = candidates.filter((rel) => contents.get(rel)!.filter((line) => pattern.test(line)).length === 1);
  return anchored.length === 1 ? anchored[0] : undefined;
}

/**
 * When `marker` belongs to a descriptor injection whose `file` template is
 * also one of the descriptor's `targets[]` outputs, generate creates that
 * file itself (markers included) — returns the providing target's output
 * template, or undefined when the marker's host file is genuinely external.
 */
function generateProvidedTemplate(descriptor: TemplateDescriptor | undefined, marker: string): string | undefined {
  if (!descriptor) return undefined;
  const injection = descriptor.injections.find((i) => i.marker === marker);
  if (!injection) return undefined;
  return descriptor.targets.some((t) => t.output === injection.file) ? injection.file : undefined;
}
