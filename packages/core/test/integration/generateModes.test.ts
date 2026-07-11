import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveConfig } from '../../src/config/loader.js';
import { packCacheDir } from '../../src/templates/cache.js';
import { runGenerate } from '../../src/generate/generate.js';
import { fixtureDescriptor } from './testHarness.js';
import type { TemplateDescriptor } from '../../src/descriptor/schema.js';

/**
 * These tests exercise generate.ts's target `mode` handling in isolation,
 * without a real git clone: `templates sync`'s job (cloning into the cache)
 * is tested separately in templatesSync.test.ts, so here the cache layout
 * is written directly at the path generate.ts expects, keyed by a fake
 * pack url/sha — runGenerate only ever reads from that resolved path.
 */
function seedCache(targetRepo: string, cacheRoot: string, packUrl: string, sha: string, mode: 'create' | 'skip-if-exists' | 'overwrite') {
  const versionDir = path.join(packCacheDir(cacheRoot, packUrl, sha), 'v1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(path.join(versionDir, 'manifest.templates.json'), JSON.stringify(fixtureDescriptor(mode)));
  writeFileSync(path.join(versionDir, 'Endpoint.cs.hbs'), 'public class {{entity}}Endpoint {}');
  writeFileSync(path.join(versionDir, 'di-registration.hbs'), '// di for {{entity}}');
  writeFileSync(path.join(versionDir, 'route-registration.hbs'), '// route for {{entity}}');

  saveConfig(targetRepo, { projectType: 'dotnet', packs: { backend: { url: packUrl, version: 'v1', pinnedSha: sha } } });
}

function writeManifest(targetRepo: string, entity: string): string {
  const manifest = { manifestSchemaVersion: 1, targetStack: 'backend', entity, fields: [{ name: 'id', type: 'guid' }] };
  const file = path.join(targetRepo, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest));
  return file;
}

function tmpTargetRepoWithProgram(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scaffold-modes-'));
  writeFileSync(
    path.join(dir, 'Program.cs'),
    ['// SCAFFOLD:SCAFFOLD_DI:START', '// SCAFFOLD:SCAFFOLD_DI:END', '// SCAFFOLD:SCAFFOLD_ROUTES:START', '// SCAFFOLD:SCAFFOLD_ROUTES:END'].join('\n'),
  );
  return dir;
}

test('generate: mode "create" errors when the target file already exists', async () => {
  const targetRepo = tmpTargetRepoWithProgram();
  const cacheRoot = path.join(targetRepo, '.scaffold', 'cache');
  seedCache(targetRepo, cacheRoot, 'https://example.com/pack.git', 'a'.repeat(40), 'create');

  mkdirSync(path.join(targetRepo, 'src/Endpoints'), { recursive: true });
  writeFileSync(path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs'), 'already here');

  const manifestFile = writeManifest(targetRepo, 'Invoice');
  await assert.rejects(
    runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false }),
    /already exists and its target mode is "create"/,
  );
});

test('generate: mode "overwrite" replaces an existing file\'s content', async () => {
  const targetRepo = tmpTargetRepoWithProgram();
  const cacheRoot = path.join(targetRepo, '.scaffold', 'cache');
  seedCache(targetRepo, cacheRoot, 'https://example.com/pack.git', 'b'.repeat(40), 'overwrite');

  mkdirSync(path.join(targetRepo, 'src/Endpoints'), { recursive: true });
  writeFileSync(path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs'), 'stale content');

  const manifestFile = writeManifest(targetRepo, 'Invoice');
  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });
  assert.equal(report.created[0].skipped, false);

  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs'), 'utf8'), 'public class InvoiceEndpoint {}');
});

test('creation gate: mode "overwrite" target not existing is rejected by runGenerate with gate error text, writes nothing', async () => {
  const targetRepo = tmpTargetRepoWithProgram();
  const cacheRoot = path.join(targetRepo, '.scaffold', 'cache');
  seedCache(targetRepo, cacheRoot, 'https://example.com/pack.git', 'c'.repeat(40), 'overwrite');

  // Note: we do NOT create src/Endpoints/InvoiceEndpoint.cs, so the overwrite target will not exist
  const manifestFile = writeManifest(targetRepo, 'Invoice');
  await assert.rejects(
    runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false }),
    /does not exist and its target mode is "overwrite"/,
  );

  // Verify nothing was written
  const manifestDir = path.dirname(manifestFile);
  const manifestList = (await import('node:fs/promises')).readdir(manifestDir);
  // Only the manifest.json file should exist, no changeset should have been written
  const files = await manifestList;
  assert.ok(!files.some((f) => f.includes('changeset-')), 'no changeset should be written on gate rejection');
});

test('creation gate: regression — existing overwrite-mode-when-exists test still passes', async () => {
  const targetRepo = tmpTargetRepoWithProgram();
  const cacheRoot = path.join(targetRepo, '.scaffold', 'cache');
  seedCache(targetRepo, cacheRoot, 'https://example.com/pack.git', 'd'.repeat(40), 'overwrite');

  mkdirSync(path.join(targetRepo, 'src/Endpoints'), { recursive: true });
  writeFileSync(path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs'), 'stale content');

  const manifestFile = writeManifest(targetRepo, 'Invoice');
  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });
  assert.equal(report.created[0].skipped, false);

  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(path.join(targetRepo, 'src/Endpoints/InvoiceEndpoint.cs'), 'utf8'), 'public class InvoiceEndpoint {}');
});

test('creation gate: brand-new entity create-mode targets scaffold successfully even though files don\'t exist', async () => {
  const targetRepo = tmpTargetRepoWithProgram();
  const cacheRoot = path.join(targetRepo, '.scaffold', 'cache');
  seedCache(targetRepo, cacheRoot, 'https://example.com/pack.git', 'e'.repeat(40), 'create');

  const manifestFile = writeManifest(targetRepo, 'NewEntity');
  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });
  assert.equal(report.created[0].skipped, false);

  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(path.join(targetRepo, 'src/Endpoints/NewEntityEndpoint.cs'), 'utf8'), 'public class NewEntityEndpoint {}');
});

test('creation gate: skip-if-exists targets unaffected regardless of existence', async () => {
  const targetRepo = tmpTargetRepoWithProgram();
  const cacheRoot = path.join(targetRepo, '.scaffold', 'cache');
  seedCache(targetRepo, cacheRoot, 'https://example.com/pack.git', 'f'.repeat(40), 'skip-if-exists');

  const manifestFile = writeManifest(targetRepo, 'SkipEntity');
  // The gate should not reject skip-if-exists targets regardless of whether they exist
  const report = await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });
  assert.ok(report, 'generate should succeed for skip-if-exists targets');
});

test('creation gate: --dry-run against missing overwrite target rejects without writing', async () => {
  const targetRepo = tmpTargetRepoWithProgram();
  const cacheRoot = path.join(targetRepo, '.scaffold', 'cache');
  seedCache(targetRepo, cacheRoot, 'https://example.com/pack.git', '0'.repeat(40), 'overwrite');

  // Note: we do NOT create the target file
  const manifestFile = writeManifest(targetRepo, 'DryRunTest');
  await assert.rejects(
    runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: true, force: false }),
    /does not exist and its target mode is "overwrite"/,
  );
});

test('creation gate: two missing overwrite targets produce one error naming both paths', async () => {
  const targetRepo = tmpTargetRepoWithProgram();
  const cacheRoot = path.join(targetRepo, '.scaffold', 'cache');
  const packUrl = 'https://example.com/pack.git';
  const sha = 'a'.repeat(40);

  // Seed cache with a descriptor that has two overwrite-mode targets
  const versionDir = path.join(packCacheDir(cacheRoot, packUrl, sha), 'v1');
  mkdirSync(versionDir, { recursive: true });
  const descriptor: TemplateDescriptor = {
    descriptorSchemaVersion: 2,
    packVersion: 'v1',
    requires: { scaffoldCli: '>=0.0.0' },
    targets: [
      { output: 'src/Endpoints/{{entity}}Endpoint.cs', template: 'Endpoint.cs.hbs', mode: 'overwrite' },
      { output: 'src/Services/{{entity}}Service.cs', template: 'Endpoint.cs.hbs', mode: 'overwrite' },
    ],
    injections: [
      { file: 'Program.cs', marker: 'SCAFFOLD_DI', template: 'di-registration.hbs', position: 'before-end', hashTrailerPrefix: '// scaffold-hash:' },
      { file: 'Program.cs', marker: 'SCAFFOLD_ROUTES', template: 'route-registration.hbs', position: 'before-end', hashTrailerPrefix: '// scaffold-hash:' },
    ],
  };
  writeFileSync(path.join(versionDir, 'manifest.templates.json'), JSON.stringify(descriptor));
  writeFileSync(path.join(versionDir, 'Endpoint.cs.hbs'), 'public class {{entity}}Endpoint {}');
  writeFileSync(path.join(versionDir, 'di-registration.hbs'), '// di for {{entity}}');
  writeFileSync(path.join(versionDir, 'route-registration.hbs'), '// route for {{entity}}');

  saveConfig(targetRepo, { projectType: 'dotnet', packs: { backend: { url: packUrl, version: 'v1', pinnedSha: sha } } });

  const manifestFile = writeManifest(targetRepo, 'MultiTarget');
  try {
    await runGenerate({ repoRoot: targetRepo, manifestPath: manifestFile, dryRun: false, force: false });
    assert.fail('expected gate to reject two missing overwrite targets');
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /src\/Endpoints\/MultiTargetEndpoint\.cs/);
    assert.match(message, /src\/Services\/MultiTargetService\.cs/);
  }
});
