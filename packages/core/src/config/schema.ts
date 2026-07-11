/**
 * ajv schema + TS type for .scaffold/config.json. The `packs` map is keyed
 * by stack name (e.g. "backend"/"frontend"), each pointing at an
 * independent template pack — not the flat templatePack/templateVersion
 * shape from the original draft, which didn't fit two fully independent
 * pack repos.
 *
 * A pack entry is one of two mutually exclusive shapes: `url` (a
 * git-clonable remote, resolved and cached by `templates sync`) or `path`
 * (a local directory read straight off disk, no clone/cache/pinned SHA).
 * `scaffold init` only ever emits `path` entries — the git/`url` engine
 * stays in place underneath for a future non-vendored pack, but nothing in
 * the CLI writes a `url` entry anymore. The XOR between them is enforced at
 * runtime in `loader.ts` (not here) to keep this ajv schema flat, matching
 * the rest of this file's style.
 *
 * `provenance` records, per injected file (relative to the repo root),
 * which pack identity last touched it: {packUrl, packVersion, resolvedSha},
 * not packVersion alone — see generate/provenance.ts for why folder-name-only
 * provenance would be ambiguous.
 */

export type PackConfig =
  | { url: string; version: string; pinnedSha?: string; path?: never }
  | { path: string; version: string; pinnedSha?: never; url?: never };

/**
 * Narrows a `PackConfig` to its `path`-based variant. A plain `pack.path`
 * truthiness or `'path' in pack` check doesn't narrow the union reliably
 * here (both variants declare the `path` key, just typed `never` on the
 * `url` side), so call sites use this predicate instead.
 */
export function isPathPack(pack: PackConfig): pack is Extract<PackConfig, { path: string }> {
  return typeof pack.path === 'string';
}

export interface ProvenanceRecord {
  packUrl: string;
  packVersion: string;
  resolvedSha: string;
}

export interface ScaffoldConfig {
  projectType: string;
  packs: Record<string, PackConfig>;
  provenance?: Record<string, ProvenanceRecord>;
}

const packConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version'],
  properties: {
    url: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    pinnedSha: { type: 'string', minLength: 1 },
  },
} as const;

const provenanceRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['packUrl', 'packVersion', 'resolvedSha'],
  properties: {
    packUrl: { type: 'string', minLength: 1 },
    packVersion: { type: 'string', minLength: 1 },
    resolvedSha: { type: 'string', minLength: 1 },
  },
} as const;

export const configSchema = {
  $id: 'https://scaffold-toolkit.dev/schemas/scaffold-config.json',
  type: 'object',
  additionalProperties: false,
  required: ['projectType', 'packs'],
  properties: {
    projectType: { type: 'string', minLength: 1 },
    packs: {
      type: 'object',
      additionalProperties: packConfigSchema,
    },
    provenance: {
      type: 'object',
      additionalProperties: provenanceRecordSchema,
    },
  },
} as const;
