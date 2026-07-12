/**
 * Descriptor-driven ownership mapper for brownfield adoption: for each entry
 * in a synced pack descriptor's `targets[]`/`injections[]` (the pack's own
 * exhaustive, closed list of files it cares about — see arch-brownfield-
 * adoption.html's U8), finds the real file in an existing repo that entry
 * corresponds to, so it can be registered as pack-owned in
 * `.scaffold/config.json`'s `adoptedPaths` without requiring the repo's
 * directory layout to already match the pack's hardcoded template shape.
 *
 * Deliberately narrower than "bootstrap a marker into any matched file":
 * this module only ever *maps* (persists an ownership registration). It
 * never mutates file content — that stays the job of the existing
 * anchor/`placeMarkerGroup` machinery for `injections[]` entries the caller
 * separately resolves an anchor for. A confident match here with no known
 * anchor is still a successful *mapping* (the file becomes pack-owned, so
 * `write` is blocked and `edit` requires an AI_IMPLEMENTATION interior that
 * doesn't exist yet — a safe, conservative default), just not a *marker
 * placement*. This mirrors bootstrap-markers' broader refuse-not-guess
 * policy: a mapping is only ever confident (exactly one match, tracked and
 * clean) or left for a human, never guessed.
 */

import { walkAllFiles } from './repoWalk.js';
import { isFileCleanAndTracked } from './gitSafety.js';
import { resolveTemplatePattern } from '../checkEdit/pathTemplateMatch.js';
import type { TemplateResolutionContext } from '../checkEdit/pathTemplateMatch.js';
import type { TemplateDescriptor } from '../descriptor/schema.js';

export type MapperEntryKind = 'target' | 'injection';

export interface MapperMappedEntry {
  kind: MapperEntryKind;
  template: string;
  /** The `{{entity}}` value extracted from the match, for a per-entity template; absent for an entity-free template. */
  entity?: string;
  file: string;
}

export interface MapperNeedsManualEntry {
  kind: MapperEntryKind;
  template: string;
  entity?: string;
  reason: string;
}

export interface MapperResult {
  mapped: MapperMappedEntry[];
  needsManual: MapperNeedsManualEntry[];
}

const BARE_ENTITY_RE = /\{\{\s*entity\s*\}\}/;

function isEntityTemplate(template: string): boolean {
  return BARE_ENTITY_RE.test(template);
}

/** `adoptedPaths` key for one mapped descriptor entry — see `config/schema.ts`'s `PackConfig.adoptedPaths` doc comment. */
export function adoptedPathKey(kind: MapperEntryKind, template: string, entity?: string): string {
  return entity === undefined ? `${kind}:${template}` : `${kind}:${template}::${entity}`;
}

/**
 * Every file under `repoRoot` matching `pattern`, restricted to git-tracked-
 * and-clean files when `insideGitWorkTree` (mirroring bootstrap-markers'
 * existing marker-placement git-safety net — a dirty or untracked candidate
 * is never a legitimate confident match). Outside a git work tree, every
 * matching file is a candidate, same as bootstrap-markers' anchor-group flow.
 */
function findMatchingFiles(repoRoot: string, pattern: RegExp, insideGitWorkTree: boolean): string[] {
  const matches: string[] = [];
  walkAllFiles(repoRoot, (relPath) => {
    if (pattern.test(relPath)) matches.push(relPath);
  });
  if (!insideGitWorkTree) return matches;
  return matches.filter((relPath) => isFileCleanAndTracked(repoRoot, relPath));
}

function mapEntityTemplate(
  repoRoot: string,
  kind: MapperEntryKind,
  template: string,
  pattern: RegExp,
  insideGitWorkTree: boolean,
): { mapped: MapperMappedEntry[]; needsManual: MapperNeedsManualEntry[] } {
  const matches = findMatchingFiles(repoRoot, pattern, insideGitWorkTree);

  const byEntity = new Map<string, string[]>();
  for (const file of matches) {
    const entity = pattern.exec(file)?.groups?.entity;
    if (entity === undefined) continue; // shouldn't happen for a template containing a bare {{entity}}, but never crash the mapper over it
    const list = byEntity.get(entity) ?? [];
    list.push(file);
    byEntity.set(entity, list);
  }

  const mapped: MapperMappedEntry[] = [];
  const needsManual: MapperNeedsManualEntry[] = [];
  for (const [entity, files] of byEntity) {
    if (files.length === 1) {
      mapped.push({ kind, template, entity, file: files[0] });
    } else {
      needsManual.push({
        kind,
        template,
        entity,
        reason: `${files.length} files matched "${template}" for entity "${entity}": ${files.join(', ')} — expected exactly one`,
      });
    }
  }
  return { mapped, needsManual };
}

function mapEntityFreeTemplate(
  repoRoot: string,
  kind: MapperEntryKind,
  template: string,
  pattern: RegExp,
  insideGitWorkTree: boolean,
): { mapped: MapperMappedEntry[]; needsManual: MapperNeedsManualEntry[] } {
  const matches = findMatchingFiles(repoRoot, pattern, insideGitWorkTree);
  if (matches.length === 0) return { mapped: [], needsManual: [] }; // no candidate at all is not actionable — same as bootstrap-markers treating a target-less group as nothing to report
  if (matches.length === 1) return { mapped: [{ kind, template, file: matches[0] }], needsManual: [] };
  return {
    mapped: [],
    needsManual: [{ kind, template, reason: `${matches.length} files matched "${template}": ${matches.join(', ')} — expected exactly one` }],
  };
}

/**
 * Maps every `targets[]`/`injections[]` entry in `descriptor` to a real file
 * in `repoRoot`, using `context` (a pack slot's persisted
 * `companyProjectName`/`pathConfig`) to resolve the template's known
 * placeholders before searching — this is what lets a repo whose real
 * directory layout doesn't match the pack's hardcoded template shape still
 * be mapped, once that layout is known. Never guesses: an entry with zero or
 * multiple candidate matches (or whose only candidates are dirty/untracked)
 * is reported under `needsManual`, not silently mapped or dropped.
 */
export function mapDescriptorToRepo(repoRoot: string, descriptor: TemplateDescriptor, context: TemplateResolutionContext, insideGitWorkTree: boolean): MapperResult {
  const mapped: MapperMappedEntry[] = [];
  const needsManual: MapperNeedsManualEntry[] = [];

  const entries: { kind: MapperEntryKind; template: string }[] = [
    ...descriptor.targets.map((t) => ({ kind: 'target' as const, template: t.output })),
    ...descriptor.injections.map((i) => ({ kind: 'injection' as const, template: i.file })),
  ];

  for (const { kind, template } of entries) {
    const pattern = resolveTemplatePattern(template, context);
    const result = isEntityTemplate(template)
      ? mapEntityTemplate(repoRoot, kind, template, pattern, insideGitWorkTree)
      : mapEntityFreeTemplate(repoRoot, kind, template, pattern, insideGitWorkTree);
    mapped.push(...result.mapped);
    needsManual.push(...result.needsManual);
  }

  return { mapped, needsManual };
}
