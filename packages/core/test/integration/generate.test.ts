import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { runGenerate } from '../../src/generate/generate.js';
import { buildFixturePackRepo, buildFixtureTargetRepo, writeInitialConfig, writeManifestFile, PROGRAM_CS } from './testHarness.js';
import { saveConfig } from '../../src/config/loader.js';

test('scaffold generate: full end-to-end run creates a file, injects two independent markers, and reports an unfilled AI_IMPLEMENTATION block', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  // Created file.
  assert.equal(report.created.length, 1);
  assert.equal(report.created[0].file, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.equal(report.created[0].skipped, false);
  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.ok(existsSync(endpointPath));
  const endpointContent = readFileSync(endpointPath, 'utf8');
  assert.match(endpointContent, /public class InvoiceEndpoint/);
  assert.match(endpointContent, /AI_IMPLEMENTATION_START/);

  // Two independent markers injected into the same file.
  assert.equal(report.injected.length, 2);
  const byMarker = Object.fromEntries(report.injected.map((i) => [i.marker, i]));
  assert.equal(byMarker.SCAFFOLD_DI.action, 'created');
  assert.equal(byMarker.SCAFFOLD_ROUTES.action, 'created');

  const programContent = readFileSync(path.join(targetRepo, 'Program.cs'), 'utf8');
  assert.match(programContent, /services\.AddScoped<IInvoiceService, InvoiceService>\(\);/);
  assert.match(programContent, /app\.MapGet\("\/api\/invoices", \(\) => Results\.Ok\(\)\);/);
  // Per-marker hash trailers are scoped independently — two distinct hashes appear.
  const hashes = [...programContent.matchAll(/\/\/ scaffold-hash:([0-9a-f]{64})/g)].map((m) => m[1]);
  assert.equal(hashes.length, 2);
  assert.notEqual(hashes[0], hashes[1]);

  // AI_IMPLEMENTATION block reported and marked empty (nothing filled in yet).
  assert.equal(report.aiImplementation.length, 1);
  assert.equal(report.aiImplementation[0].file, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.equal(report.aiImplementation[0].empty, true);

  assert.ok(report.changesetId);
  assert.ok(existsSync(path.join(targetRepo, '.scaffold', 'changes', `${report.changesetId}.json`)));
  assert.ok(existsSync(path.join(targetRepo, '.scaffold', 'pending', `${report.changesetId}.json`)));
});

test('scaffold generate: dry-run does not touch disk but produces the same report as a real run', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  const dryReport = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: true, force: false });
  assert.equal(dryReport.dryRun, true);
  assert.equal(dryReport.changesetId, undefined);
  assert.equal(existsSync(path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs')), false);
  assert.equal(readFileSync(path.join(targetRepo, 'Program.cs'), 'utf8'), PROGRAM_CS);
  assert.equal(existsSync(path.join(targetRepo, '.scaffold', 'changes')), false);

  const realReport = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  assert.deepEqual(dryReport.created, realReport.created);
  assert.deepEqual(dryReport.injected, realReport.injected);
  assert.deepEqual(dryReport.aiImplementation, realReport.aiImplementation);
});

test('scaffold generate: running twice against the same fixture target is idempotent (byte-identical output)', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });
  const endpointPath = path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs');
  const programPath = path.join(targetRepo, 'Program.cs');
  const endpointAfterFirst = readFileSync(endpointPath, 'utf8');
  const programAfterFirst = readFileSync(programPath, 'utf8');

  const secondReport = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  assert.equal(readFileSync(endpointPath, 'utf8'), endpointAfterFirst);
  assert.equal(readFileSync(programPath, 'utf8'), programAfterFirst);
  assert.equal(secondReport.created[0].skipped, true);
  assert.ok(secondReport.injected.every((i) => i.action === 'unchanged'));
  // Nothing changed, so no new changeset was written.
  assert.equal(secondReport.changesetId, undefined);
});

test('scaffold generate: a manifest option named "entity" or "fields" cannot shadow the schema-validated top-level entity/fields', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));

  // `options` is intentionally free-form (additionalProperties: true) in the
  // manifest schema, so this passes schema validation even though `entity`
  // is unvalidated inside it — the render context must still use the real,
  // PascalCase-validated top-level `entity`, not this one.
  const manifest = {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    entity: 'Invoice',
    fields: [{ name: 'id', type: 'guid' }],
    options: { entity: 'not-a-valid-entity-name', route: '/api/invoices' },
  };
  const manifestFile = path.join(targetRepo, 'Invoice.manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  assert.equal(report.created[0].file, 'src/Endpoints/InvoiceEndpoint.cs');
  const endpointContent = readFileSync(path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs'), 'utf8');
  assert.match(endpointContent, /public class InvoiceEndpoint/);
  const programContent = readFileSync(path.join(targetRepo, 'Program.cs'), 'utf8');
  assert.match(programContent, /IInvoiceService, InvoiceService/);
});

test('scaffold generate: Handlebars case conversion helpers (camel, pascal, snake, kebab) work in templates', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);

  // Add a version with templates using case conversion helpers.
  const versionDirWithHelpers = path.join(packRepo, 'v-with-helpers');
  mkdirSync(versionDirWithHelpers, { recursive: true });

  const descriptorWithHelpers = {
    descriptorSchemaVersion: 2,
    packVersion: 'v-with-helpers',
    requires: { scaffoldCli: '>=0.0.0' },
    targets: [
      { output: 'src/{{entity}}.cs', template: 'Entity.cs.hbs', mode: 'create' },
    ],
    injections: [],
  };

  const templateWithHelpers = `
public class {{entity}} {
  private {{camel entity}} instance;
  public {{pascal (camel entity)}} GetInstance() {
    return {{snake entity}}_instance;
  }
}`;

  writeFileSync(path.join(versionDirWithHelpers, 'manifest.templates.json'), JSON.stringify(descriptorWithHelpers, null, 2));
  writeFileSync(path.join(versionDirWithHelpers, 'Entity.cs.hbs'), templateWithHelpers);

  execFileSync('git', ['add', '-A'], { cwd: packRepo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'add v-with-helpers'], { cwd: packRepo, stdio: 'pipe' });

  // Update config to use the new version.
  saveConfig(targetRepo, { projectType: 'dotnet', packs: { backend: { url: packRepo, version: 'v-with-helpers' } } });
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));

  const manifest = {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    entity: 'InvoiceEndpoint',
    fields: [{ name: 'id', type: 'guid' }],
    options: { route: '/api/invoices' },
  };

  const manifestFile = path.join(targetRepo, 'Invoice.manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  assert.equal(report.created[0].file, 'src/InvoiceEndpoint.cs');
  const content = readFileSync(path.join(targetRepo, 'src/InvoiceEndpoint.cs'), 'utf8');
  assert.match(content, /public class InvoiceEndpoint/);
  assert.match(content, /private invoiceEndpoint instance/);
  assert.match(content, /public InvoiceEndpoint GetInstance/);
  assert.match(content, /invoice_endpoint_instance/);
});
