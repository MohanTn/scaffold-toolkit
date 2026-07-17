/**
 * `scaffold undo <changeset-id>`: reverts a prior `generate` run.
 *
 * Before touching a file, compares its current on-disk hash against the
 * post-generate hash stored in the change-manifest; a mismatch means
 * something else edited the file since, and undo refuses unless `--force`.
 *
 * Created files are deleted, not left with stale content — "restore prior
 * state" for a created file means it shouldn't exist.
 *
 * Undo is strictly reverse-chronological per file: if any *later* changeset
 * also touched a file this changeset touched, undo refuses and names the
 * later changeset id(s) that must be undone first.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deleteChangeManifest, listChangeManifests, loadChangeManifest, sha256Hex } from '../generate/changeManifest.js';
import { removePendingRecord } from '../generate/pendingTracker.js';

export class UndoBlockedError extends Error {}
export class UndoHashMismatchError extends Error {}

function findLaterChangesetsTouchingSameFiles(repoRoot: string, changesetId: string, files: string[]): Map<string, string> {
  const laterByFile = new Map<string, string>();
  for (const other of listChangeManifests(repoRoot)) {
    if (other.id <= changesetId) continue;
    for (const entry of other.entries) {
      if (files.includes(entry.file) && !laterByFile.has(entry.file)) {
        laterByFile.set(entry.file, other.id);
      }
    }
  }
  return laterByFile;
}

export function undoChangeset(repoRoot: string, changesetId: string, force: boolean): void {
  const manifest = loadChangeManifest(repoRoot, changesetId);
  const files = manifest.entries.map((e) => e.file);

  const blockedBy = findLaterChangesetsTouchingSameFiles(repoRoot, changesetId, files);
  if (blockedBy.size > 0) {
    const details = [...blockedBy.entries()].map(([file, laterId]) => `${file} (touched by later changeset ${laterId})`).join(', ');
    throw new UndoBlockedError(`cannot undo changeset ${changesetId}: a later changeset touched the same file(s) — undo that changeset first: ${details}`);
  }

  if (!force) {
    for (const entry of manifest.entries) {
      const absPath = path.join(repoRoot, entry.file);
      const currentHash = existsSync(absPath) ? sha256Hex(readFileSync(absPath, 'utf8')) : null;
      if (currentHash !== entry.writtenHash) {
        throw new UndoHashMismatchError(
          `cannot undo changeset ${changesetId}: ${entry.file} was modified since generate ran (hash mismatch) — pass --force to discard those edits`,
        );
      }
    }
  }

  for (const entry of manifest.entries) {
    const absPath = path.join(repoRoot, entry.file);
    if (entry.kind === 'created') {
      rmSync(absPath, { force: true });
    } else {
      mkdirSync(path.dirname(absPath), { recursive: true });
      writeFileSync(absPath, entry.priorContent ?? '', 'utf8');
    }
  }

  deleteChangeManifest(repoRoot, changesetId);
  removePendingRecord(repoRoot, changesetId);
}
