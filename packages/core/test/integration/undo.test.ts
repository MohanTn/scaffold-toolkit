import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { runGenerate } from '../../src/generate/generate.js';
import { undoChangeset, UndoBlockedError, UndoHashMismatchError } from '../../src/undo/undo.js';
import { buildFixturePackRepo, buildFixtureTargetRepo, writeInitialConfig, writeManifestFile, PROGRAM_CS } from './testHarness.js';

async function setup() {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  return { packRepo, targetRepo };
}

test('scaffold undo: reverts a generate run to the exact prior state, deleting the created file', async () => {
  const { targetRepo } = await setup();
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.ok(existsSync(endpointPath));

  undoChangeset(targetRepo, report.changesetId!, false);

  assert.equal(existsSync(endpointPath), false, 'created file must be deleted, not left with stale content');
  assert.equal(readFileSync(path.join(targetRepo, 'Program.cs'), 'utf8'), PROGRAM_CS);
});

test('scaffold undo: refuses when the file was hand-edited since generate (hash mismatch), unless --force', async () => {
  const { targetRepo } = await setup();
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');
  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  const programPath = path.join(targetRepo, 'Program.cs');
  const generatedProgram = readFileSync(programPath, 'utf8');
  writeFileSync(programPath, `${generatedProgram}\n// a human added this line by hand\n`);

  assert.throws(() => undoChangeset(targetRepo, report.changesetId!, false), UndoHashMismatchError);

  // --force discards the hand edit and restores the exact prior state.
  undoChangeset(targetRepo, report.changesetId!, true);
  assert.equal(readFileSync(programPath, 'utf8'), PROGRAM_CS);
});

test('scaffold undo: refuses to undo an earlier changeset once a later changeset touched the same file, naming it', async () => {
  const { targetRepo } = await setup();

  const invoiceManifest = writeManifestFile(targetRepo, 'Invoice');
  const changesetA = await runGenerate({ repoRoot: targetRepo, manifestPath: invoiceManifest, dryRun: false, force: false });

  // Customer's DI/route registrations render different content than Invoice's,
  // so injecting into the already-populated Program.cs markers needs --force
  // (the interior is no longer empty — this simulates two features scaffolded
  // into the same DI block across two separate runs).
  const customerManifest = writeManifestFile(targetRepo, 'Customer');
  const changesetB = await runGenerate({ repoRoot: targetRepo, manifestPath: customerManifest, dryRun: false, force: true });

  assert.throws(() => undoChangeset(targetRepo, changesetA.changesetId!, false), (err: unknown) => {
    assert.ok(err instanceof UndoBlockedError);
    assert.match(err.message, new RegExp(changesetB.changesetId!));
    assert.match(err.message, /Program\.cs/);
    return true;
  });
});
