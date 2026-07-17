/**
 * Static data describing where each supported dotnet template-pack version's
 * marker pairs belong in a brownfield repo, so `scaffold bootstrap-markers`
 * can insert empty `SCAFFOLD:<marker>:START/END` pairs for the untouched
 * `scaffold generate` injector to later find and fill by marker ID.
 *
 * Keyed by the *exact* pack version (e.g. "v10-minimal-api-gcp"), not the
 * coarse project-type bucket, because the marker set and Program.cs zones
 * differ between v8-controller/v10-minimal-api and their -gcp siblings.
 * Ground truth is `packages/templates-dotnet`'s own README marker table and
 * its four `manifest.templates.json` files (read-only reference, not
 * imported from here).
 *
 * This module only holds data and a namespace guard; the actual anchor
 * resolution and splicing logic lives in markerPlacement.ts.
 *
 * **Pack-driven fallback chain** (axis 3 of the pack-driven plan): a pack
 * may declare its own anchors directly in `manifest.templates.json` via
 * the optional `bootstrapAnchors` field; if absent, this built-in
 * `ANCHOR_CATALOG[version]` is the fallback. `compileBootstrapAnchors`
 * compiles a pack's raw `string`-pattern declaration into the same
 * runtime `AnchorGroup[]` shape this module's built-in `ANCHOR_CATALOG`
 * already uses, so `markerPlacement.ts` can consume either source
 * uniformly.
 */

export type PackVersion = 'v8-controller' | 'v8-controller-gcp' | 'v10-minimal-api' | 'v10-minimal-api-gcp';

export interface AfterLineAnchor {
  kind: 'after-line';
  /** A single-occurrence line match against the raw (untrimmed) line text. */
  pattern: RegExp;
}

export interface AfterClassBraceAnchor {
  kind: 'after-class-brace';
  /** A single-occurrence declaration-line match; the opening brace is found by a bounded forward scan from there. */
  declarationPattern: RegExp;
}

export type AnchorKind = AfterLineAnchor | AfterClassBraceAnchor;

export interface AnchorGroup {
  /** Filenames (not paths) to search the repo for; exactly one match is required to place this group. */
  candidateFilenames: string[];
  anchor: AnchorKind;
  /** Ordered marker IDs placed as one contiguous block at the anchor's insertion point. */
  markers: string[];
}

/**
 * Mirrors, but does not import from, descriptor/schema.ts:70's reserved-
 * namespace rule — that guard is enforced by ajv at descriptor-load time,
 * which this module has no reason to depend on, but the same rule must hold
 * here since nothing else would catch it for a hand-authored catalog entry.
 */
export function assertValidMarkerId(marker: string): void {
  if (/^AI_IMPLEMENTATION/.test(marker)) {
    throw new Error(`marker "${marker}" is in the reserved AI_IMPLEMENTATION namespace and cannot be bootstrapped`);
  }
}

const DBSETS_GROUP: AnchorGroup = {
  candidateFilenames: ['AppDbContext.cs'],
  anchor: { kind: 'after-class-brace', declarationPattern: /\bclass\s+AppDbContext\b/ },
  markers: ['DBSETS'],
};

const REPOSITORIES_GROUP: AnchorGroup = {
  candidateFilenames: ['ApplicationServiceCollectionExtensions.cs'],
  anchor: { kind: 'after-class-brace', declarationPattern: /\bAddApplication\s*\(\s*this\s+IServiceCollection\s+services\s*\)/ },
  markers: ['REPOSITORIES'],
};

function builderZoneGroup(markers: string[]): AnchorGroup {
  return {
    candidateFilenames: ['Program.cs'],
    anchor: { kind: 'after-line', pattern: /\.CreateBuilder\s*\(/ },
    markers,
  };
}

function appZoneGroup(markers: string[]): AnchorGroup {
  return {
    candidateFilenames: ['Program.cs'],
    anchor: { kind: 'after-line', pattern: /\.Build\s*\(\s*\)\s*;/ },
    markers,
  };
}

export const ANCHOR_CATALOG: Record<PackVersion, AnchorGroup[]> = {
  'v8-controller': [builderZoneGroup(['DI']), DBSETS_GROUP, REPOSITORIES_GROUP],
  'v10-minimal-api': [builderZoneGroup(['DI']), appZoneGroup(['MIDDLEWARE', 'ROUTES']), DBSETS_GROUP, REPOSITORIES_GROUP],
  // GSM must precede DI: InfrastructureServiceCollectionExtensions.cs's
  // AddInfrastructure reads a connection-string config key at registration
  // time that GSM populates, so GSM has to run first at app startup.
  'v8-controller-gcp': [builderZoneGroup(['GSM', 'DI', 'PUBSUB', 'SAGAS']), DBSETS_GROUP, REPOSITORIES_GROUP],
  'v10-minimal-api-gcp': [
    builderZoneGroup(['GSM', 'DI', 'PUBSUB', 'SAGAS']),
    appZoneGroup(['MIDDLEWARE', 'ROUTES']),
    DBSETS_GROUP,
    REPOSITORIES_GROUP,
  ],
};

/** Runs assertValidMarkerId over every marker in every group of `catalog`, so a bad entry is caught the moment this module is loaded by anything, not just when a specific code path happens to reach it. */
export function validateCatalog(catalog: Record<string, AnchorGroup[]>): void {
  for (const groups of Object.values(catalog)) {
    for (const group of groups) {
      for (const marker of group.markers) assertValidMarkerId(marker);
    }
  }
}

validateCatalog(ANCHOR_CATALOG);

/**
 * Compiles a pack-declared `bootstrapAnchors[]` (string patterns) into
 * the same `AnchorGroup[]` shape this module's built-in `ANCHOR_CATALOG`
 * already exposes. Runs `assertValidMarkerId` on every marker so a pack
 * authoring a reserved-name marker fails fast at descriptor-load time.
 * `Object.hasOwn(b, 'declarationPattern')` distinguishes
 * `after-class-brace` vs `after-line` so the two anchor kinds stay
 * exhaustive — ajv's `oneOf` schema check has already enforced this at
 * descriptor-load time, but a hand-authored call site (not going
 * through ajv) still gets a clear error rather than a silent taper to
 * the wrong shape.
 */
export function compileBootstrapAnchors(raw: unknown): AnchorGroup[] {
  if (!Array.isArray(raw)) {
    throw new Error('bootstrapAnchors must be an array');
  }
  const compiled: AnchorGroup[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`bootstrapAnchors[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const filenames = e.candidateFilenames;
    const anchor = e.anchor as Record<string, unknown> | undefined;
    const markers = e.markers;
    if (!Array.isArray(filenames) || filenames.length === 0 || !filenames.every((v) => typeof v === 'string' && v.length > 0)) {
      throw new Error(`bootstrapAnchors[${i}].candidateFilenames must be a non-empty array of non-empty strings`);
    }
    if (!Array.isArray(markers) || markers.length === 0) {
      throw new Error(`bootstrapAnchors[${i}].markers must be a non-empty array`);
    }
    for (const m of markers) {
      if (typeof m !== 'string') throw new Error(`bootstrapAnchors[${i}].markers entries must be strings`);
      assertValidMarkerId(m);
    }
    if (typeof anchor !== 'object' || anchor === null) {
      throw new Error(`bootstrapAnchors[${i}].anchor must be an object`);
    }
    if (anchor.kind === 'after-line') {
      if (typeof anchor.pattern !== 'string' || anchor.pattern.length === 0) {
        throw new Error(`bootstrapAnchors[${i}].anchor.pattern must be a non-empty string for kind "after-line"`);
      }
      compiled.push({
        candidateFilenames: filenames.slice(),
        anchor: { kind: 'after-line', pattern: compileRegExp(`bootstrapAnchors[${i}].anchor.pattern`, anchor.pattern) },
        markers: markers.slice(),
      });
      continue;
    }
    if (anchor.kind === 'after-class-brace') {
      if (typeof anchor.declarationPattern !== 'string' || anchor.declarationPattern.length === 0) {
        throw new Error(`bootstrapAnchors[${i}].anchor.declarationPattern must be a non-empty string for kind "after-class-brace"`);
      }
      compiled.push({
        candidateFilenames: filenames.slice(),
        anchor: { kind: 'after-class-brace', declarationPattern: compileRegExp(`bootstrapAnchors[${i}].anchor.declarationPattern`, anchor.declarationPattern) },
        markers: markers.slice(),
      });
      continue;
    }
    throw new Error(`bootstrapAnchors[${i}].anchor.kind must be "after-line" or "after-class-brace" (got ${JSON.stringify(anchor.kind)})`);
  }
  return compiled;
}

function compileRegExp(fieldPath: string, source: string): RegExp {
  try {
    return new RegExp(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${fieldPath} is not a valid RegExp source: ${source} (${message})`);
  }
}
