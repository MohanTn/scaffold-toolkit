/**
 * Writes .scaffold/changes/<changeset-id>.json: prior content plus a hash of
 * the exact content just written, for every file touched by one `generate`
 * run. Change-manifest entries are whole-file (not per-marker) — undo
 * reverts a file back to its exact prior state, while injector.ts's hash
 * trailers are the finer-grained, per-marker mechanism inside a single file.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ChangeEntry {
  file: string;
  kind: 'created' | 'modified';
  /** Full prior file content, or null when `kind` is "created" (there was no prior content). */
  priorContent: string | null;
  /** sha256 hex of the full file content exactly as written by this changeset. */
  writtenHash: string;
}

export interface ChangeManifest {
  id: string;
  timestamp: string;
  entries: ChangeEntry[];
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function changesDir(repoRoot: string): string {
  return path.join(repoRoot, '.scaffold', 'changes');
}

let counter = 0;

/** Monotonically increasing within this process, and lexically sortable across processes sharing roughly the same clock — the fixed-width zero-padded epoch-ms prefix dominates the ordering, with the counter only breaking ties within the same millisecond. */
export function nextChangesetId(): string {
  counter += 1;
  return `${Date.now().toString().padStart(13, '0')}-${counter.toString().padStart(6, '0')}`;
}

export function writeChangeManifest(repoRoot: string, id: string, entries: ChangeEntry[]): ChangeManifest {
  const manifest: ChangeManifest = { id, timestamp: new Date().toISOString(), entries };
  const dir = changesDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export function loadChangeManifest(repoRoot: string, id: string): ChangeManifest {
  const file = path.join(changesDir(repoRoot), `${id}.json`);
  if (!existsSync(file)) {
    throw new Error(`no changeset "${id}" found at ${file}`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as ChangeManifest;
}

export function listChangeManifests(repoRoot: string): ChangeManifest[] {
  const dir = changesDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as ChangeManifest)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function deleteChangeManifest(repoRoot: string, id: string): void {
  const file = path.join(changesDir(repoRoot), `${id}.json`);
  if (existsSync(file)) unlinkSync(file);
}
