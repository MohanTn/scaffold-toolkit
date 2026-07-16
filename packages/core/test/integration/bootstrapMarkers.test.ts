import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBootstrapMarkers } from '../../src/bootstrapMarkers/bootstrapMarkers.js';
import { saveConfig, loadConfig } from '../../src/config/loader.js';
import { syncTemplates, defaultCacheRoot } from '../../src/templates/sync.js';
import { runGenerate } from '../../src/generate/generate.js';
import { checkEdit } from '../../src/checkEdit/checkEdit.js';
import {
  buildFixtureTargetRepo,
  buildGitFixtureTargetRepo,
  buildRealMarkerFixturePackRepo,
  BROWNFIELD_APP_DB_CONTEXT_CS,
  AMBIGUOUS_APP_DB_CONTEXT_CS,
  BROWNFIELD_APPLICATION_SERVICE_COLLECTION_EXTENSIONS_CS,
  UNCATALOGED_PACK_VERSION,
  writeManifestFile,
} from './testHarness.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function findMarker<T extends { marker: string }>(entries: T[], marker: string): T | undefined {
  return entries.find((e) => e.marker === marker);
}

function markerLineIndex(content: string, marker: string): number {
  return content.split('\n').findIndex((l) => l.trim() === `// SCAFFOLD:${marker}:START`);
}

test('bootstrap-markers: fresh placement of the full v10-minimal-api-gcp builder-zone and app-zone groups into a brownfield Program.cs, in order', () => {
  const repo = buildFixtureTargetRepo(false);
  const report = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api-gcp', dryRun: false });

  for (const marker of ['GSM', 'DI', 'PUBSUB', 'SAGAS', 'MIDDLEWARE', 'ROUTES']) {
    const entry = findMarker(report.placed, marker);
    assert.ok(entry, `expected ${marker} to be placed`);
    assert.equal(entry!.file, 'Program.cs');
    assert.equal(entry!.packSlot, '(--pack-version override)');
  }

  const content = readFileSync(path.join(repo, 'Program.cs'), 'utf8');
  const gsm = markerLineIndex(content, 'GSM');
  const di = markerLineIndex(content, 'DI');
  const pubsub = markerLineIndex(content, 'PUBSUB');
  const sagas = markerLineIndex(content, 'SAGAS');
  const middleware = markerLineIndex(content, 'MIDDLEWARE');
  const routes = markerLineIndex(content, 'ROUTES');
  assert.ok(gsm >= 0 && gsm < di && di < pubsub && pubsub < sagas && sagas < middleware && middleware < routes);

  // No AppDbContext.cs / ApplicationServiceCollectionExtensions.cs in this repo — DBSETS/REPOSITORIES are honestly needs-manual, not silently dropped.
  assert.ok(findMarker(report.needsManual, 'DBSETS'));
  assert.ok(findMarker(report.needsManual, 'REPOSITORIES'));
});

test('bootstrap-markers: DBSETS and REPOSITORIES placement into their brownfield fixtures via the after-class-brace anchor', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'scaffold-classbrace-'));
  mkdirSync(path.join(repo, 'src', 'Infrastructure', 'Persistence'), { recursive: true });
  mkdirSync(path.join(repo, 'src', 'Application'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'Infrastructure', 'Persistence', 'AppDbContext.cs'), BROWNFIELD_APP_DB_CONTEXT_CS);
  writeFileSync(path.join(repo, 'src', 'Application', 'ApplicationServiceCollectionExtensions.cs'), BROWNFIELD_APPLICATION_SERVICE_COLLECTION_EXTENSIONS_CS);

  const report = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v8-controller', dryRun: false });

  const dbsets = findMarker(report.placed, 'DBSETS');
  assert.ok(dbsets);
  assert.equal(dbsets!.file, path.join('src', 'Infrastructure', 'Persistence', 'AppDbContext.cs'));
  const repositories = findMarker(report.placed, 'REPOSITORIES');
  assert.ok(repositories);
  assert.equal(repositories!.file, path.join('src', 'Application', 'ApplicationServiceCollectionExtensions.cs'));

  const dbContextContent = readFileSync(path.join(repo, 'src', 'Infrastructure', 'Persistence', 'AppDbContext.cs'), 'utf8');
  assert.match(dbContextContent, /\/\/ SCAFFOLD:DBSETS:START\n\s*\/\/ SCAFFOLD:DBSETS:END/);
});

test('bootstrap-markers: DBSETS falls back to needs-manual on an ambiguous AppDbContext.cs fixture, content unchanged', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'scaffold-classbrace-ambiguous-'));
  mkdirSync(path.join(repo, 'src', 'Infrastructure', 'Persistence'), { recursive: true });
  const target = path.join(repo, 'src', 'Infrastructure', 'Persistence', 'AppDbContext.cs');
  writeFileSync(target, AMBIGUOUS_APP_DB_CONTEXT_CS);

  const report = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v8-controller', dryRun: false });

  const dbsets = findMarker(report.needsManual, 'DBSETS');
  assert.ok(dbsets);
  assert.match(dbsets!.reason, /expected exactly one/);
  assert.equal(readFileSync(target, 'utf8'), AMBIGUOUS_APP_DB_CONTEXT_CS);
});

test('bootstrap-markers + generate compatibility: a real scaffold generate run injects into bootstrap-placed DI and ROUTES markers unmodified', async () => {
  const repo = buildFixtureTargetRepo(false);
  const bootstrapReport = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api-gcp', dryRun: false });
  assert.ok(findMarker(bootstrapReport.placed, 'DI'));
  assert.ok(findMarker(bootstrapReport.placed, 'ROUTES'));

  const packRepo = buildRealMarkerFixturePackRepo();
  saveConfig(repo, { projectType: 'dotnet', packs: { backend: { url: packRepo, version: 'v10-minimal-api-gcp' } } });
  await syncTemplates(repo, defaultCacheRoot(repo));
  const manifestFile = writeManifestFile(repo, 'Invoice');

  const generateReport = await runGenerate({ repoRoot: repo, manifestPath: manifestFile, dryRun: false, force: false });
  const diInjection = generateReport.injected.find((i) => i.marker === 'DI');
  const routesInjection = generateReport.injected.find((i) => i.marker === 'ROUTES');
  assert.ok(diInjection, 'generate must have found the bootstrap-placed DI marker');
  assert.equal(diInjection!.action, 'created');
  assert.ok(routesInjection, 'generate must have found the bootstrap-placed ROUTES marker');
  assert.equal(routesInjection!.action, 'created');

  const finalContent = readFileSync(path.join(repo, 'Program.cs'), 'utf8');
  assert.match(finalContent, /services\.AddApplication\(\);/);
  assert.match(finalContent, /app\.MapInvoiceEndpoints\(\);/);
});

test('bootstrap-markers is idempotent: a second run reports everything already-present and leaves the file byte-identical', () => {
  const repo = buildFixtureTargetRepo(false);
  runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api-gcp', dryRun: false });
  const afterFirst = readFileSync(path.join(repo, 'Program.cs'), 'utf8');

  const secondReport = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api-gcp', dryRun: false });
  for (const marker of ['GSM', 'DI', 'PUBSUB', 'SAGAS', 'MIDDLEWARE', 'ROUTES']) {
    assert.ok(findMarker(secondReport.alreadyPresent, marker), `expected ${marker} to be already-present on the second run`);
  }
  assert.equal(secondReport.placed.length, 0);

  const afterSecond = readFileSync(path.join(repo, 'Program.cs'), 'utf8');
  assert.equal(afterSecond, afterFirst);
});

test('bootstrap-markers respects a hand-moved marker: relocating it then rerunning does not duplicate it and preserves the hand-edit exactly', () => {
  const repo = buildFixtureTargetRepo(false);
  runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api-gcp', dryRun: false });

  const programCsPath = path.join(repo, 'Program.cs');
  const original = readFileSync(programCsPath, 'utf8');
  const lines = original.split('\n');
  const diStart = lines.findIndex((l) => l.trim() === '// SCAFFOLD:DI:START');
  const diEnd = lines.findIndex((l) => l.trim() === '// SCAFFOLD:DI:END');
  const diBlock = lines.slice(diStart, diEnd + 1);
  const withoutDi = [...lines.slice(0, diStart), ...lines.slice(diEnd + 1)];
  // Hand-move the DI block down to just before the final closing brace.
  const closingBraceIdx = withoutDi.map((l) => l.trim()).lastIndexOf('}');
  const relocated = [...withoutDi.slice(0, closingBraceIdx), '    // hand-moved', ...diBlock, ...withoutDi.slice(closingBraceIdx)].join('\n');
  writeFileSync(programCsPath, relocated);

  const report = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api-gcp', dryRun: false });
  assert.ok(findMarker(report.alreadyPresent, 'DI'));

  const after = readFileSync(programCsPath, 'utf8');
  const diStarts = after.split('\n').filter((l) => l.trim() === '// SCAFFOLD:DI:START');
  assert.equal(diStarts.length, 1, 'DI must not be duplicated');
  assert.match(after, /\/\/ hand-moved\n\s*\/\/ SCAFFOLD:DI:START/);
});

test('bootstrap-markers produces an unsupportedPacks-only, no-crash report for a pack version not in the catalog — never needsManual, since there is nothing actionable for the user to fix', () => {
  const repo = buildFixtureTargetRepo(false);
  const report = runBootstrapMarkers({ repoRoot: repo, packVersion: UNCATALOGED_PACK_VERSION, dryRun: false });
  assert.equal(report.placed.length, 0);
  assert.equal(report.alreadyPresent.length, 0);
  assert.equal(report.needsManual.length, 0);
  assert.equal(report.unsupportedPacks.length, 1);
  assert.equal(report.unsupportedPacks[0].version, UNCATALOGED_PACK_VERSION);
  assert.equal(report.unsupportedPacks[0].packSlot, '(--pack-version override)');
  assert.match(report.unsupportedPacks[0].reason, /has no bootstrap-markers anchor catalog entry/);
});

test('bootstrap-markers: multiple configured pack slots produce per-slot packSlot-tagged results, only the dotnet slot yielding placements; the uncataloged slot is reported under unsupportedPacks, not needsManual', () => {
  const repo = buildFixtureTargetRepo(false);
  const dotnetPackRepo = buildRealMarkerFixturePackRepo();
  saveConfig(repo, {
    projectType: 'dotnet+react',
    packs: {
      backend: { url: dotnetPackRepo, version: 'v10-minimal-api-gcp' },
      frontend: { url: 'https://example.com/scaffold-templates-react.git', version: UNCATALOGED_PACK_VERSION },
    },
  });

  const report = runBootstrapMarkers({ repoRoot: repo, dryRun: false });

  const backendPlacements = report.placed.filter((p) => p.packSlot === 'backend');
  assert.ok(backendPlacements.length > 0, 'the backend (dotnet) slot should yield placements');

  const frontendNeedsManual = report.needsManual.filter((e) => e.packSlot === 'frontend');
  assert.equal(frontendNeedsManual.length, 0, 'an uncataloged pack version must never appear under needsManual');

  const frontendUnsupported = report.unsupportedPacks.filter((e) => e.packSlot === 'frontend');
  assert.equal(frontendUnsupported.length, 1);
  assert.equal(frontendUnsupported[0].version, UNCATALOGED_PACK_VERSION);
  assert.match(frontendUnsupported[0].reason, /has no bootstrap-markers anchor catalog entry/);
});

test('bootstrap-markers refuses on a dirty or untracked file inside a git repo, and succeeds once it is committed', () => {
  const repo = buildGitFixtureTargetRepo();
  const programCsPath = path.join(repo, 'Program.cs');

  // Dirty: modify the already-tracked file without committing.
  writeFileSync(programCsPath, `${readFileSync(programCsPath, 'utf8')}// a manual edit\n`);
  const dirtyReport = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api-gcp', dryRun: false });
  const dirtyDi = findMarker(dirtyReport.needsManual, 'DI');
  assert.ok(dirtyDi);
  assert.match(dirtyDi!.reason, /not tracked-and-clean/);
  assert.equal(dirtyReport.placed.length, 0);

  // Commit the change so the file is tracked-and-clean again, then bootstrap succeeds.
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'manual edit']);
  const cleanReport = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api-gcp', dryRun: false });
  assert.ok(findMarker(cleanReport.placed, 'DI'));
});

test('bootstrap-markers refuses on an untracked file inside a git repo', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'scaffold-git-untracked-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Scaffold Test']);
  writeFileSync(path.join(repo, 'README.md'), 'placeholder so the repo has a first commit\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  // Untracked new file with a real, placeable anchor: the git gate only
  // guards *writes*, so the file must be one bootstrap would otherwise
  // modify for the refusal (rather than an anchor error) to be what's
  // asserted here.
  writeFileSync(path.join(repo, 'Program.cs'), 'var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\napp.Run();\n');

  const report = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api-gcp', dryRun: false });
  const di = findMarker(report.needsManual, 'DI');
  assert.ok(di);
  assert.match(di!.reason, /not tracked-and-clean/);
});

test('bootstrap-markers succeeds with no git-safety check outside a git repo', () => {
  const repo = buildFixtureTargetRepo(false); // a plain directory, not itself a git repo
  const report = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api-gcp', dryRun: false });
  assert.ok(findMarker(report.placed, 'DI'));
});

test('bootstrap-markers --dry-run leaves disk unchanged while still reporting the would-be placement', () => {
  const repo = buildFixtureTargetRepo(false);
  const before = readFileSync(path.join(repo, 'Program.cs'), 'utf8');

  const report = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api-gcp', dryRun: true });
  assert.ok(findMarker(report.placed, 'DI'));
  assert.equal(report.dryRun, true);

  const after = readFileSync(path.join(repo, 'Program.cs'), 'utf8');
  assert.equal(after, before);
});

test('bootstrap-markers --pack-version override works with no .scaffold/config.json present at all', () => {
  const repo = buildFixtureTargetRepo(false);
  const report = runBootstrapMarkers({ repoRoot: repo, packVersion: 'v10-minimal-api', dryRun: false });
  assert.ok(findMarker(report.placed, 'DI'));
  const middleware = findMarker(report.placed, 'MIDDLEWARE');
  assert.ok(middleware);
});

test('bootstrap-markers: a configured slot backed by a path-based pack has its descriptor-declared bootstrapAnchors consulted, same as the --pack <dir> override path', () => {
  const repo = buildFixtureTargetRepo(false); // brownfield Program.cs, no markers
  const packDir = mkdtempSync(path.join(tmpdir(), 'scaffold-local-anchor-pack-'));
  const versionDir = path.join(packDir, 'v1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify({
      descriptorSchemaVersion: 2,
      packVersion: 'v1',
      requires: { scaffoldCli: '>=0.0.0' },
      targets: [],
      injections: [],
      bootstrapAnchors: [
        { candidateFilenames: ['Program.cs'], anchor: { kind: 'after-line', pattern: '\\.CreateBuilder\\s*\\(' }, markers: ['CUSTOM_SLOT'] },
      ],
    }),
  );

  saveConfig(repo, { projectType: 'dotnet', packs: { backend: { path: packDir, version: 'v1' } } });

  const report = runBootstrapMarkers({ repoRoot: repo, dryRun: false });
  const custom = findMarker(report.placed, 'CUSTOM_SLOT');
  assert.ok(custom, 'expected CUSTOM_SLOT to be placed via the configured path-based pack descriptor');
  assert.equal(custom!.file, 'Program.cs');
  assert.equal(custom!.packSlot, 'backend');
});

test('bootstrap-markers: a decoy file inside a path-based pack\'s own directory is never treated as the real candidate', () => {
  const repo = buildFixtureTargetRepo(false); // brownfield Program.cs, no markers
  const packDir = mkdtempSync(path.join(tmpdir(), 'scaffold-local-anchor-pack-'));
  const versionDir = path.join(packDir, 'v1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify({
      descriptorSchemaVersion: 2,
      packVersion: 'v1',
      requires: { scaffoldCli: '>=0.0.0' },
      targets: [],
      injections: [],
      bootstrapAnchors: [
        { candidateFilenames: ['Program.cs'], anchor: { kind: 'after-line', pattern: '\\.CreateBuilder\\s*\\(' }, markers: ['CUSTOM_SLOT'] },
      ],
    }),
  );
  // A harness copy inside the pack's own vendored directory, same basename
  // the anchor group looks for, already carrying the marker pair — this
  // must never be mistaken for the real host file.
  mkdirSync(path.join(packDir, 'tools', 'harness'), { recursive: true });
  writeFileSync(
    path.join(packDir, 'tools', 'harness', 'Program.cs'),
    '// SCAFFOLD:CUSTOM_SLOT:START\n// SCAFFOLD:CUSTOM_SLOT:END\n',
  );

  saveConfig(repo, { projectType: 'dotnet', packs: { backend: { path: packDir, version: 'v1' } } });

  const report = runBootstrapMarkers({ repoRoot: repo, dryRun: false });
  assert.equal(findMarker(report.alreadyPresent, 'CUSTOM_SLOT'), undefined, 'must not treat the harness decoy as already carrying the marker');
  const custom = findMarker(report.placed, 'CUSTOM_SLOT');
  assert.ok(custom, 'expected CUSTOM_SLOT to be placed into the real host Program.cs, not skipped because of the harness decoy');
  assert.equal(custom!.file, 'Program.cs');
});

// The tests below exercise arch-brownfield-adoption.html's approved
// acceptance examples (E1, E3, E4, E6) end to end through the real
// runBootstrapMarkers entry point, not just descriptorMapper.ts in
// isolation.

function pathBasedAdoptionPackDir(): string {
  const packDir = mkdtempSync(path.join(tmpdir(), 'scaffold-adoption-pack-'));
  const versionDir = path.join(packDir, 'v1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify({
      descriptorSchemaVersion: 2,
      packVersion: 'v1',
      requires: { scaffoldCli: '>=0.0.0' },
      targets: [{ output: 'src/{{pathConfig.dir}}/{{entity}}Controller.cs', template: 'Controller.cs.hbs', mode: 'create' }],
      injections: [{ file: 'Program.cs', marker: 'DI', template: 'di.hbs', position: 'before-end', hashTrailerPrefix: '// scaffold-hash:' }],
      bootstrapAnchors: [{ candidateFilenames: ['Program.cs'], anchor: { kind: 'after-line', pattern: '\\.CreateBuilder\\s*\\(' }, markers: ['DI'] }],
    }),
  );
  return packDir;
}

test('bootstrap-markers (E1): a target file whose path already matches the descriptor is mapped (ownership only, no content mutated) and check-edit gates it like a generated file', () => {
  const repo = buildFixtureTargetRepo(false); // brownfield Program.cs, no markers
  mkdirSync(path.join(repo, 'src', 'Controllers'), { recursive: true });
  const controllerPath = path.join(repo, 'src', 'Controllers', 'OrderController.cs');
  const handwrittenController = 'namespace Fixture;\n\npublic class OrderController\n{\n    public void Get() {}\n}\n';
  writeFileSync(controllerPath, handwrittenController);

  const packDir = pathBasedAdoptionPackDir();
  saveConfig(repo, { projectType: 'dotnet', packs: { backend: { path: packDir, version: 'v1' } } });

  const report = runBootstrapMarkers({ repoRoot: repo, dryRun: false });

  // Injection-kind: mapped AND marker-placed (existing anchor machinery, untouched).
  const injectionMapped = report.mapped.find((m) => m.kind === 'injection');
  assert.ok(injectionMapped);
  assert.equal(injectionMapped!.file, 'Program.cs');
  assert.ok(findMarker(report.placed, 'DI'));

  // Target-kind: mapped (ownership registered) but never marker-placed — a
  // deliberate scope decision (see descriptorMapper.ts's header comment):
  // adoption never speculatively inserts AI_IMPLEMENTATION blocks into
  // hand-written business logic it didn't generate.
  const targetMapped = report.mapped.find((m) => m.kind === 'target');
  assert.ok(targetMapped);
  assert.equal(targetMapped!.file, 'src/Controllers/OrderController.cs');
  assert.equal(targetMapped!.entity, 'Order');
  assert.equal(readFileSync(controllerPath, 'utf8'), handwrittenController, 'the hand-written file must be byte-identical — mapping never mutates content');

  // Persisted into .scaffold/config.json.
  const config = loadConfig(repo);
  const adoptedPaths = config.packs.backend.adoptedPaths;
  assert.equal(adoptedPaths?.['injection:Program.cs'], 'Program.cs');
  assert.equal(adoptedPaths?.['target:src/{{pathConfig.dir}}/{{entity}}Controller.cs::Order'], 'src/Controllers/OrderController.cs');

  // check-edit now gates the adopted target file exactly like a generated one.
  const writeResult = checkEdit({ repoRoot: repo, file: 'src/Controllers/OrderController.cs', tool: 'write' });
  assert.equal(writeResult.allow, false);
  assert.equal(writeResult.reason, 'write-blocked');
  assert.equal(writeResult.packOwned, true);
  assert.equal(writeResult.packSlot, 'backend');

  // No AI_IMPLEMENTATION interior exists yet (never inserted), so every edit is blocked too — refuse, not guess.
  const editResult = checkEdit({ repoRoot: repo, file: 'src/Controllers/OrderController.cs', tool: 'edit', oldString: 'public void Get() {}' });
  assert.equal(editResult.allow, false);
  assert.equal(editResult.reason, 'edit-blocked-outside-interior');
});

test('bootstrap-markers: a manually-declared capabilityFlags entry is surfaced on its already-mapped target, read verbatim from config.json, never inferred', () => {
  const repo = buildFixtureTargetRepo(false); // brownfield Program.cs, no markers
  mkdirSync(path.join(repo, 'src', 'Controllers'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'Controllers', 'OrderController.cs'), 'namespace Fixture;\n\npublic class OrderController\n{\n}\n');

  const packDir = pathBasedAdoptionPackDir();
  const targetKey = 'target:src/{{pathConfig.dir}}/{{entity}}Controller.cs::Order';
  saveConfig(repo, {
    projectType: 'dotnet',
    packs: { backend: { path: packDir, version: 'v1', capabilityFlags: { [targetKey]: 'CRUD' } } },
  });

  const report = runBootstrapMarkers({ repoRoot: repo, dryRun: false });

  const orderMapped = report.mapped.find((m) => m.kind === 'target' && m.entity === 'Order');
  assert.ok(orderMapped);
  assert.equal(orderMapped!.capability, 'CRUD');

  // Entries with no configured flag stay untouched — no inference, no default.
  const injectionMapped = report.mapped.find((m) => m.kind === 'injection');
  assert.equal(injectionMapped!.capability, undefined);
});

test('bootstrap-markers: a capabilityFlags entry for a target that lands in mappingNeedsManual never promotes it into mapped', () => {
  const repo = buildFixtureTargetRepo(false);
  mkdirSync(path.join(repo, 'src', 'Controllers'), { recursive: true });
  mkdirSync(path.join(repo, 'src', 'Legacy'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'Controllers', 'CustomerController.cs'), 'x');
  writeFileSync(path.join(repo, 'src', 'Legacy', 'CustomerController.cs'), 'x'); // duplicate — ambiguous, forces mappingNeedsManual

  const packDir = pathBasedAdoptionPackDir();
  const targetKey = 'target:src/{{pathConfig.dir}}/{{entity}}Controller.cs::Customer';
  saveConfig(repo, {
    projectType: 'dotnet',
    packs: { backend: { path: packDir, version: 'v1', capabilityFlags: { [targetKey]: 'CRUD' } } },
  });

  const report = runBootstrapMarkers({ repoRoot: repo, dryRun: false });

  assert.equal(report.mapped.find((m) => m.kind === 'target' && m.entity === 'Customer'), undefined, 'an ambiguous target must not be silently promoted into mapped just because a capability flag is configured for it');
  const customerNeedsManual = report.mappingNeedsManual.find((m) => m.kind === 'target' && m.entity === 'Customer');
  assert.ok(customerNeedsManual, 'it must still land in mappingNeedsManual, unaffected by the configured flag');
});

test('bootstrap-markers (E3): an entity matched by two files is left unmapped under mappingNeedsManual, while an unambiguous entity in the same run still maps', () => {
  const repo = buildFixtureTargetRepo(false);
  mkdirSync(path.join(repo, 'src', 'Controllers'), { recursive: true });
  mkdirSync(path.join(repo, 'src', 'Legacy'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'Controllers', 'OrderController.cs'), 'x');
  writeFileSync(path.join(repo, 'src', 'Controllers', 'CustomerController.cs'), 'x');
  writeFileSync(path.join(repo, 'src', 'Legacy', 'CustomerController.cs'), 'x'); // duplicate CustomerController — ambiguous

  const packDir = pathBasedAdoptionPackDir();
  saveConfig(repo, { projectType: 'dotnet', packs: { backend: { path: packDir, version: 'v1' } } });

  const report = runBootstrapMarkers({ repoRoot: repo, dryRun: false });

  const orderMapped = report.mapped.find((m) => m.kind === 'target' && m.entity === 'Order');
  assert.ok(orderMapped, 'the unambiguous entity must still map in the same run');

  const customerNeedsManual = report.mappingNeedsManual.find((m) => m.kind === 'target' && m.entity === 'Customer');
  assert.ok(customerNeedsManual, 'the ambiguous entity must be reported, not guessed');
  assert.match(customerNeedsManual!.reason, /expected exactly one/);

  const config = loadConfig(repo);
  assert.equal(config.packs.backend.adoptedPaths?.['target:src/{{pathConfig.dir}}/{{entity}}Controller.cs::Order'], 'src/Controllers/OrderController.cs');
  assert.equal(config.packs.backend.adoptedPaths?.['target:src/{{pathConfig.dir}}/{{entity}}Controller.cs::Customer'], undefined, 'an ambiguous entity must never be persisted');
});

test('bootstrap-markers (E4): a dirty target file is excluded from mapping and never persisted, matching bootstrap-markers\' existing git-safety net', () => {
  const repo = buildGitFixtureTargetRepo(); // committed brownfield Program.cs
  mkdirSync(path.join(repo, 'src', 'Controllers'), { recursive: true });
  const controllerPath = path.join(repo, 'src', 'Controllers', 'OrderController.cs');
  writeFileSync(controllerPath, 'x');
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'add controller'], { cwd: repo, stdio: 'pipe' });
  // Dirty edit, never committed.
  writeFileSync(controllerPath, 'x // dirty edit');

  const packDir = pathBasedAdoptionPackDir();
  saveConfig(repo, { projectType: 'dotnet', packs: { backend: { path: packDir, version: 'v1' } } });

  const report = runBootstrapMarkers({ repoRoot: repo, dryRun: false });

  assert.equal(report.mapped.find((m) => m.kind === 'target'), undefined, 'a dirty candidate must never be confidently mapped');
  const config = loadConfig(repo);
  assert.equal(
    Object.keys(config.packs.backend.adoptedPaths ?? {}).some((k) => k.startsWith('target:')),
    false,
    'the dirty target must never be persisted',
  );
  // The clean, committed Program.cs injection is a *different* file — unaffected by the target's dirtiness — so it still maps and gets its marker placed.
  assert.equal(config.packs.backend.adoptedPaths?.['injection:Program.cs'], 'Program.cs');
  assert.ok(findMarker(report.placed, 'DI'));
});

test('bootstrap-markers (E6): a configured pack slot that has never been synced surfaces an explicit warning rather than silently skipping ownership mapping', () => {
  const repo = buildFixtureTargetRepo(false);
  // url-based, no pinnedSha — never synced, mirrors checkEdit's "fails open" fixture but for the mapping phase, which must not stay silent.
  saveConfig(repo, { projectType: 'dotnet', packs: { backend: { url: 'https://example.com/never-synced-pack.git', version: UNCATALOGED_PACK_VERSION } } });

  const report = runBootstrapMarkers({ repoRoot: repo, dryRun: false });

  assert.equal(report.mapped.length, 0);
  const warning = report.warnings.find((w) => w.packSlot === 'backend');
  assert.ok(warning, 'an unsynced configured pack slot must surface an explicit warning, not silence');
  assert.match(warning!.message, /no synced pack descriptor available/);
});

test('bootstrap-markers: --dry-run computes mappings and reports them but never writes .scaffold/config.json', () => {
  const repo = buildFixtureTargetRepo(false);
  mkdirSync(path.join(repo, 'src', 'Controllers'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'Controllers', 'OrderController.cs'), 'x');

  const packDir = pathBasedAdoptionPackDir();
  saveConfig(repo, { projectType: 'dotnet', packs: { backend: { path: packDir, version: 'v1' } } });

  const report = runBootstrapMarkers({ repoRoot: repo, dryRun: true });
  assert.ok(report.mapped.find((m) => m.kind === 'target' && m.entity === 'Order'));

  const config = loadConfig(repo);
  assert.equal(config.packs.backend.adoptedPaths, undefined, 'dry-run must never persist a mapping to disk');
});
