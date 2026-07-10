import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveConfig } from '../../src/config/loader.js';
import { packCacheDir } from '../../src/templates/cache.js';
import { runGenerate } from '../../src/generate/generate.js';
import { fixtureDescriptor } from './testHarness.js';

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
