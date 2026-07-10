import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { listTemplateVersions } from '../../src/templates/list.js';
import { loadConfig } from '../../src/config/loader.js';
import { packCacheDir } from '../../src/templates/cache.js';
import { buildFixturePackRepo, buildFixtureTargetRepo, writeInitialConfig, advancePackRepo } from './testHarness.js';

test('scaffold templates sync: clones the pack into the cache and pins the resolved SHA into config', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  const cacheRoot = defaultCacheRoot(targetRepo);

  const results = await syncTemplates(targetRepo, cacheRoot);
  assert.equal(results.length, 1);
  assert.equal(results[0].pack, 'backend');
  assert.match(results[0].resolvedSha, /^[0-9a-f]{40}$/);

  const config = loadConfig(targetRepo);
  assert.equal(config.packs.backend.pinnedSha, results[0].resolvedSha);

  const cacheDir = packCacheDir(cacheRoot, packRepo, results[0].resolvedSha);
  assert.ok(existsSync(`${cacheDir}/v1/manifest.templates.json`));
});

test('scaffold templates sync without --update reuses the pinned SHA (no-op even if the remote moved)', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  const cacheRoot = defaultCacheRoot(targetRepo);

  const first = await syncTemplates(targetRepo, cacheRoot);
  advancePackRepo(packRepo);
  const second = await syncTemplates(targetRepo, cacheRoot);

  assert.equal(second[0].resolvedSha, first[0].resolvedSha);
  assert.equal(second[0].changed, false);
});

test('scaffold templates sync --update moves the pinned SHA forward', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  const cacheRoot = defaultCacheRoot(targetRepo);

  const first = await syncTemplates(targetRepo, cacheRoot);
  advancePackRepo(packRepo);
  const second = await syncTemplates(targetRepo, cacheRoot, { update: true });

  assert.notEqual(second[0].resolvedSha, first[0].resolvedSha);
  assert.equal(second[0].changed, true);
});

test('scaffold templates list: lists the "v1" version folder for the configured pack', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  const cacheRoot = defaultCacheRoot(targetRepo);
  await syncTemplates(targetRepo, cacheRoot);

  const listings = listTemplateVersions(targetRepo, cacheRoot);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].pack, 'backend');
  assert.deepEqual(listings[0].versions, ['v1']);
});
