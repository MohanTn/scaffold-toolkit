/**
 * Writes .scaffold/pending/<changeset-id>.json from the report's
 * AI_IMPLEMENTATION entries — a scriptable, host-agnostic checkpoint
 * `scaffold status` rescans so a host agent (or a Claude Code hook) can
 * verify every phase-3 fill-in block actually got filled.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface PendingBlock {
  file: string;
  startLine: number;
  endLine: number;
  placeholderContent: string;
}

export interface PendingRecord {
  changesetId: string;
  blocks: PendingBlock[];
}

function pendingDir(repoRoot: string): string {
  return path.join(repoRoot, '.scaffold', 'pending');
}

/** No file is written when `blocks` is empty — nothing to track. */
export function writePending(repoRoot: string, changesetId: string, blocks: PendingBlock[]): void {
  if (blocks.length === 0) return;
  const dir = pendingDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const record: PendingRecord = { changesetId, blocks };
  writeFileSync(path.join(dir, `${changesetId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function listPendingRecords(repoRoot: string): PendingRecord[] {
  const dir = pendingDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as PendingRecord);
}

export function removePendingRecord(repoRoot: string, changesetId: string): void {
  const file = path.join(pendingDir(repoRoot), `${changesetId}.json`);
  if (existsSync(file)) unlinkSync(file);
}
