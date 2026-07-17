/** Builds the TOON/JSON report `scaffold bootstrap-markers` prints, mirroring generate/report.ts's format switch. */

import { encodeToon } from '../toon/codec.js';
import type { CapabilityFlag } from '../config/schema.js';

export interface BootstrapMarkersPlacedEntry {
  marker: string;
  file: string;
  packSlot: string;
}

export interface BootstrapMarkersAlreadyPresentEntry {
  marker: string;
  file: string;
  packSlot: string;
}

export interface BootstrapMarkersNeedsManualEntry {
  marker: string;
  file?: string;
  packSlot: string;
  reason: string;
}

/**
 * A confident descriptor-driven ownership mapping (see
 * `bootstrapMarkers/descriptorMapper.ts`): `template` resolved to `file` in
 * the repo and was persisted into `.scaffold/config.json`'s `adoptedPaths`
 * for this pack slot (unless `dryRun`). Distinct from `placed`/`alreadyPresent`
 * since mapping a file's ownership and inserting a marker into it are
 * separate outcomes — a `target`-kind entry is only ever mapped, never
 * marker-placed (see the module header comment for why).
 */
export interface BootstrapMarkersMappedEntry {
  kind: 'target' | 'injection';
  template: string;
  entity?: string;
  file: string;
  packSlot: string;
  /** Manually-declared capability flag for this target/injection (config.json's `capabilityFlags`, keyed identically to `adoptedPaths`) — never inferred, and only ever attached to an entry that was already confidently mapped. */
  capability?: CapabilityFlag;
}

/**
 * A descriptor-driven mapping attempt (see `descriptorMapper.ts`) that
 * couldn't be confidently resolved — zero, or more than one, candidate real
 * file for a descriptor entry (or its only candidate(s) were dirty/
 * untracked). Reported on its own channel rather than folded into the
 * marker-placement `needsManual` array, since a mapping-needs-manual entry
 * has no `marker` (it's about *finding a file*, not placing a marker pair)
 * and gates the exit code the same way for the same reason: it is
 * actionable, not merely informational.
 */
export interface BootstrapMarkersMappingNeedsManualEntry {
  kind: 'target' | 'injection';
  template: string;
  entity?: string;
  packSlot: string;
  reason: string;
}

/**
 * A configured pack slot whose version has no ANCHOR_CATALOG entry at all
 * (e.g. a frontend pack). Deliberately separate from `needsManual`: there is
 * no per-marker action a user can take to resolve this (the slot has no
 * markers to place in the first place), so it must never gate the command's
 * exit code the way a genuinely actionable needs-manual entry does.
 */
export interface BootstrapMarkersUnsupportedPackEntry {
  packSlot: string;
  version: string;
  reason: string;
}

/**
 * Non-fatal warnings (e.g. descriptor load failed but the command still
 * makes the legacy built-in catalog work). Treated as information only —
 * they never gate the command's exit code the way `needsManual` does, so
 * a broken descriptor doesn't surface as a CI failure when the built-in
 * fallback still produced placements.
 */
export interface BootstrapMarkersWarningEntry {
  packSlot: string;
  message: string;
}

/**
 * A marker whose host file does not exist yet but is itself one of the pack's
 * own generate targets (the injection's `file` template equals a `targets[]`
 * `output` template): `scaffold generate` will create that file with the
 * marker pair already in place, so there is nothing to bootstrap and nothing
 * for a human to do. Informational only — never gates the exit code, unlike
 * `needsManual` (which previously mis-reported exactly this case and made
 * bootstrap-markers exit 1 forever on packs that provide their own injection
 * files).
 */
export interface BootstrapMarkersPendingGenerateEntry {
  marker: string;
  packSlot: string;
  /** The descriptor `targets[]` output template that will provide the file. */
  template: string;
  reason: string;
}

export interface BootstrapMarkersReport {
  dryRun: boolean;
  placed: BootstrapMarkersPlacedEntry[];
  alreadyPresent: BootstrapMarkersAlreadyPresentEntry[];
  needsManual: BootstrapMarkersNeedsManualEntry[];
  pendingGenerate: BootstrapMarkersPendingGenerateEntry[];
  unsupportedPacks: BootstrapMarkersUnsupportedPackEntry[];
  warnings: BootstrapMarkersWarningEntry[];
  mapped: BootstrapMarkersMappedEntry[];
  mappingNeedsManual: BootstrapMarkersMappingNeedsManualEntry[];
}

export function renderBootstrapMarkersReport(report: BootstrapMarkersReport, format: 'toon' | 'json'): string {
  return format === 'json' ? JSON.stringify(report, null, 2) : encodeToon(report as unknown as Record<string, unknown>);
}
