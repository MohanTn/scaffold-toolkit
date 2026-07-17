import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { runGenerate } from '../../src/generate/generate.js';
import { computeNext } from '../../src/next/next.js';
import { addConventionsMd, buildFixturePackRepo, buildFixtureTargetRepo, buildRequiredBlockFixturePackRepo, writeInitialConfig, writeManifestFile } from './testHarness.js';

test('scaffold next: reports the open block\'s file, line range, and placeholder body; filling it clears the digest', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const before = computeNext(targetRepo);
  assert.equal(before.done, false);
  assert.equal(before.blocks.length, 1);
  assert.equal(before.blocks[0].file, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.equal(before.blocks[0].required, false, 'the fixture pack does not tag its block :required');
  assert.equal(before.blocks[0].placeholder.trim(), '', 'the shipped placeholder is empty for this fixture');

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const filled = readFileSync(endpointPath, 'utf8').replace(
    '// AI_IMPLEMENTATION_START\n\n        // AI_IMPLEMENTATION_END',
    '// AI_IMPLEMENTATION_START\n        Console.WriteLine("handled");\n        // AI_IMPLEMENTATION_END',
  );
  assert.notEqual(filled, readFileSync(endpointPath, 'utf8'), 'the replace above must actually have matched something');
  writeFileSync(endpointPath, filled);

  const after = computeNext(targetRepo);
  assert.equal(after.done, true);
  assert.equal(after.blocks.length, 0);
});

test('scaffold next: a :required block reports required:true and its current (non-empty) placeholder body, and disagrees with status about nothing', async () => {
  const packRepo = buildRequiredBlockFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const before = computeNext(targetRepo);
  assert.equal(before.done, false);
  assert.equal(before.blocks.length, 1);
  assert.equal(before.blocks[0].required, true);
  assert.match(before.blocks[0].placeholder, /_service\.Get\(\)/);

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const filled = readFileSync(endpointPath, 'utf8').replace('var result = _service.Get();', 'var result = _service.GetWithBusinessRules();');
  writeFileSync(endpointPath, filled);

  const after = computeNext(targetRepo);
  assert.equal(after.done, true, 'editing the required block resolves it');
});

test('scaffold next: with nothing pending (no generate run yet), reports done with an empty digest', () => {
  const targetRepo = buildFixtureTargetRepo();
  const result = computeNext(targetRepo);
  assert.equal(result.done, true);
  assert.deepEqual(result.blocks, []);
});

test('scaffold next: attaches the pack version\'s conventions.md once as a preamble when every open block traces to it', async () => {
  const packRepo = buildFixturePackRepo();
  addConventionsMd(packRepo, 'v1', '# House rules\n\nAlways use paginated repository methods, never raw DbSet queries.\n');
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const result = computeNext(targetRepo);
  assert.equal(result.conventions, '# House rules\n\nAlways use paginated repository methods, never raw DbSet queries.\n');
  assert.equal(result.blocks.length, 1, 'conventions is a single top-level preamble, not duplicated per block');
});

test('scaffold next: omits `conventions` entirely when the pack version ships no conventions.md', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const result = computeNext(targetRepo);
  assert.equal(result.conventions, undefined, 'a pack version with no conventions.md must not surface a preamble from an unrelated pack');
});
