/**
 * Pure selection of descriptor targets/injections for one generate run —
 * the whole mechanism behind artifact-scoped commands (`scaffold add
 * domain-event` rendering one file instead of the full pack).
 *
 * Two orthogonal, deterministic rules, both plain set/equality membership:
 *
 * - **artifact**: a manifest without `artifacts` selects every entry
 *   (byte-identical to the pre-tag engine); with `artifacts`, an entry is
 *   selected iff its `artifact` tag — untagged entries carry the pseudo-tag
 *   `base` — is listed.
 * - **when**: every `dot.path: expected` pair must hold against the
 *   Handlebars context under strict `===`, with one documented exception:
 *   an expected `false` also matches `undefined`, so an option a manifest
 *   never mentions behaves as switched off rather than failing both the
 *   true- and false-gated variants of a target.
 *
 * Descriptor order is preserved; no reordering, no other inputs.
 */

export interface FilterableEntry {
  artifact?: string;
  when?: Record<string, string | number | boolean>;
}

/** The pseudo-tag every untagged entry belongs to. */
export const BASE_ARTIFACT = 'base';

export interface EntrySelection<T> {
  selected: T[];
  skippedByArtifact: number;
  skippedByWhen: number;
}

function resolveDotPath(context: Record<string, unknown>, dotPath: string): unknown {
  let cursor: unknown = context;
  for (const segment of dotPath.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function whenMatches(
  when: Record<string, string | number | boolean> | undefined,
  context: Record<string, unknown>,
): boolean {
  if (!when) return true;
  return Object.entries(when).every(([dotPath, expected]) => {
    const actual = resolveDotPath(context, dotPath);
    if (expected === false && actual === undefined) return true;
    return actual === expected;
  });
}

export function selectEntries<T extends FilterableEntry>(
  entries: T[],
  manifestArtifacts: string[] | undefined,
  context: Record<string, unknown>,
): EntrySelection<T> {
  const artifactSet = manifestArtifacts === undefined ? undefined : new Set(manifestArtifacts);
  const selected: T[] = [];
  let skippedByArtifact = 0;
  let skippedByWhen = 0;

  for (const entry of entries) {
    if (artifactSet !== undefined && !artifactSet.has(entry.artifact ?? BASE_ARTIFACT)) {
      skippedByArtifact += 1;
      continue;
    }
    if (!whenMatches(entry.when, context)) {
      skippedByWhen += 1;
      continue;
    }
    selected.push(entry);
  }

  return { selected, skippedByArtifact, skippedByWhen };
}
