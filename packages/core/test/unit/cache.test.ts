import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackUrl, packCacheDir } from '../../src/templates/cache.js';

test('normalizePackUrl trims a trailing slash, a trailing .git, and case differences', () => {
  const a = normalizePackUrl('HTTPS://GitHub.com/org/pack.git/');
  const b = normalizePackUrl('https://github.com/org/pack');
  assert.equal(a, b);
});

test('packCacheDir never collides for two different pack URLs even if a resolvedSha happened to match, and always differs by URL hash', () => {
  const cacheRoot = '/tmp/scaffold-cache';
  const dirA = packCacheDir(cacheRoot, 'https://github.com/org/scaffold-templates-dotnet.git', 'deadbeef');
  const dirB = packCacheDir(cacheRoot, 'https://github.com/other-org/scaffold-templates-dotnet.git', 'deadbeef');
  assert.notEqual(dirA, dirB);
});

test('packCacheDir is stable for the same normalized URL and sha', () => {
  const cacheRoot = '/tmp/scaffold-cache';
  const dirA = packCacheDir(cacheRoot, 'https://github.com/org/pack.git', 'abc123');
  const dirB = packCacheDir(cacheRoot, 'https://github.com/org/pack', 'abc123');
  assert.equal(dirA, dirB);
});
