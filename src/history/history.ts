/**
 * Appends `.scaffold/history/<changeset-id>.json` after a successful (real,
 * non-dry-run) `scaffold generate` that actually wrote something: entity
 * name, options chosen, and the resolved pack slot/version, so a future
 * manifest has something to pattern-match against. Deliberately independent
 * of changeManifest.ts's schema (file/kind/hash, driving `undo`) — this is a
 * different consumer with a different shape, so the two are free to diverge
 * without either breaking the other.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface HistoryEntry {
  changesetId: string;
  timestamp: string;
  packSlot: string;
  packVersion: string;
  entity?: string;
  options: Record<string, unknown>;
}

function historyDir(repoRoot: string): string {
  return path.join(repoRoot, '.scaffold', 'history');
}

export function appendHistoryEntry(repoRoot: string, entry: Omit<HistoryEntry, 'timestamp'>): void {
  const dir = historyDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const record: HistoryEntry = { timestamp: new Date().toISOString(), ...entry };
  writeFileSync(path.join(dir, `${entry.changesetId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function listHistoryEntries(repoRoot: string): HistoryEntry[] {
  const dir = historyDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as HistoryEntry)
    .sort((a, b) => (a.changesetId < b.changesetId ? -1 : a.changesetId > b.changesetId ? 1 : 0));
}
