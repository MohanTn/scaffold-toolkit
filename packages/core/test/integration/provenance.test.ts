import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { runGenerate } from '../../src/generate/generate.js';
import { ProvenanceMismatchError } from '../../src/generate/provenance.js';
import { loadConfig, saveConfig } from '../../src/config/loader.js';
import { buildFixturePackRepo, buildFixtureTargetRepo, writeInitialConfig, writeManifestFile, advancePackRepo } from './testHarness.js';

test('scaffold generate: refuses to inject once the pack URL is repointed, even reusing the same version-folder name', async () => {
  const packRepoA = buildFixturePackRepo();
  const packRepoB = buildFixturePackRepo(); // a different repo (different path/url), but also has a "v1" folder
  const targetRepo = buildFixtureTargetRepo();
  const cacheRoot = defaultCacheRoot(targetRepo);

  writeInitialConfig(targetRepo, packRepoA);
  await syncTemplates(targetRepo, cacheRoot);
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  // Repoint the configured pack to a different repo, same version folder name ("v1").
  const config = loadConfig(targetRepo);
  config.packs.backend.url = packRepoB;
  delete config.packs.backend.pinnedSha;
  saveConfig(targetRepo, config);
  await syncTemplates(targetRepo, cacheRoot);

  await assert.rejects(
    runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: true }),
    ProvenanceMismatchError,
  );
});

test('scaffold generate: refuses to inject once the configured version folder changes, even at the same pack URL and pinned SHA', async () => {
  const packRepo = buildFixturePackRepo('skip-if-exists', ['v2']);
  const targetRepo = buildFixtureTargetRepo();
  const cacheRoot = defaultCacheRoot(targetRepo);

  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, cacheRoot);
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  // Same pack URL, same pinned SHA (both version folders were committed
  // together) — only the configured version folder itself changes. This is
  // the PRD's own named example: a file scaffolded under one version folder
  // must not be silently re-injected under another.
  const config = loadConfig(targetRepo);
  config.packs.backend.version = 'v2';
  saveConfig(targetRepo, config);

  await assert.rejects(
    runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: true }),
    ProvenanceMismatchError,
  );
});

test('scaffold generate: refuses to inject once the pinned SHA moves via --update, even for the same pack URL', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  const cacheRoot = defaultCacheRoot(targetRepo);

  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, cacheRoot);
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  advancePackRepo(packRepo);
  await syncTemplates(targetRepo, cacheRoot, { update: true });

  await assert.rejects(
    runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: true }),
    ProvenanceMismatchError,
  );
});
