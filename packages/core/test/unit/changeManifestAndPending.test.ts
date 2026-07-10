import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nextChangesetId, writeChangeManifest, loadChangeManifest, listChangeManifests, deleteChangeManifest, sha256Hex } from '../../src/generate/changeManifest.js';
import { writePending, listPendingRecords, removePendingRecord } from '../../src/generate/pendingTracker.js';

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), 'scaffold-changeset-'));
}

test('nextChangesetId is strictly increasing across successive calls', () => {
  const ids = Array.from({ length: 5 }, () => nextChangesetId());
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i] > ids[i - 1], `${ids[i]} should sort after ${ids[i - 1]}`);
  }
});

test('writeChangeManifest then loadChangeManifest round-trips entries', () => {
  const repoRoot = tmpRepo();
  const id = nextChangesetId();
  const entries = [{ file: 'Program.cs', kind: 'modified' as const, priorContent: 'old', writtenHash: sha256Hex('new') }];
  writeChangeManifest(repoRoot, id, entries);
  const loaded = loadChangeManifest(repoRoot, id);
  assert.equal(loaded.id, id);
  assert.deepEqual(loaded.entries, entries);
});

test('listChangeManifests returns changesets sorted by id ascending', () => {
  const repoRoot = tmpRepo();
  const idA = nextChangesetId();
  writeChangeManifest(repoRoot, idA, []);
  const idB = nextChangesetId();
  writeChangeManifest(repoRoot, idB, []);
  const listed = listChangeManifests(repoRoot).map((m) => m.id);
  assert.deepEqual(listed, [idA, idB]);
});

test('deleteChangeManifest removes the file; loadChangeManifest then throws', () => {
  const repoRoot = tmpRepo();
  const id = nextChangesetId();
  writeChangeManifest(repoRoot, id, []);
  deleteChangeManifest(repoRoot, id);
  assert.throws(() => loadChangeManifest(repoRoot, id));
});

test('writePending is a no-op for zero blocks, then listPendingRecords/removePendingRecord round-trip a real one', () => {
  const repoRoot = tmpRepo();
  const id = nextChangesetId();
  writePending(repoRoot, id, []);
  assert.deepEqual(listPendingRecords(repoRoot), []);

  const blocks = [{ file: 'src/Endpoints/InvoiceEndpoint.cs', startLine: 4, endLine: 6, placeholderContent: '// TODO' }];
  writePending(repoRoot, id, blocks);
  const records = listPendingRecords(repoRoot);
  assert.equal(records.length, 1);
  assert.equal(records[0].changesetId, id);
  assert.deepEqual(records[0].blocks, blocks);

  removePendingRecord(repoRoot, id);
  assert.deepEqual(listPendingRecords(repoRoot), []);
});
