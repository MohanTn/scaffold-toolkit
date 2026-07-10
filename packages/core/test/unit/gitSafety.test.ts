import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isInsideGitWorkTree, isFileCleanAndTracked, isNotAGitRepositoryError } from '../../src/bootstrapMarkers/gitSafety.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function buildGitFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-gitsafety-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Scaffold Test']);
  writeFileSync(path.join(dir, 'Committed.cs'), 'committed content\n');
  writeFileSync(path.join(dir, 'Untracked.cs'), 'untracked content\n');
  git(dir, ['add', 'Committed.cs']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

test('isInsideGitWorkTree returns true for a real git repo', () => {
  const dir = buildGitFixture();
  assert.equal(isInsideGitWorkTree(dir), true);
});

test('isInsideGitWorkTree returns false, without throwing, for a non-git directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-nongit-'));
  assert.doesNotThrow(() => {
    assert.equal(isInsideGitWorkTree(dir), false);
  });
});

test('isFileCleanAndTracked returns true for a committed, untouched file', () => {
  const dir = buildGitFixture();
  assert.equal(isFileCleanAndTracked(dir, 'Committed.cs'), true);
});

test('isFileCleanAndTracked returns false for an untracked file', () => {
  const dir = buildGitFixture();
  assert.equal(isFileCleanAndTracked(dir, 'Untracked.cs'), false);
});

test('isFileCleanAndTracked returns false for a dirtied (tracked but modified) file', () => {
  const dir = buildGitFixture();
  writeFileSync(path.join(dir, 'Committed.cs'), 'modified content\n');
  assert.equal(isFileCleanAndTracked(dir, 'Committed.cs'), false);
});

test('isFileCleanAndTracked returns false for a file that does not exist at all', () => {
  const dir = buildGitFixture();
  assert.equal(isFileCleanAndTracked(dir, 'NoSuchFile.cs'), false);
});

// --- BUG 4 regression: "not a git repository" must not be conflated with any other execution failure ---

test('isNotAGitRepositoryError is true for a real "not a git repository" stderr, as git itself actually produces it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-nongit-classify-'));
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.fail('expected git rev-parse to fail outside a repository');
  } catch (error) {
    assert.equal(isNotAGitRepositoryError(error), true);
  }
});

test('isNotAGitRepositoryError is false when the git binary itself is missing (ENOENT) — that is a real failure, not "no repo here"', () => {
  const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  assert.equal(isNotAGitRepositoryError(enoent), false);
});

test('isNotAGitRepositoryError is false for an unrelated git failure (e.g. permission denied reading config)', () => {
  const unrelated = Object.assign(new Error('Command failed: git rev-parse --is-inside-work-tree'), {
    stderr: Buffer.from('fatal: unable to read config file: Permission denied\n'),
  });
  assert.equal(isNotAGitRepositoryError(unrelated), false);
});

test('isInsideGitWorkTree throws, rather than silently returning false, when git fails for a reason unrelated to "not a git repository"', () => {
  // A real (non-mocked) execution path: PATH is pointed at a fake "git" that
  // fails with unrelated stderr, so isInsideGitWorkTree's own execFileSync
  // call genuinely hits this failure mode rather than having it injected.
  const fakeBinDir = mkdtempSync(path.join(tmpdir(), 'scaffold-fakebin-'));
  const fakeGitPath = path.join(fakeBinDir, 'git');
  writeFileSync(fakeGitPath, '#!/bin/sh\necho "fatal: unable to read config file: Permission denied" >&2\nexit 128\n');
  chmodSync(fakeGitPath, 0o755);

  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-gitsafety-fail-'));
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;
  try {
    assert.throws(() => isInsideGitWorkTree(dir));
  } finally {
    process.env.PATH = originalPath;
  }
});
