/**
 * ajv schema + TS type for .scaffold/config.json. The `packs` map is keyed
 * by stack name (e.g. "backend"/"frontend"), each pointing at an
 * independent template-pack git repository — not the flat
 * templatePack/templateVersion shape from the original draft, which didn't
 * fit two fully independent pack repos.
 *
 * `provenance` records, per injected file (relative to the repo root),
 * which pack identity last touched it: {packUrl, packVersion, resolvedSha},
 * not packVersion alone — see generate/provenance.ts for why folder-name-only
 * provenance would be ambiguous.
 */

export interface PackConfig {
  url: string;
  version: string;
  pinnedSha?: string;
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
  required: ['url', 'version'],
  properties: {
    url: { type: 'string', minLength: 1 },
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
