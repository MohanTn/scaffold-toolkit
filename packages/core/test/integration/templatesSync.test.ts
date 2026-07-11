import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { listTemplateVersions } from '../../src/templates/list.js';
import { loadConfig, saveConfig } from '../../src/config/loader.js';
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

/** A small throwaway path-based pack fixture: two version folders, each with a manifest.templates.json. */
function buildLocalPackDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-local-pack-'));
  for (const version of ['v1', 'v2']) {
    const versionDir = path.join(dir, version);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(path.join(versionDir, 'manifest.templates.json'), JSON.stringify({ descriptorSchemaVersion: 2, packVersion: version, requires: { scaffoldCli: '>=0.0.0' }, targets: [], injections: [] }));
  }
  return dir;
}

test('scaffold templates sync: a path-based pack is a no-op — resolvedSha "local", changed false, no pinnedSha ever written', async () => {
  const packDir = buildLocalPackDir();
  const targetRepo = buildFixtureTargetRepo();
  saveConfig(targetRepo, { projectType: 'dotnet', packs: { backend: { path: packDir, version: 'v1' } } });
  const cacheRoot = defaultCacheRoot(targetRepo);

  const results = await syncTemplates(targetRepo, cacheRoot);
  assert.equal(results.length, 1);
  assert.equal(results[0].resolvedSha, 'local');
  assert.equal(results[0].changed, false);

  const config = loadConfig(targetRepo);
  assert.equal(config.packs.backend.pinnedSha, undefined);
});

test('scaffold templates list: a path-based pack resolves relative to repoRoot (not process.cwd()) and lists both version folders', () => {
  const packDir = buildLocalPackDir();
  const targetRepo = buildFixtureTargetRepo();
  const relativePackPath = path.relative(targetRepo, packDir);
  saveConfig(targetRepo, { projectType: 'dotnet', packs: { backend: { path: relativePackPath, version: 'v1' } } });

  const listings = listTemplateVersions(targetRepo, defaultCacheRoot(targetRepo));
  assert.equal(listings.length, 1);
  assert.equal(listings[0].pack, 'backend');
  assert.deepEqual(listings[0].versions.sort(), ['v1', 'v2']);
});

test('scaffold templates list: a path-based pack pointing at a missing directory returns an empty versions list rather than throwing', () => {
  const targetRepo = buildFixtureTargetRepo();
  saveConfig(targetRepo, { projectType: 'dotnet', packs: { backend: { path: 'does-not-exist', version: 'v1' } } });

  const listings = listTemplateVersions(targetRepo, defaultCacheRoot(targetRepo));
  assert.equal(listings.length, 1);
  assert.deepEqual(listings[0].versions, []);
});
