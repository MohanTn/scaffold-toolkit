/**
 * Static data describing where each supported dotnet template-pack version's
 * marker pairs belong in a brownfield repo, so `scaffold bootstrap-markers`
 * can insert empty `SCAFFOLD:<marker>:START/END` pairs for the untouched
 * `scaffold generate` injector to later find and fill by marker ID.
 *
 * Keyed by the *exact* pack version (e.g. "v10-minimal-api-gcp"), not the
 * coarse project-type bucket, because the marker set and Program.cs zones
 * differ between v8-controller/v10-minimal-api and their -gcp siblings.
 * Ground truth is `scaffold-templates-dotnet`'s own README marker table and
 * its four `manifest.templates.json` files (read-only reference, not
 * imported from here).
 *
 * This module only holds data and a namespace guard; the actual anchor
 * resolution and splicing logic lives in markerPlacement.ts.
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
