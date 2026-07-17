import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEntries, whenMatches, BASE_ARTIFACT } from '../../src/generate/entryFilter.js';

interface Entry {
  name: string;
  artifact?: string;
  when?: Record<string, string | number | boolean>;
}

const entries: Entry[] = [
  { name: 'solution' },
  { name: 'create-command', artifact: 'op-create' },
  { name: 'read-query', artifact: 'op-read' },
  { name: 'repo-split', artifact: 'op-create', when: { 'options.combine': false } },
  { name: 'repo-combined', artifact: 'op-create', when: { 'options.combine': true } },
];

test('selectEntries: absent artifacts selects every entry (legacy behavior)', () => {
  const { selected, skippedByArtifact, skippedByWhen } = selectEntries(entries, undefined, {
    options: { combine: true },
  });
  assert.deepEqual(
    selected.map((e) => e.name),
    ['solution', 'create-command', 'read-query', 'repo-combined'],
  );
  assert.equal(skippedByArtifact, 0);
  assert.equal(skippedByWhen, 1);
});

test('selectEntries: artifacts filter includes tagged entries plus base', () => {
  const { selected, skippedByArtifact } = selectEntries(entries, ['base', 'op-read'], {});
  assert.deepEqual(
    selected.map((e) => e.name),
    ['solution', 'read-query'],
  );
  assert.equal(skippedByArtifact, 3);
});

test('selectEntries: untagged entries belong to the base pseudo-tag only', () => {
  const { selected } = selectEntries(entries, ['op-read'], {});
  assert.deepEqual(
    selected.map((e) => e.name),
    ['read-query'],
  );
  assert.equal(BASE_ARTIFACT, 'base');
});

test('selectEntries: when-gate picks exactly one repo layout per combine value', () => {
  const combined = selectEntries(entries, ['op-create'], { options: { combine: true } });
  assert.deepEqual(
    combined.selected.map((e) => e.name),
    ['create-command', 'repo-combined'],
  );
  const split = selectEntries(entries, ['op-create'], { options: { combine: false } });
  assert.deepEqual(
    split.selected.map((e) => e.name),
    ['create-command', 'repo-split'],
  );
});

test('selectEntries: expected false matches an undefined context value (unset option = off)', () => {
  const { selected } = selectEntries(entries, ['op-create'], { options: {} });
  assert.deepEqual(
    selected.map((e) => e.name),
    ['create-command', 'repo-split'],
  );
});

test('selectEntries: preserves descriptor order', () => {
  const shuffledTags = selectEntries(entries, ['op-read', 'base', 'op-create'], {
    options: { combine: false },
  });
  assert.deepEqual(
    shuffledTags.selected.map((e) => e.name),
    ['solution', 'create-command', 'read-query', 'repo-split'],
  );
});

test('whenMatches: strict equality — no string/number coercion', () => {
  assert.equal(whenMatches({ 'options.retries': 3 }, { options: { retries: 3 } }), true);
  assert.equal(whenMatches({ 'options.retries': 3 }, { options: { retries: '3' } }), false);
  assert.equal(whenMatches({ 'options.provider': 'aws' }, { options: { provider: 'aws' } }), true);
  assert.equal(whenMatches({ 'options.provider': 'aws' }, { options: { provider: 'gcp' } }), false);
});

test('whenMatches: multiple keys AND together', () => {
  const context = { options: { provider: 'aws', scheduler: 'quartz' } };
  assert.equal(whenMatches({ 'options.provider': 'aws', 'options.scheduler': 'quartz' }, context), true);
  assert.equal(whenMatches({ 'options.provider': 'aws', 'options.scheduler': 'hangfire' }, context), false);
});

test('whenMatches: expected true does NOT match undefined', () => {
  assert.equal(whenMatches({ 'options.combine': true }, { options: {} }), false);
  assert.equal(whenMatches({ 'options.combine': true }, {}), false);
});

test('whenMatches: dot-path through a non-object resolves undefined, not a crash', () => {
  assert.equal(whenMatches({ 'options.db.provider': 'aws' }, { options: { db: 'postgres' } }), false);
  assert.equal(whenMatches({ 'options.db.provider': false }, { options: { db: 'postgres' } }), true);
});
