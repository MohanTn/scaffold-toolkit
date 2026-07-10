/** Builds the TOON/JSON report `scaffold bootstrap-markers` prints, mirroring generate/report.ts's format switch. */

import { encodeToon } from '../toon/codec.js';

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

export interface BootstrapMarkersReport {
  dryRun: boolean;
  placed: BootstrapMarkersPlacedEntry[];
  alreadyPresent: BootstrapMarkersAlreadyPresentEntry[];
  needsManual: BootstrapMarkersNeedsManualEntry[];
  unsupportedPacks: BootstrapMarkersUnsupportedPackEntry[];
  warnings: BootstrapMarkersWarningEntry[];
}

export function renderBootstrapMarkersReport(report: BootstrapMarkersReport, format: 'toon' | 'json'): string {
  return format === 'json' ? JSON.stringify(report, null, 2) : encodeToon(report as unknown as Record<string, unknown>);
}
