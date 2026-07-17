/**
 * Integration coverage for artifact-scoped generation (`manifest.artifacts`),
 * `when`-conditional targets/injections, and per-pack `defaults` — the M1
 * engine features behind the `scaffold add` command family. Uses a
 * path-based pack (read straight off disk, no sync) against an in-process
 * `runGenerate`, mirroring generate.test.ts's style.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGenerate, applyPackDefaults } from '../../src/generate/generate.js';
import { saveConfig } from '../../src/config/loader.js';
import type { IntentManifest } from '../../src/manifest/types.js';
import { PROGRAM_CS, buildFixtureTargetRepo } from './testHarness.js';

const SHARED_TEMPLATE = `namespace Fixture.Shared;\n\npublic class {{entity}}Shared { }\n`;
const CREATE_COMMAND_TEMPLATE = `namespace Fixture.Commands;\n\npublic class Create{{entity}}Command { }\n`;
const READ_QUERY_TEMPLATE = `namespace Fixture.Queries;\n\npublic class Get{{entity}}Query { }\n`;
const REPO_SPLIT_TEMPLATE = `namespace Fixture.Repositories;\n\npublic interface I{{entity}}Repository { }\n`;
const REPO_COMBINED_TEMPLATE = `namespace Fixture.Repositories;\n\npublic interface I{{entity}}Repository { }\n\npublic class {{entity}}Repository : I{{entity}}Repository { }\n`;
const DI_TEMPLATE = `        services.AddScoped<I{{entity}}Repository, {{entity}}Repository>();`;
const ROUTE_TEMPLATE = `        app.MapGet("/api/{{entity}}", () => Results.Ok());`;

/**
 * A path-based pack with tagged, when-gated entries:
 * - Shared.cs — untagged (base)
 * - CreateCommand — op-create
 * - ReadQuery — op-read
 * - split vs combined repository — op-create, gated on options.combine
 * - DI injection — op-create; ROUTES injection — untagged (base)
 */
function buildArtifactPackDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-artifact-pack-'));
  const versionDir = path.join(dir, 'v1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify(
      {
        descriptorSchemaVersion: 2,
        packVersion: 'v1',
        requires: { scaffoldCli: '>=0.0.0' },
        targets: [
          { output: 'src/Shared/{{entity}}Shared.cs', template: 'Shared.cs.hbs', mode: 'create' },
          { output: 'src/Commands/Create{{entity}}Command.cs', template: 'CreateCommand.cs.hbs', mode: 'create', artifact: 'op-create' },
          { output: 'src/Queries/Get{{entity}}Query.cs', template: 'ReadQuery.cs.hbs', mode: 'create', artifact: 'op-read' },
          {
            output: 'src/Repositories/I{{entity}}Repository.cs',
            template: 'RepoSplit.cs.hbs',
            mode: 'create',
            artifact: 'op-create',
            when: { 'options.combine': false },
          },
          {
            output: 'src/Repositories/{{entity}}Repository.cs',
            template: 'RepoCombined.cs.hbs',
            mode: 'create',
            artifact: 'op-create',
            when: { 'options.combine': true },
          },
        ],
        injections: [
          {
            file: 'Program.cs',
            marker: 'SCAFFOLD_DI',
            template: 'di-registration.hbs',
            position: 'before-end',
            hashTrailerPrefix: '// scaffold-hash:',
            strategy: 'append',
            artifact: 'op-create',
          },
          {
            file: 'Program.cs',
            marker: 'SCAFFOLD_ROUTES',
            template: 'route-registration.hbs',
            position: 'before-end',
            hashTrailerPrefix: '// scaffold-hash:',
            strategy: 'append',
          },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(versionDir, 'Shared.cs.hbs'), SHARED_TEMPLATE);
  writeFileSync(path.join(versionDir, 'CreateCommand.cs.hbs'), CREATE_COMMAND_TEMPLATE);
  writeFileSync(path.join(versionDir, 'ReadQuery.cs.hbs'), READ_QUERY_TEMPLATE);
  writeFileSync(path.join(versionDir, 'RepoSplit.cs.hbs'), REPO_SPLIT_TEMPLATE);
  writeFileSync(path.join(versionDir, 'RepoCombined.cs.hbs'), REPO_COMBINED_TEMPLATE);
  writeFileSync(path.join(versionDir, 'di-registration.hbs'), DI_TEMPLATE);
  writeFileSync(path.join(versionDir, 'route-registration.hbs'), ROUTE_TEMPLATE);
  return dir;
}

function setupTarget(packDir: string, defaults?: Record<string, unknown>): string {
  const targetRepo = buildFixtureTargetRepo();
  saveConfig(targetRepo, {
    projectType: 'dotnet',
    packs: { backend: { path: packDir, version: 'v1', ...(defaults ? { defaults } : {}) } },
  });
  return targetRepo;
}

function manifestFor(entity: string, extra: Partial<IntentManifest> = {}): IntentManifest {
  return {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    entity,
    fields: [{ name: 'id', type: 'guid' }],
    ...extra,
  };
}

test('generate without artifacts renders every entry except when-mismatches (legacy full render)', async () => {
  const packDir = buildArtifactPackDir();
  const targetRepo = setupTarget(packDir);

  const report = await runGenerate({ repoRoot: targetRepo, manifest: manifestFor('Invoice'), dryRun: false, force: false });

  assert.deepEqual(
    report.created.map((c) => c.file).sort(),
    [
      'src/Commands/CreateInvoiceCommand.cs',
      'src/Queries/GetInvoiceQuery.cs',
      'src/Repositories/IInvoiceRepository.cs', // split layout: combine unset ⇒ false
      'src/Shared/InvoiceShared.cs',
    ],
  );
  assert.equal(report.injected.length, 2);
  assert.equal(report.artifacts, undefined);
  assert.deepEqual(report.skippedEntries, { byArtifact: 0, byWhen: 1 });
});

test('generate with artifacts renders only tagged entries plus base, skipping the rest', async () => {
  const packDir = buildArtifactPackDir();
  const targetRepo = setupTarget(packDir);

  const report = await runGenerate({
    repoRoot: targetRepo,
    manifest: manifestFor('Invoice', { artifacts: ['base', 'op-read'] }),
    dryRun: false,
    force: false,
  });

  assert.deepEqual(
    report.created.map((c) => c.file).sort(),
    ['src/Queries/GetInvoiceQuery.cs', 'src/Shared/InvoiceShared.cs'],
  );
  // Only the untagged ROUTES injection runs; DI (op-create) is filtered out.
  assert.deepEqual(report.injected.map((i) => i.marker), ['SCAFFOLD_ROUTES']);
  assert.deepEqual(report.artifacts, ['base', 'op-read']);
  const program = readFileSync(path.join(targetRepo, 'Program.cs'), 'utf8');
  assert.doesNotMatch(program, /AddScoped/);
  assert.match(program, /MapGet/);
  // A filtered-out create-mode target was never rendered or written.
  assert.equal(existsSync(path.join(targetRepo, 'src/Commands/CreateInvoiceCommand.cs')), false);
});

test('when-gate picks the combined repository layout when options.combine is true', async () => {
  const packDir = buildArtifactPackDir();
  const targetRepo = setupTarget(packDir);

  const report = await runGenerate({
    repoRoot: targetRepo,
    manifest: manifestFor('Invoice', { artifacts: ['op-create'], options: { combine: true } }),
    dryRun: false,
    force: false,
  });

  assert.deepEqual(
    report.created.map((c) => c.file).sort(),
    ['src/Commands/CreateInvoiceCommand.cs', 'src/Repositories/InvoiceRepository.cs'],
  );
  const combined = readFileSync(path.join(targetRepo, 'src/Repositories/InvoiceRepository.cs'), 'utf8');
  assert.match(combined, /public interface IInvoiceRepository/);
  assert.match(combined, /public class InvoiceRepository : IInvoiceRepository/);
  assert.equal(existsSync(path.join(targetRepo, 'src/Repositories/IInvoiceRepository.cs')), false);
});

test('pack defaults satisfy options the manifest omits, and explicit manifest options win', async () => {
  const packDir = buildArtifactPackDir();
  const withCombineDefault = setupTarget(packDir, { options: { combine: true } });

  // Manifest says nothing about combine — the pack default (true) applies.
  await runGenerate({
    repoRoot: withCombineDefault,
    manifest: manifestFor('Invoice', { artifacts: ['op-create'] }),
    dryRun: false,
    force: false,
  });
  assert.ok(existsSync(path.join(withCombineDefault, 'src/Repositories/InvoiceRepository.cs')));

  // Manifest explicitly disables combine — it beats the pack default.
  const overridden = setupTarget(packDir, { options: { combine: true } });
  await runGenerate({
    repoRoot: overridden,
    manifest: manifestFor('Invoice', { artifacts: ['op-create'], options: { combine: false } }),
    dryRun: false,
    force: false,
  });
  assert.ok(existsSync(path.join(overridden, 'src/Repositories/IInvoiceRepository.cs')));
  assert.equal(existsSync(path.join(overridden, 'src/Repositories/InvoiceRepository.cs')), false);
});

test('applyPackDefaults: top-level manifest keys win; options merge one level deep', () => {
  const manifest: IntentManifest = {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    entity: 'Invoice',
    options: { combine: false },
  };
  const merged = applyPackDefaults(manifest, {
    entity: 'ShouldNotWin',
    options: { combine: true, database: { scope: 'Tenant' } },
  });
  assert.equal(merged.entity, 'Invoice');
  assert.deepEqual(merged.options, { combine: false, database: { scope: 'Tenant' } });
  // No defaults ⇒ identity.
  assert.equal(applyPackDefaults(manifest, undefined), manifest);
});

test('artifact-scoped generate is idempotent: append injections and a second entity accumulate cleanly', async () => {
  const packDir = buildArtifactPackDir();
  const targetRepo = setupTarget(packDir);

  const first = manifestFor('Invoice', { artifacts: ['base', 'op-create'] });
  await runGenerate({ repoRoot: targetRepo, manifest: first, dryRun: false, force: false });

  // A second entity appends its own snippets into the same (now non-empty)
  // markers — 'updated', not a refusal.
  const secondEntity = manifestFor('Order', { artifacts: ['base', 'op-create'] });
  const secondRun = await runGenerate({ repoRoot: targetRepo, manifest: secondEntity, dryRun: false, force: false });
  const program = readFileSync(path.join(targetRepo, 'Program.cs'), 'utf8');
  assert.match(program, /IInvoiceRepository/);
  assert.match(program, /IOrderRepository/);
  assert.equal(secondRun.injected.every((i) => i.action === 'updated'), true);

  // Both entities' snippets coexist inside one marker pair — no duplication.
  assert.equal((program.match(/SCAFFOLD:SCAFFOLD_DI:START/g) ?? []).length, 1);
  assert.equal((program.match(/AddScoped/g) ?? []).length, 2);
});

test('dry-run plan of an artifact-scoped run matches the real run byte-for-byte', async () => {
  const packDir = buildArtifactPackDir();
  const dryRepo = setupTarget(packDir);
  const realRepo = setupTarget(packDir);

  const manifest = manifestFor('Invoice', { artifacts: ['base', 'op-create'], options: { combine: true } });
  const dry = await runGenerate({ repoRoot: dryRepo, manifest, dryRun: true, force: false });
  const real = await runGenerate({ repoRoot: realRepo, manifest, dryRun: false, force: false });

  assert.deepEqual(dry.created, real.created);
  assert.deepEqual(dry.injected, real.injected);
  assert.deepEqual(dry.aiImplementation, real.aiImplementation);
  assert.deepEqual(dry.skippedEntries, real.skippedEntries);
  // Dry-run wrote nothing.
  assert.equal(existsSync(path.join(dryRepo, 'src/Shared/InvoiceShared.cs')), false);
});

test('runGenerate rejects both or neither of manifestPath and manifest', async () => {
  const packDir = buildArtifactPackDir();
  const targetRepo = setupTarget(packDir);
  await assert.rejects(
    () => runGenerate({ repoRoot: targetRepo, dryRun: false, force: false }),
    /exactly one of manifestPath or manifest/,
  );
  const manifestFile = path.join(targetRepo, 'x.manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifestFor('Invoice')));
  await assert.rejects(
    () =>
      runGenerate({
        repoRoot: targetRepo,
        manifestPath: manifestFile,
        manifest: manifestFor('Invoice'),
        dryRun: false,
        force: false,
      }),
    /exactly one of manifestPath or manifest/,
  );
});

// Regression guard: PROGRAM_CS from the shared harness is what these targets
// start from; if its marker names ever change, this test pins the coupling.
test('fixture Program.cs still carries both markers this suite injects into', () => {
  assert.match(PROGRAM_CS, /SCAFFOLD:SCAFFOLD_DI:START/);
  assert.match(PROGRAM_CS, /SCAFFOLD:SCAFFOLD_ROUTES:START/);
});
