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
}

export interface GenerateReport {
  dryRun: boolean;
  changesetId?: string;
  created: ReportCreatedEntry[];
  injected: ReportInjectedEntry[];
  aiImplementation: ReportAiImplementationEntry[];
}

export function renderReport(report: GenerateReport, format: 'toon' | 'json'): string {
  return format === 'json' ? JSON.stringify(report, null, 2) : encodeToon(report as unknown as Record<string, unknown>);
}
