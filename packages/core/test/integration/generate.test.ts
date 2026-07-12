import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { runGenerate } from '../../src/generate/generate.js';
import { buildFixturePackRepo, buildFixtureTargetRepo, fixtureDescriptor, writeInitialConfig, writeManifestFile, PROGRAM_CS } from './testHarness.js';
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

test('scaffold generate: a pack-local helpers.js is loaded and its helpers are usable in that pack\'s templates', async () => {
  const packRepo = buildFixturePackRepo();
  const targetRepo = buildFixtureTargetRepo();
  writeInitialConfig(targetRepo, packRepo);

  // Add a version whose templates depend on a helper this pack alone supplies
  // (`plural`) — the CLI has no built-in `plural`, so this only renders if
  // the pack's own helpers.js is actually loaded before the template compiles.
  const versionDirWithPackHelpers = path.join(packRepo, 'v-with-pack-helpers');
  mkdirSync(versionDirWithPackHelpers, { recursive: true });

  const descriptorWithPackHelpers = {
    descriptorSchemaVersion: 2,
    packVersion: 'v-with-pack-helpers',
    requires: { scaffoldCli: '>=0.0.0' },
    targets: [
      { output: 'src/{{entity}}Repository.cs', template: 'Repository.cs.hbs', mode: 'create' },
    ],
    injections: [],
  };

  const repositoryTemplate = `public class {{entity}}Repository {
  public DbSet<{{entity}}> {{plural entity}} { get; set; }
}`;

  const helpersJs = `module.exports = { register(handlebars) {
    handlebars.registerHelper('plural', function (s) {
      const str = String(s == null ? '' : s);
      if (/y$/i.test(str)) return str.slice(0, -1) + 'ies';
      return str + 's';
    });
  } };`;

  writeFileSync(path.join(versionDirWithPackHelpers, 'manifest.templates.json'), JSON.stringify(descriptorWithPackHelpers, null, 2));
  writeFileSync(path.join(versionDirWithPackHelpers, 'Repository.cs.hbs'), repositoryTemplate);
  writeFileSync(path.join(versionDirWithPackHelpers, 'helpers.js'), helpersJs);

  execFileSync('git', ['add', '-A'], { cwd: packRepo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'add v-with-pack-helpers'], { cwd: packRepo, stdio: 'pipe' });

  saveConfig(targetRepo, { projectType: 'dotnet', packs: { backend: { url: packRepo, version: 'v-with-pack-helpers' } } });
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));

  const manifest = {
    manifestSchemaVersion: 1,
    targetStack: 'backend',
    entity: 'Company',
    fields: [{ name: 'id', type: 'guid' }],
  };
  const manifestFile = path.join(targetRepo, 'Company.manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: true, force: false });

  assert.equal(report.created[0].file, 'src/CompanyRepository.cs');
});

/** A small throwaway path-based pack fixture (no git repo): one "v1" version folder with the same shape as buildFixturePackRepo's. */
function buildLocalPackDir(mode: 'create' | 'skip-if-exists' | 'overwrite' = 'create'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-local-pack-'));
  const versionDir = path.join(dir, 'v1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(path.join(versionDir, 'manifest.templates.json'), JSON.stringify(fixtureDescriptor(mode)));
  writeFileSync(
    path.join(versionDir, 'Endpoint.cs.hbs'),
    `namespace Fixture.Endpoints;\n\npublic class {{entity}}Endpoint\n{\n    public void Handle()\n    {\n        // AI_IMPLEMENTATION_START\n\n        // AI_IMPLEMENTATION_END\n    }\n}\n`,
  );
  writeFileSync(path.join(versionDir, 'di-registration.hbs'), `        services.AddScoped<I{{entity}}Service, {{entity}}Service>();`);
  writeFileSync(path.join(versionDir, 'route-registration.hbs'), `        app.MapGet("{{options.route}}", () => Results.Ok());`);
  return dir;
}

test('scaffold generate: a path-based pack fixture succeeds end to end and records resolvedSha "local" in provenance', async () => {
  const packDir = buildLocalPackDir();
  const targetRepo = buildFixtureTargetRepo();
  saveConfig(targetRepo, { projectType: 'dotnet', packs: { backend: { path: packDir, version: 'v1' } } });
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });

  assert.equal(report.created[0].file, 'src/Endpoints/InvoiceEndpoint.cs');
  assert.ok(existsSync(path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs')));

  const config = JSON.parse(readFileSync(path.join(targetRepo, '.scaffold', 'config.json'), 'utf8'));
  const provenanceEntry = config.provenance['Program.cs'];
  assert.equal(provenanceEntry.resolvedSha, 'local');
  assert.equal(provenanceEntry.packUrl, packDir);
});

test('scaffold generate: a path-based pack with a missing version folder throws a local-path-specific error, not the "run templates sync" message', async () => {
  const packDir = mkdtempSync(path.join(tmpdir(), 'scaffold-local-pack-empty-'));
  const targetRepo = buildFixtureTargetRepo();
  saveConfig(targetRepo, { projectType: 'dotnet', packs: { backend: { path: packDir, version: 'v1' } } });
  const manifestFile = writeManifestFile(targetRepo, 'Invoice');

  await assert.rejects(
    runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false }),
    /not found at .*check the pack directory and version folder/,
  );
});

// arch-brownfield-adoption.html E5: a pack slot's persisted pathConfig/
// companyProjectName (config/schema.ts's PackConfig) resolves a real output
// path without the manifest repeating either — a custom descriptor whose
// target actually references both placeholders, so the assertion proves the
// values flow all the way through to the written file location, not just
// that generate still succeeds with extra config fields present.
test('scaffold generate: a pack slot\'s persisted pathConfig/companyProjectName resolve the output path without the manifest supplying either', async () => {
  const packRepo = mkdtempSync(path.join(tmpdir(), 'scaffold-pathconfig-pack-'));
  execFileSync('git', ['init', '-q'], { cwd: packRepo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: packRepo });
  execFileSync('git', ['config', 'user.name', 'Scaffold Test'], { cwd: packRepo });
  const versionDir = path.join(packRepo, 'v1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify({
      descriptorSchemaVersion: 2,
      packVersion: 'v1',
      requires: { scaffoldCli: '>=0.0.0' },
      targets: [{ output: 'src/{{companyProjectName}}.Api/{{pathConfig.apiControllers}}/{{entity}}Controller.cs', template: 'Controller.cs.hbs', mode: 'create' }],
      injections: [],
    }),
  );
  writeFileSync(path.join(versionDir, 'Controller.cs.hbs'), 'public class {{entity}}Controller {}\n');
  execFileSync('git', ['add', '-A'], { cwd: packRepo });
  execFileSync('git', ['commit', '-q', '-m', 'pathconfig pack'], { cwd: packRepo });

  const targetRepo = buildFixtureTargetRepo();
  saveConfig(targetRepo, {
    projectType: 'dotnet',
    packs: { backend: { url: packRepo, version: 'v1', companyProjectName: 'Acme', pathConfig: { apiControllers: 'Services' } } },
  });
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestPath = path.join(targetRepo, 'Order.manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ manifestSchemaVersion: 1, targetStack: 'backend', entity: 'Order', fields: [{ name: 'id', type: 'guid' }] }));

  const report = await runGenerate({ repoRoot: targetRepo, manifestPath, dryRun: false, force: false });
  assert.equal(report.created[0].file, 'src/Acme.Api/Services/OrderController.cs');
  assert.ok(existsSync(path.join(targetRepo, 'src/Acme.Api/Services/OrderController.cs')));
});

test('scaffold generate: a manifest-supplied companyProjectName still overrides the pack slot\'s persisted default', async () => {
  const packRepo = mkdtempSync(path.join(tmpdir(), 'scaffold-pathconfig-pack-'));
  execFileSync('git', ['init', '-q'], { cwd: packRepo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: packRepo });
  execFileSync('git', ['config', 'user.name', 'Scaffold Test'], { cwd: packRepo });
  const versionDir = path.join(packRepo, 'v1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify({
      descriptorSchemaVersion: 2,
      packVersion: 'v1',
      requires: { scaffoldCli: '>=0.0.0' },
      targets: [{ output: '{{companyProjectName}}/{{entity}}Controller.cs', template: 'Controller.cs.hbs', mode: 'create' }],
      injections: [],
    }),
  );
  writeFileSync(path.join(versionDir, 'Controller.cs.hbs'), 'public class {{entity}}Controller {}\n');
  execFileSync('git', ['add', '-A'], { cwd: packRepo });
  execFileSync('git', ['commit', '-q', '-m', 'pathconfig pack'], { cwd: packRepo });

  const targetRepo = buildFixtureTargetRepo();
  saveConfig(targetRepo, { projectType: 'dotnet', packs: { backend: { url: packRepo, version: 'v1', companyProjectName: 'Persisted' } } });
  await syncTemplates(targetRepo, defaultCacheRoot(targetRepo));
  const manifestPath = path.join(targetRepo, 'Order.manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({ manifestSchemaVersion: 1, targetStack: 'backend', entity: 'Order', fields: [{ name: 'id', type: 'guid' }], companyProjectName: 'FromManifest' }),
  );

  const report = await runGenerate({ repoRoot: targetRepo, manifestPath, dryRun: false, force: false });
  assert.equal(report.created[0].file, 'FromManifest/OrderController.cs');
});
