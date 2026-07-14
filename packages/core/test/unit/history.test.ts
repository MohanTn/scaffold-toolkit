import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendHistoryEntry, listHistoryEntries } from '../../src/history/history.js';

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), 'scaffold-history-'));
}

test('listHistoryEntries returns an empty array when .scaffold/history/ does not exist yet', () => {
  assert.deepEqual(listHistoryEntries(tmpRepo()), []);
});

test('appendHistoryEntry then listHistoryEntries round-trips entity, options, and pack slot/version', () => {
  const repoRoot = tmpRepo();
  appendHistoryEntry(repoRoot, { changesetId: '1', packSlot: 'backend', packVersion: 'v8-controller', entity: 'Invoice', options: { 'database.provider': 'postgres' } });
  const entries = listHistoryEntries(repoRoot);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].changesetId, '1');
  assert.equal(entries[0].packSlot, 'backend');
  assert.equal(entries[0].packVersion, 'v8-controller');
  assert.equal(entries[0].entity, 'Invoice');
  assert.deepEqual(entries[0].options, { 'database.provider': 'postgres' });
  assert.ok(entries[0].timestamp);
});

test('appendHistoryEntry omits entity when the manifest did not supply one', () => {
  const repoRoot = tmpRepo();
  appendHistoryEntry(repoRoot, { changesetId: '1', packSlot: 'frontend', packVersion: 'generic-v1', options: {} });
  const entries = listHistoryEntries(repoRoot);
  assert.equal(entries[0].entity, undefined);
});

test('listHistoryEntries sorts multiple entries by changesetId ascending', () => {
  const repoRoot = tmpRepo();
  appendHistoryEntry(repoRoot, { changesetId: '2', packSlot: 'backend', packVersion: 'v1', options: {} });
  appendHistoryEntry(repoRoot, { changesetId: '1', packSlot: 'backend', packVersion: 'v1', options: {} });
  const ids = listHistoryEntries(repoRoot).map((e) => e.changesetId);
  assert.deepEqual(ids, ['1', '2']);
});
