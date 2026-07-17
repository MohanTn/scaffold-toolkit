/**
 * Per-file provenance: which pack identity ({packUrl, packVersion,
 * resolvedSha}) last touched a given file. Folder-name-only provenance
 * (packVersion alone) would be ambiguous — a pack's URL could be repointed
 * to a different repository that happens to also contain a same-named
 * version folder, or the pinned SHA could move via `--update` — so both the
 * URL and the resolved SHA are compared, not just the version-folder name.
 * A mismatch on either refuses the injection rather than guessing.
 */

import type { ScaffoldConfig, ProvenanceRecord } from '../config/schema.js';
import { normalizePackUrl } from '../templates/cache.js';

export class ProvenanceMismatchError extends Error {}

export function checkProvenance(config: ScaffoldConfig, relativeFile: string, incoming: ProvenanceRecord): void {
  const existing = config.provenance?.[relativeFile];
  if (!existing) return;

  const urlChanged = normalizePackUrl(existing.packUrl) !== normalizePackUrl(incoming.packUrl);
  const shaChanged = existing.resolvedSha !== incoming.resolvedSha;
  const versionChanged = existing.packVersion !== incoming.packVersion;
  if (urlChanged || shaChanged || versionChanged) {
    throw new ProvenanceMismatchError(
      `${relativeFile} was previously scaffolded under pack "${existing.packVersion}" (${existing.packUrl}@${existing.resolvedSha}); ` +
        `the resolved pack for this run is "${incoming.packVersion}" (${incoming.packUrl}@${incoming.resolvedSha}) — ` +
        `migrating to a different pack identity requires a manual marker migration; refusing to inject blindly.`,
    );
  }
}

export function recordProvenance(config: ScaffoldConfig, relativeFile: string, record: ProvenanceRecord): void {
  config.provenance = config.provenance ?? {};
  config.provenance[relativeFile] = record;
}
