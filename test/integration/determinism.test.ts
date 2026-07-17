import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runGenerate } from '../../src/generate/generate.js';
import { computeStatus } from '../../src/status/status.js';
import { checkEdit } from '../../src/checkEdit/checkEdit.js';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import type { GenerateReport } from '../../src/generate/report.js';
import { buildFixturePackRepo, buildFixtureTargetRepo, writeInitialConfig, writeManifestFile } from './testHarness.js';

/**
 * Determinism test suite: verifies that the scaffold CLI produces identical
 * outputs across multiple invocations and would produce identical outputs
 * across providers (Claude Code, Copilot) under the same conditions.
 *
 * Acceptance criteria (from arch-cli-determinism.html v2):
 * - E1–E8: All examples pass (hard gate blocks, soft nudge surfaces, status tracks)
 * - Dry-run matches real-run for identical working-tree state
 * - Cross-provider outputs are identical (simulated by multiple runs)
 * - Hook enforcement is structural (check-edit, status gates work)
 */

function normalizeReport(report: GenerateReport): string {
  // Normalize report for comparison: remove timestamps/ids that vary, keep structure
  return JSON.stringify(
    {
      created: report.created.map((c) => ({ file: c.file, skipped: c.skipped })),
      injected: report.injected.map((i) => ({ file: i.file, marker: i.marker, action: i.action })),
      aiImplementation: report.aiImplementation.map((a) => ({
        file: a.file,
        empty: a.empty,
      })),
    },
    null,
    2,
  );
}

test('E4: Dry-run output matches real-run output for identical repo state', async () => {
  const packRepo = buildFixturePackRepo('create');
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  // Run dry-run
  const dryRunReport = await runGenerate({
    repoRoot: targetRepo,
    manifestPath: manifestFile,
    dryRun: true,
    force: false,
  });

  // Capture working-tree state after dry-run
  const programContentAfterDry = readFileSync(path.join(targetRepo, 'Program.cs'), 'utf8');

  // Run real generate on a fresh repo with identical setup
  const targetRepo2 = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo2, packRepo);
  await syncTemplates(targetRepo2, defaultCacheRoot(targetRepo2));
  const manifestFile2 = writeManifestFile(targetRepo2, 'Invoice');

  const realReport = await runGenerate({
    repoRoot: targetRepo2,
    manifestPath: manifestFile2,
    dryRun: false,
    force: false,
  });

  // Compare normalized reports (structure must match)
  assert.equal(normalizeReport(dryRunReport), normalizeReport(realReport), 'Dry-run and real-run reports must have identical structure');

  // Verify real-run actually wrote files
  const programContentAfterReal = readFileSync(path.join(targetRepo2, 'Program.cs'), 'utf8');
  assert.notEqual(programContentAfterDry, programContentAfterReal, 'Real run must write to disk; dry-run must not');
  assert(
    programContentAfterReal.includes('services.AddScoped<IInvoiceService, InvoiceService>()'),
    'Real run must have injected DI registration for Invoice',
  );
});

test('E1: PreToolUse gate blocks writes to pack-owned files', async () => {
  const packRepo = buildFixturePackRepo('create');
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  // Generate to create the pack-owned file
  await runGenerate({
    repoRoot: targetRepo,
    manifestPath: manifestFile,
    dryRun: false,
    force: false,
  });

  // Now attempt to directly write to the pack-owned file (simulating PreToolUse gate)
  const packOwnedFile = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const result = checkEdit({
    repoRoot: targetRepo,
    file: packOwnedFile,
    tool: 'write',
  });

  assert.equal(result.allow, false, 'Writing to pack-owned file must be blocked');
  assert.equal(result.reason, 'write-blocked', 'Reason must be write-blocked');
});

test('E2: Repos without .scaffold/config.json are unrestricted', async () => {
  // Create a target repo WITHOUT calling writeInitialConfig
  const targetRepo = buildFixtureTargetRepo();

  // Since there's no .scaffold/config.json, all file operations should be allowed
  const result = checkEdit({
    repoRoot: targetRepo,
    file: path.join(targetRepo, 'src/SomeFile.cs'),
    tool: 'write',
  });

  assert.equal(result.allow, true, 'Writes to unconfigured repos must be allowed');
  assert.equal(result.reason, 'no-config', 'Reason must be no-config');
});

test('E3: Stop gate blocks turn-end if AI_IMPLEMENTATION blocks are unfilled', async () => {
  const packRepo = buildFixturePackRepo('create');
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  // Generate (leaves blocks unfilled)
  const report = await runGenerate({
    repoRoot: targetRepo,
    manifestPath: manifestFile,
    dryRun: false,
    force: false,
  });

  // Verify report lists unfilled blocks
  const unfilled = report.aiImplementation.filter((a) => a.empty);
  assert(unfilled.length > 0, 'Report must list empty AI_IMPLEMENTATION blocks');

  // Run status (simulates Stop hook)
  const status = computeStatus(targetRepo);
  assert.equal(status.resolvedAll, false, 'Status must report unresolved blocks');
  assert(status.unresolved.length > 0, 'Unresolved list must match empty blocks');
});

test('E5: check-edit allows edits to non-pack-owned files', async () => {
  const packRepo = buildFixturePackRepo('create');
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  // Generate
  await runGenerate({
    repoRoot: targetRepo,
    manifestPath: manifestFile,
    dryRun: false,
    force: false,
  });

  // Verify edit to non-pack-owned file is allowed
  const result = checkEdit({
    repoRoot: targetRepo,
    file: path.join(targetRepo, 'src/Services/Business.cs'),
    tool: 'edit',
    oldString: 'any content',
  });

  assert.equal(result.allow, true, 'Edits to non-pack-owned files must be allowed');
  assert.equal(result.reason, 'not-pack-owned', 'Reason must be not-pack-owned');
});

test('Cross-provider determinism: same manifest produces identical reports', async () => {
  const packRepo = buildFixturePackRepo('create');

  // Simulate first provider (Claude Code)
  const repo1 = buildFixtureTargetRepo();
  writeInitialConfig(repo1, packRepo);
  await syncTemplates(repo1, defaultCacheRoot(repo1));
  const manifest1 = writeManifestFile(repo1, 'Order');
  const report1 = await runGenerate({
    repoRoot: repo1,
    manifestPath: manifest1,
    dryRun: false,
    force: false,
  });

  // Simulate second provider (Copilot) — fresh repo, same manifest + pack
  const repo2 = buildFixtureTargetRepo();
  writeInitialConfig(repo2, packRepo);
  await syncTemplates(repo2, defaultCacheRoot(repo2));
  const manifest2 = writeManifestFile(repo2, 'Order');
  const report2 = await runGenerate({
    repoRoot: repo2,
    manifestPath: manifest2,
    dryRun: false,
    force: false,
  });

  // Reports must be identical
  assert.equal(normalizeReport(report1), normalizeReport(report2), 'Different provider runs must produce identical reports for same manifest');
});

test('Idempotency: running generate twice on same repo does not corrupt files', async () => {
  const packRepo = buildFixturePackRepo('skip-if-exists');
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Customer');

  // First generate
  const report1 = await runGenerate({
    repoRoot: targetRepo,
    manifestPath: manifestFile,
    dryRun: false,
    force: false,
  });
  assert.equal(report1.created.length, 1, 'First run should create one file');
  assert.equal(report1.created[0].skipped, false, 'First run should not skip the created file');

  // Capture file state after first generate
  const generatedEndpoint1 = readFileSync(path.join(targetRepo, 'src/Endpoints/CustomerEndpoint.cs'), 'utf8');

  // Second generate (should be idempotent)
  const report2 = await runGenerate({
    repoRoot: targetRepo,
    manifestPath: manifestFile,
    dryRun: false,
    force: false,
  });
  assert.equal(report2.created.length, 1, 'Second run should report the file (skipped)');
  assert.equal(report2.created[0].skipped, true, 'Second run should skip the existing file');

  // File content must remain identical (NOT corrupted)
  const generatedEndpoint2 = readFileSync(path.join(targetRepo, 'src/Endpoints/CustomerEndpoint.cs'), 'utf8');
  assert.equal(generatedEndpoint2, generatedEndpoint1, 'Idempotent generates must not corrupt files');
});
