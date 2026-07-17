import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInsideRepo, PathEscapeError } from '../../src/generate/pathGuard.js';

const repoRoot = '/tmp/scaffold-fake-repo';

test('resolveInsideRepo accepts a normal relative path inside the repo', () => {
  const resolved = resolveInsideRepo(repoRoot, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.equal(resolved, path.join(repoRoot, 'src/Endpoints/InvoiceEndpoint.cs'));
});

test('resolveInsideRepo rejects a path traversal escaping the repo root', () => {
  assert.throws(() => resolveInsideRepo(repoRoot, '../../etc/passwd'), PathEscapeError);
});

test('resolveInsideRepo rejects an absolute path outside the repo root', () => {
  assert.throws(() => resolveInsideRepo(repoRoot, '/etc/passwd'), PathEscapeError);
});

test('resolveInsideRepo rejects a path that traverses out and back to escape via a sibling directory', () => {
  assert.throws(() => resolveInsideRepo(repoRoot, '../scaffold-fake-repo-evil/x.cs'), PathEscapeError);
});

test('resolveInsideRepo rejects a target whose intermediate directory is a symlink escaping the repo root', () => {
  const realRoot = mkdtempSync(path.join(tmpdir(), 'scaffold-real-repo-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'scaffold-outside-'));
  symlinkSync(outside, path.join(realRoot, 'build'), 'dir');

  // Lexically "build/Foo.cs" resolves inside realRoot, but `build` is a
  // symlink pointing outside it, so the OS would actually write to `outside`.
  assert.throws(() => resolveInsideRepo(realRoot, 'build/Foo.cs'), PathEscapeError);
});

test('resolveInsideRepo accepts a symlinked intermediate directory that stays inside the repo root', () => {
  const realRoot = mkdtempSync(path.join(tmpdir(), 'scaffold-real-repo-'));
  const insideTarget = path.join(realRoot, 'actual-src');
  mkdirSync(insideTarget);
  symlinkSync(insideTarget, path.join(realRoot, 'src'), 'dir');

  const resolved = resolveInsideRepo(realRoot, 'src/Foo.cs');
  assert.equal(resolved, path.join(realRoot, 'src', 'Foo.cs'));
});
