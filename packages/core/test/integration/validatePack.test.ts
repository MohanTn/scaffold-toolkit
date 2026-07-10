import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validatePack } from '../../src/validatePack/validatePack.js';
import { buildFixturePackRepo, writeManifestFile, buildFixtureTargetRepo } from './testHarness.js';

function writeManifest(dir: string): string {
  return writeManifestFile(dir, 'Invoice');
}

test('validate-pack: a coherent fixture pack passes, synthesizing the host-provided Program.cs and exercising both injections', async () => {
  const packRepo = buildFixturePackRepo('create');
  // The manifest just needs to live somewhere on disk; use a throwaway dir.
  const scratch = buildFixtureTargetRepo();
  const manifestPath = writeManifest(scratch);

  const results = await validatePack({ packDir: packRepo, version: 'v1', manifestPath });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, results[0].error);
  assert.equal(results[0].injectionsExercised, 2, 'both SCAFFOLD_DI and SCAFFOLD_ROUTES must land');
  assert.deepEqual(results[0].synthesizedFiles, ['Program.cs'], 'the host-provided Program.cs is synthesized, the created Endpoint is not');
});

test('validate-pack: a pack whose injection targets a file it neither creates nor can be synthesized still surfaces the failure through generate, not a crash', async () => {
  // Point an injection at a file with an extension the comment-syntax table
  // does not cover and no override — resolveMarkerSyntax throws, which
  // synthesizeInjectionTarget surfaces as an ok:false result rather than an
  // uncaught exception.
  const packRepo = mkdtempSync(path.join(tmpdir(), 'scaffold-bad-pack-'));
  execFileSync('git', ['init', '-q'], { cwd: packRepo });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: packRepo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: packRepo });
  const versionDir = path.join(packRepo, 'v1');
  execFileSync('mkdir', ['-p', versionDir]);
  writeFileSync(
    path.join(versionDir, 'manifest.templates.json'),
    JSON.stringify({
      descriptorSchemaVersion: 2,
      packVersion: 'v1',
      requires: { scaffoldCli: '>=0.0.0' },
      targets: [],
      injections: [{ file: 'config.unknownext', marker: 'THING', template: 'thing.hbs', position: 'before-end', hashTrailerPrefix: '# hash:' }],
    }),
  );
  writeFileSync(path.join(versionDir, 'thing.hbs'), 'value = 1');
  execFileSync('git', ['add', '-A'], { cwd: packRepo });
  execFileSync('git', ['commit', '-q', '-m', 'bad pack'], { cwd: packRepo });

  const scratch = buildFixtureTargetRepo();
  const manifestPath = writeManifest(scratch);

  const results = await validatePack({ packDir: packRepo, version: 'v1', manifestPath });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? '', /unknownext|comment syntax/i);
});

test('validate-pack: discovers every version folder when no version is given', async () => {
  const packRepo = buildFixturePackRepo('create', ['v2', 'v3']);
  const scratch = buildFixtureTargetRepo();
  const manifestPath = writeManifest(scratch);

  const results = await validatePack({ packDir: packRepo, manifestPath });
  const versions = results.map((r) => r.version).sort();
  assert.deepEqual(versions, ['v1', 'v2', 'v3']);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
});
