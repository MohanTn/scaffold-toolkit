/**
 * Places one AnchorGroup's ordered marker block into a single file's content
 * at one resolved anchor point. Never guesses between multiple candidate
 * anchors or multiple candidate existing-marker occurrences — any ambiguity
 * falls the affected marker(s) back to `needs-manual`, content unchanged.
 *
 * Existing-marker detection (step 3 below) is a small, deliberate,
 * read-only-mirroring duplication of a slice of generate/markerScan.ts's
 * logic (tolerant trimmed-line counting, file:line-style reasons) — it does
 * not import from or extend markerScan.ts, per the plan's explicit
 * instruction not to touch or generalize that file for this feature.
 */

import { resolveMarkerSyntax } from '../generate/commentSyntax.js';
import type { AnchorGroup } from './anchorCatalog.js';
import type { PackCommentSyntaxMap } from '../descriptor/schema.js';

export type PlacementOutcomeKind = 'placed' | 'already-present' | 'needs-manual';

export interface MarkerPlacementOutcome {
  marker: string;
  outcome: PlacementOutcomeKind;
  reason?: string;
}

export interface PlaceMarkerGroupResult {
  outcomes: MarkerPlacementOutcome[];
  content: string;
}

/** Bounded forward scan for the opening brace after an after-class-brace anchor's declaration line — "a few lines", not the whole file. */
const CLASS_BRACE_LOOKAHEAD = 5;

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

function needsManualForAll(group: AnchorGroup, reason: string, content: string): PlaceMarkerGroupResult {
  return { outcomes: group.markers.map((marker) => ({ marker, outcome: 'needs-manual' as const, reason })), content };
}

function findTrimmedMatchIndices(lines: string[], text: string): number[] {
  const target = text.trim();
  const indices: number[] = [];
  lines.forEach((line, idx) => {
    if (line.trim() === target) indices.push(idx);
  });
  return indices;
}

interface InsertionPoint {
  /** Index in `lines` right before which the marker block is spliced (the line immediately after the anchor). */
  insertBeforeLineIndex: number;
  indent: string;
}

interface AnchorError {
  error: string;
}

function resolveAfterLineAnchor(lines: string[], pattern: RegExp): InsertionPoint | AnchorError {
  const matches: number[] = [];
  lines.forEach((line, idx) => {
    if (pattern.test(line)) matches.push(idx);
  });
  if (matches.length === 0) return { error: `no line matching ${pattern} found` };
  if (matches.length > 1) return { error: `${matches.length} lines matched ${pattern}, expected exactly one` };
  const anchorIdx = matches[0];
  return { insertBeforeLineIndex: anchorIdx + 1, indent: leadingWhitespace(lines[anchorIdx]) };
}

function resolveAfterClassBraceAnchor(lines: string[], declarationPattern: RegExp): InsertionPoint | AnchorError {
  const declMatches: number[] = [];
  lines.forEach((line, idx) => {
    if (declarationPattern.test(line)) declMatches.push(idx);
  });
  if (declMatches.length === 0) return { error: `no line matching declaration pattern ${declarationPattern} found` };
  if (declMatches.length > 1) {
    return { error: `${declMatches.length} lines matched declaration pattern ${declarationPattern}, expected exactly one` };
  }

  // K&R style puts the opening brace on the declaration line itself (e.g.
  // "public class AppDbContext : DbContext {"), already scanned past by the
  // declaration-pattern match above — check that line first, before ever
  // looking forward, or a forward scan would walk straight past it and land
  // on the first member's own brace instead (e.g. a constructor's), splicing
  // markers inside that member rather than the class body.
  const declIdx = declMatches[0];
  if (lines[declIdx].trim().endsWith('{')) {
    return { insertBeforeLineIndex: declIdx + 1, indent: leadingWhitespace(lines[declIdx]) };
  }

  // Allman style: takes the *first* brace-like line found scanning forward —
  // that is the class's own opening brace by construction (we stop looking
  // the moment we find it), so this never needs to disambiguate between
  // candidates the way the declaration-pattern search above does. A member's
  // own opening brace further down (e.g. a constructor's) is never reached
  // because the scan already stopped at the class brace first.
  const lookaheadEnd = Math.min(lines.length, declIdx + 1 + CLASS_BRACE_LOOKAHEAD);
  for (let i = declIdx + 1; i < lookaheadEnd; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '{' || trimmed.endsWith('{')) {
      return { insertBeforeLineIndex: i + 1, indent: leadingWhitespace(lines[i]) };
    }
  }
  return { error: `no opening brace found within ${CLASS_BRACE_LOOKAHEAD} lines after declaration at line ${declIdx + 1}` };
}

export function placeMarkerGroup(filePath: string, content: string, group: AnchorGroup, packSyntaxMap?: PackCommentSyntaxMap): PlaceMarkerGroupResult {
  // (a) Resolve marker comment syntax for every marker up front; an
  // untabled extension fails identically for every marker in the group.
  // The pack-level `commentSyntax` map (if supplied) is consulted before
  // the built-in TABLE, mirroring the precedence in `generate/injector.ts`,
  // so a brownfield file in a non-table extension (e.g. `.py`, `.swift`)
  // bootstraps markers using the pack's declared syntax rather than
  // failing as "no known comment syntax".
  let syntaxes: Map<string, { startLine: string; endLine: string }>;
  try {
    syntaxes = new Map(group.markers.map((marker) => [marker, resolveMarkerSyntax(filePath, marker, undefined, packSyntaxMap)]));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return needsManualForAll(group, reason, content);
  }

  const lines = content.split('\n');

  // (c) Per-marker tolerant existence check, done first so a group whose
  // markers are all already placed (or all already flagged needs-manual by
  // this check) never has to resolve — or fail to resolve — an anchor at all.
  const outcomes: MarkerPlacementOutcome[] = [];
  const toPlace: string[] = [];

  for (const marker of group.markers) {
    const syntax = syntaxes.get(marker)!;
    const startIdx = findTrimmedMatchIndices(lines, syntax.startLine);
    const endIdx = findTrimmedMatchIndices(lines, syntax.endLine);

    if (startIdx.length === 0 && endIdx.length === 0) {
      toPlace.push(marker);
      continue;
    }
    if (startIdx.length === 1 && endIdx.length === 1) {
      outcomes.push({ marker, outcome: 'already-present' });
      continue;
    }

    let reason: string;
    if (startIdx.length === 0) {
      reason = `${filePath}:${endIdx[0] + 1}: marker "${marker}" is one-sided — found END but no START`;
    } else if (endIdx.length === 0) {
      reason = `${filePath}:${startIdx[0] + 1}: marker "${marker}" is one-sided — found START but no END`;
    } else if (startIdx.length > 1) {
      reason = `${filePath}:${startIdx.map((i) => i + 1).join(',')}: marker "${marker}" START appears ${startIdx.length} times, expected exactly once`;
    } else {
      reason = `${filePath}:${endIdx.map((i) => i + 1).join(',')}: marker "${marker}" END appears ${endIdx.length} times, expected exactly once`;
    }
    outcomes.push({ marker, outcome: 'needs-manual', reason });
  }

  if (toPlace.length === 0) {
    // Nothing left to place — content is returned byte-identical.
    return { outcomes: reorder(group, outcomes), content };
  }

  // (b) Resolve the insertion point once for the whole group, only now that
  // we know at least one marker actually needs to be placed there.
  const point =
    group.anchor.kind === 'after-line'
      ? resolveAfterLineAnchor(lines, group.anchor.pattern)
      : resolveAfterClassBraceAnchor(lines, group.anchor.declarationPattern);

  if ('error' in point) {
    // Ambiguous or missing anchor — only the markers that actually needed
    // placement fall back to needs-manual; markers step (c) already resolved
    // as already-present (or as their own needs-manual, e.g. one-sided) keep
    // that classification rather than being overwritten by an anchor problem
    // that has nothing to do with them. Content stays unchanged either way.
    for (const marker of toPlace) outcomes.push({ marker, outcome: 'needs-manual', reason: point.error });
    return { outcomes: reorder(group, outcomes), content };
  }

  // (d) Splice the markers needing placement as one contiguous block, in
  // group.markers order, immediately after the anchor.
  const placedBlockLines = toPlace.flatMap((marker) => {
    const syntax = syntaxes.get(marker)!;
    return [`${point.indent}${syntax.startLine}`, `${point.indent}${syntax.endLine}`];
  });
  const newLines = [...lines.slice(0, point.insertBeforeLineIndex), ...placedBlockLines, ...lines.slice(point.insertBeforeLineIndex)];

  for (const marker of toPlace) outcomes.push({ marker, outcome: 'placed' });

  return { outcomes: reorder(group, outcomes), content: newLines.join('\n') };
}

function reorder(group: AnchorGroup, outcomes: MarkerPlacementOutcome[]): MarkerPlacementOutcome[] {
  return group.markers.map((marker) => outcomes.find((o) => o.marker === marker)!);
}
