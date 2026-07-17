import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findCandidateFiles } from '../../src/bootstrapMarkers/repoWalk.js';

function buildTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'scaffold-repowalk-'));
  mkdirSync(path.join(root, 'src', 'Infrastructure', 'Persistence'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'Infrastructure', 'Persistence', 'AppDbContext.cs'), 'class AppDbContext {}');

  mkdirSync(path.join(root, 'node_modules', 'somepkg'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'somepkg', 'AppDbContext.cs'), 'not the real one');

  mkdirSync(path.join(root, 'bin', 'Debug'), { recursive: true });
  writeFileSync(path.join(root, 'bin', 'Debug', 'AppDbContext.cs'), 'a build output copy');

  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'AppDbContext.cs'), 'not real');

  return root;
}

test('findCandidateFiles returns a match inside a non-ignored directory but skips ignored directories', () => {
  const root = buildTree();
  const results = findCandidateFiles(root, ['AppDbContext.cs']);
  assert.deepEqual(results, [path.join('src', 'Infrastructure', 'Persistence', 'AppDbContext.cs')]);
});

test('findCandidateFiles returns an empty array, not an error, when nothing matches', () => {
  const root = buildTree();
  const results = findCandidateFiles(root, ['NoSuchFile.cs']);
  assert.deepEqual(results, []);
});

test('findCandidateFiles finds multiple matches across sibling directories', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scaffold-repowalk-multi-'));
  mkdirSync(path.join(root, 'a'), { recursive: true });
  mkdirSync(path.join(root, 'b'), { recursive: true });
  writeFileSync(path.join(root, 'a', 'Program.cs'), 'a');
  writeFileSync(path.join(root, 'b', 'Program.cs'), 'b');

  const results = findCandidateFiles(root, ['Program.cs']);
  assert.equal(results.length, 2);
  assert.ok(results.includes(path.join('a', 'Program.cs')));
  assert.ok(results.includes(path.join('b', 'Program.cs')));
});
