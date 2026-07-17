/**
 * `scaffold check-edit`'s structural gate, exercised end to end against real
 * synced pack fixtures (mirrors generate.test.ts's fixture style) — the nine
 * scenarios from the plan's Test Plan section, one per test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { runGenerate } from '../../src/generate/generate.js';
import { checkEdit } from '../../src/checkEdit/checkEdit.js';
import { buildFixturePackRepo, buildFixtureTargetRepo, writeInitialConfig, writeManifestFile } from './testHarness.js';

test('checkEdit: no .scaffold/config.json in the repo — allow, zero pack ownership', () => {
  const targetRepo = buildFixtureTargetRepo();
  const result = checkEdit({ repoRoot: targetRepo, file: 'src/Endpoints/InvoiceEndpoint.cs', tool: 'write' });
  assert.equal(result.allow, true);
  assert.equal(result.reason, 'no-config');
  assert.equal(result.packOwned, false);
});

test('checkEdit: a write to an unrendered pack-owned target path is blocked before generate ever runs', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));

  const result = checkEdit({ repoRoot: targetRepo, file: 'src/Endpoints/InvoiceEndpoint.cs', tool: 'write' });
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'write-blocked');
  assert.equal(result.packOwned, true);
  assert.equal(result.packSlot, 'backend');
});

test('checkEdit: an edit whose old_string sits fully inside a real generated file\'s AI_IMPLEMENTATION interior is allowed', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  // Simulate a host agent's first fill of the block (same replace shape
  // status.test.ts/cli.test.ts use), landing real content strictly between
  // the START/END marker lines. check-edit's own old_string below then
  // targets a substring of *that* content, not the marker lines themselves —
  // this mirrors SKILL.md's documented old_string (the report's `content`
  // field, i.e. the raw interior, never the marker comments).
  const filled = readFileSync(endpointPath, 'utf8').replace(
    '// AI_IMPLEMENTATION_START\n\n        // AI_IMPLEMENTATION_END',
    '// AI_IMPLEMENTATION_START\n        Console.WriteLine("handled");\n        // AI_IMPLEMENTATION_END',
  );
  writeFileSync(endpointPath, filled);

  const result = checkEdit({
    repoRoot: targetRepo,
    file: 'src/Endpoints/InvoiceEndpoint.cs',
    tool: 'edit',
    oldString: 'Console.WriteLine("handled");',
  });
  assert.equal(result.allow, true);
  assert.equal(result.reason, 'edit-allowed-in-interior');
  assert.equal(result.packOwned, true);
});

test('checkEdit: an edit outside any AI_IMPLEMENTATION interior in the same pack-owned file is blocked', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const result = checkEdit({
    repoRoot: targetRepo,
    file: 'src/Endpoints/InvoiceEndpoint.cs',
    tool: 'edit',
    oldString: 'public class InvoiceEndpoint',
  });
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'edit-blocked-outside-interior');
  assert.equal(result.packOwned, true);
});

test('checkEdit: an edit landing inside a SCAFFOLD:<marker> injection region is blocked — injection regions are not open ground', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const programContent = readFileSync(path.join(targetRepo, 'Program.cs'), 'utf8');
  const diLine = programContent.split('\n').find((l) => l.includes('AddScoped<IInvoiceService'));
  assert.ok(diLine, 'expected the injected DI registration line to be present');

  const result = checkEdit({ repoRoot: targetRepo, file: 'Program.cs', tool: 'edit', oldString: diLine! });
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'edit-blocked-outside-interior');
  assert.equal(result.packOwned, true);
  assert.equal(result.packSlot, 'backend');
});

test('checkEdit: an unrelated file matching no pack target/injection pattern is allowed and never even read for AI_IMPLEMENTATION scanning', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  writeFileSync(path.join(targetRepo, 'README.md'), '# not scaffold-owned\n');

  const result = checkEdit({ repoRoot: targetRepo, file: 'README.md', tool: 'write' });
  assert.equal(result.allow, true);
  assert.equal(result.reason, 'not-pack-owned');
  assert.equal(result.packOwned, false);
});

test('checkEdit: a configured but never-synced pack fails open for its own slot rather than blocking or throwing', () => {
  const targetRepo = buildFixtureTargetRepo();
  // writeInitialConfig sets url+version but no pinnedSha — never synced, so
  // no descriptor is reachable in the cache for this slot.
  writeInitialConfig(targetRepo, 'https://example.com/never-synced-pack.git');

  const result = checkEdit({ repoRoot: targetRepo, file: 'src/Endpoints/InvoiceEndpoint.cs', tool: 'write' });
  assert.equal(result.allow, true);
  assert.equal(result.reason, 'not-pack-owned');
  assert.equal(result.packOwned, false);
});

test('checkEdit: old_string missing from the file is blocked with a distinct ambiguous reason, not conflated with outside-interior', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const result = checkEdit({
    repoRoot: targetRepo,
    file: 'src/Endpoints/InvoiceEndpoint.cs',
    tool: 'edit',
    oldString: 'this text does not appear anywhere in the file',
  });
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'edit-blocked-ambiguous-old-string');
});

test('checkEdit: old_string appearing more than once in the file is blocked as ambiguous, fail-closed rather than guessing', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  // Duplicate a line inside the file so it appears twice, then target it as old_string.
  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const original = readFileSync(endpointPath, 'utf8');
  writeFileSync(endpointPath, `${original}\n    // duplicate marker line\n    // duplicate marker line\n`);

  const result = checkEdit({
    repoRoot: targetRepo,
    file: 'src/Endpoints/InvoiceEndpoint.cs',
    tool: 'edit',
    oldString: '    // duplicate marker line',
  });
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'edit-blocked-ambiguous-old-string');
  assert.match(result.detail, /2 times/);
});

test('checkEdit: a path that resolves outside the repo root is allowed — not an error, just not this repo\'s concern', () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);

  const result = checkEdit({ repoRoot: targetRepo, file: '../outside-the-repo.cs', tool: 'write' });
  assert.equal(result.allow, true);
  assert.equal(result.reason, 'outside-repo');
  assert.equal(result.packOwned, false);
});

test('checkEdit: an edit to a pack-owned target path that has never been generated is blocked (nothing to scan for interiors yet)', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));

  const result = checkEdit({
    repoRoot: targetRepo,
    file: 'src/Endpoints/InvoiceEndpoint.cs',
    tool: 'edit',
    oldString: 'anything',
  });
  assert.equal(result.allow, false);
  assert.equal(result.packOwned, true);
});

// Not one of the plan's nine scenarios, but a cheap regression guard: the
// directory-creation path some hooks might exercise before a file exists.
test('checkEdit: never throws when the target file\'s parent directory does not exist yet', () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  mkdirSync(path.join(targetRepo, '.scaffold', 'cache'), { recursive: true });

  assert.doesNotThrow(() => checkEdit({ repoRoot: targetRepo, file: 'src/Endpoints/DoesNotExistYet/Nested.cs', tool: 'write' }));
});
