import { test } from 'node:test';
import assert from 'node:assert/strict';

test('sync module exports required functions', async () => {
  const { defaultCacheRoot, syncTemplates } = await import('../../src/templates/sync.js');
  assert.ok(typeof defaultCacheRoot === 'function', 'defaultCacheRoot should be exported');
  assert.ok(typeof syncTemplates === 'function', 'syncTemplates should be exported');
});

test('defaultCacheRoot constructs the correct path', async () => {
  const { defaultCacheRoot } = await import('../../src/templates/sync.js');
  const result = defaultCacheRoot('/home/user/project');
  assert.ok(result.includes('.scaffold/cache'), 'should contain .scaffold/cache');
  assert.ok(result.includes('/home/user/project'), 'should contain repo root');
});
