/** Builds the TOON/JSON report `scaffold generate` prints: files created, files injected, and every AI_IMPLEMENTATION block's file:line + current content. */

import { encodeToon } from '../toon/codec.js';

export interface ReportCreatedEntry {
  file: string;
  mode: 'create' | 'skip-if-exists' | 'overwrite';
  skipped: boolean;
}

export interface ReportInjectedEntry {
  file: string;
  marker: string;
  action: 'unchanged' | 'created' | 'updated';
}

export interface ReportAiImplementationEntry {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  empty: boolean;
  /** The pack marked this block a required business-logic fill-in; a host agent must complete it before the run is considered done (see `scaffold status`). */
  required: boolean;
}

export interface GenerateReport {
  dryRun: boolean;
  changesetId?: string;
  /** The manifest's resolved entity/options, carried through unconditionally (dry-run included) purely for `renderReportAsDoc`'s preflight summary — no new pipeline logic, just surfacing values `runGenerate` already computed. */
  entity?: string;
  options?: Record<string, unknown>;
  created: ReportCreatedEntry[];
  injected: ReportInjectedEntry[];
  aiImplementation: ReportAiImplementationEntry[];
}

export function renderReport(report: GenerateReport, format: 'toon' | 'json'): string {
  return format === 'json' ? JSON.stringify(report, null, 2) : encodeToon(report as unknown as Record<string, unknown>);
}

/**
 * Renders the same `GenerateReport` a real run produces — usually via
 * `--dry-run`, so nothing has actually been written yet — as a curated,
 * human-readable preflight doc instead of TOON/JSON. Pure formatting over
 * data `runGenerate` already computed; no new pipeline logic.
 */
export function renderReportAsDoc(report: GenerateReport): string {
  const lines: string[] = [];
  lines.push(report.dryRun ? 'scaffold generate — preflight (dry-run, nothing written)' : 'scaffold generate — report');
  lines.push('');

  if (report.entity) lines.push(`Entity: ${report.entity}`);
  const optionEntries = Object.entries(report.options ?? {});
  if (optionEntries.length > 0) {
    lines.push('Options:');
    for (const [key, value] of optionEntries) lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  if (report.entity || optionEntries.length > 0) lines.push('');

  lines.push(`Files to create (${report.created.length}):`);
  if (report.created.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of report.created) lines.push(`  - ${c.file} (mode: ${c.mode}${c.skipped ? ', skipped: already exists' : ''})`);
  }
  lines.push('');

  lines.push(`Files to inject (${report.injected.length}):`);
  if (report.injected.length === 0) {
    lines.push('  (none)');
  } else {
    for (const i of report.injected) lines.push(`  - ${i.file} [${i.marker}]: ${i.action}`);
  }
  lines.push('');

  lines.push(`AI_IMPLEMENTATION blocks left pending (${report.aiImplementation.length}):`);
  if (report.aiImplementation.length === 0) {
    lines.push('  (none)');
  } else {
    for (const b of report.aiImplementation) {
      lines.push(`  - ${b.file}:${b.startLine}-${b.endLine} (required: ${b.required}, empty: ${b.empty})`);
    }
  }

  return lines.join('\n');
}
