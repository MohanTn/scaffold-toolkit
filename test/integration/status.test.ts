import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { runGenerate } from '../../src/generate/generate.js';
import { computeStatus } from '../../src/status/status.js';
import { buildFixturePackRepo, buildFixtureTargetRepo, buildRequiredBlockFixturePackRepo, writeInitialConfig, writeManifestFile } from './testHarness.js';

test('scaffold status: exits non-zero and lists an unfilled AI_IMPLEMENTATION block; filling it makes status resolve', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const before = computeStatus(targetRepo);
  assert.equal(before.resolvedAll, false);
  assert.equal(before.unresolved.length, 1);
  assert.equal(before.unresolved[0].file, 'src/Endpoints/InvoiceEndpoint.cs');

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const filled = readFileSync(endpointPath, 'utf8').replace(
    '// AI_IMPLEMENTATION_START\n\n        // AI_IMPLEMENTATION_END',
    '// AI_IMPLEMENTATION_START\n        Console.WriteLine("handled");\n        // AI_IMPLEMENTATION_END',
  );
  assert.notEqual(filled, readFileSync(endpointPath, 'utf8'), 'the replace above must actually have matched something');
  writeFileSync(endpointPath, filled);

  const after = computeStatus(targetRepo);
  assert.equal(after.resolvedAll, true);
  assert.equal(after.unresolved.length, 0);
});

test('scaffold status: a :required block that ships a compilable (non-empty) default is still tracked until the host agent changes it', async () => {
  const packRepo = buildRequiredBlockFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  // The block is non-empty (ships `var result = _service.Get();`), so the
  // empty-only rule would have exited 0 here — the :required tag is what keeps
  // it unresolved.
  const before = computeStatus(targetRepo);
  assert.equal(before.resolvedAll, false, 'a required non-empty block must be tracked, not pass silently');
  assert.equal(before.unresolved[0].file, 'src/Endpoints/InvoiceEndpoint.cs');

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const filled = readFileSync(endpointPath, 'utf8').replace('var result = _service.Get();', 'var result = _service.GetWithBusinessRules();');
  assert.notEqual(filled, readFileSync(endpointPath, 'utf8'), 'the replace must have matched');
  writeFileSync(endpointPath, filled);

  const after = computeStatus(targetRepo);
  assert.equal(after.resolvedAll, true, 'editing the required block resolves it');
});
